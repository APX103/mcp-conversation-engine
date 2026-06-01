import OpenAI from "openai";
import type { McpManager } from "../mcp.js";
import type { DbManager } from "../db.js";
import type { Config, ResearchStreamEvent } from "../types.js";
import type { ResearchStatus } from "./types.js";
import { ResearchDB } from "./db.js";
import { saveReportHtml } from "./report.js";
import type { ResearchPlan, SectionFinding, PipelineContext, SearchResult, PageContent } from "./types.js";
import {
  decomposeQuery,
  searchQueries,
  readPages,
  compressFindings,
  analyzeGaps,
  generateReport,
} from "./pipeline.js";

const DEFAULT_CONFIG = {
  maxSearchRounds: 3,
  maxPagesPerRound: 10,
  maxTokensPerFinding: 2000,
  timeout: 900000,
};

interface ResolvedConfig {
  enabled: boolean;
  maxSearchRounds: number;
  maxPagesPerRound: number;
  maxTokensPerFinding: number;
  timeout: number;
}

export class DeepResearchEngine {
  private openai: OpenAI;
  private model: string;
  private mcp: McpManager;
  private db?: DbManager;
  private config: ResolvedConfig;

  constructor(
    config_full: { llm: { baseUrl: string; apiKey: string; model: string }; deepResearch?: Config["deepResearch"] },
    mcp: McpManager,
    db?: DbManager
  ) {
    this.openai = new OpenAI({
      baseURL: config_full.llm.baseUrl,
      apiKey: config_full.llm.apiKey,
    });
    this.model = config_full.llm.model;
    this.mcp = mcp;
    this.db = db;
    this.config = {
      enabled: config_full.deepResearch?.enabled ?? true,
      maxSearchRounds: config_full.deepResearch?.maxSearchRounds ?? DEFAULT_CONFIG.maxSearchRounds,
      maxPagesPerRound: config_full.deepResearch?.maxPagesPerRound ?? DEFAULT_CONFIG.maxPagesPerRound,
      maxTokensPerFinding: config_full.deepResearch?.maxTokensPerFinding ?? DEFAULT_CONFIG.maxTokensPerFinding,
      timeout: config_full.deepResearch?.timeout ?? DEFAULT_CONFIG.timeout,
    };
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  private getPipelineContext(): PipelineContext {
    return {
      openai: this.openai,
      model: this.model,
      mcp: this.mcp,
      config: {
        maxSearchRounds: this.config.maxSearchRounds,
        maxPagesPerRound: this.config.maxPagesPerRound,
        maxTokensPerFinding: this.config.maxTokensPerFinding,
      },
    };
  }

  async *run(
    query: string,
    sessionId?: string
  ): AsyncGenerator<ResearchStreamEvent> {
    const ctx = this.getPipelineContext();
    const researchDb = this.db ? new ResearchDB(this.db) : null;

    let taskId = "";
    if (researchDb) {
      taskId = await researchDb.createTask({
        sessionId,
        query,
        status: "pending",
        findings: [],
        currentRound: 0,
      });
    }

    const updateStatus = async (status: ResearchStatus) => {
      if (researchDb && taskId) {
        await researchDb.updateTaskStatus(taskId, status).catch(() => {});
      }
    };

    const emit = (event: ResearchStreamEvent) => event;

    try {
      // Phase 1: Query Decomposition
      yield emit({ type: "phase_changed", phase: "decomposing", detail: "正在分析研究主题..." });
      await updateStatus("decomposing");

      let plan: ResearchPlan;
      try {
        plan = await decomposeQuery(ctx, query);
      } catch (err: any) {
        plan = await decomposeQuery(ctx, query);
      }

      if (researchDb && taskId) {
        await researchDb.updateTaskPlan(taskId, plan).catch(() => {});
      }

      yield emit({ type: "research_started", taskId, title: plan.title });

      const allFindings: SectionFinding[] = [];
      let currentRound = 0;
      let additionalQueries: string[] = [];

      // Search loop
      while (currentRound < this.config.maxSearchRounds) {
        currentRound++;
        if (researchDb && taskId) {
          await researchDb.incrementRound(taskId).catch(() => {});
        }

        const queriesForRound =
          currentRound === 1
            ? plan.sections.flatMap((s) => s.queries)
            : additionalQueries;

        if (queriesForRound.length === 0) break;

        // Phase 2: Search
        yield emit({
          type: "phase_changed",
          phase: "searching",
          detail: `第 ${currentRound} 轮搜索（共 ${queriesForRound.length} 个查询）...`,
        });
        await updateStatus("searching");

        // Real-time streaming search events
        const searchGen = searchQueries(ctx, queriesForRound, currentRound);
        let searchResults: SearchResult[] = [];
        while (true) {
          const { done, value } = await searchGen.next();
          if (done) {
            searchResults = value;
            break;
          }
          yield emit(value as ResearchStreamEvent);
        }
        yield emit({
          type: "progress",
          current: currentRound,
          total: this.config.maxSearchRounds,
          message: `搜索完成，找到 ${searchResults.length} 条结果`,
        });

        if (searchResults.length === 0) continue;

        // Phase 3: Read Pages
        yield emit({
          type: "phase_changed",
          phase: "reading",
          detail: `正在阅读 ${Math.min(searchResults.length, this.config.maxPagesPerRound)} 个网页...`,
        });
        await updateStatus("reading");

        // Real-time streaming page read events
        const pageGen = readPages(ctx, searchResults);
        let pages: PageContent[] = [];
        while (true) {
          const { done, value } = await pageGen.next();
          if (done) {
            pages = value;
            break;
          }
          yield emit(value as ResearchStreamEvent);
        }

        yield emit({
          type: "progress",
          current: currentRound,
          total: this.config.maxSearchRounds,
          message: `已阅读 ${pages.length} 个网页`,
        });

        // Phase 4: Compress Findings
        yield emit({
          type: "phase_changed",
          phase: "compressing",
          detail: "正在提取和压缩各章节发现...",
        });
        await updateStatus("compressing");

        const sectionsToProcess =
          currentRound === 1
            ? plan.sections
            : plan.sections.filter((s) =>
                additionalQueries.some(
                  (q) =>
                    s.heading.toLowerCase().includes(q.toLowerCase()) ||
                    s.queries.some((sq) => sq.toLowerCase().includes(q.toLowerCase()))
                )
              );

        const processSections =
          sectionsToProcess.length > 0 ? sectionsToProcess : plan.sections;

        for (const section of processSections) {
          try {
            const finding = await compressFindings(ctx, section, searchResults, pages);
            const existingIdx = allFindings.findIndex((f) => f.sectionId === section.id);
            if (existingIdx >= 0) {
              allFindings[existingIdx] = finding;
            } else {
              allFindings.push(finding);
            }

            if (researchDb && taskId) {
              await researchDb.setFindings(taskId, allFindings).catch(() => {});
            }

            yield emit({
              type: "finding",
              sectionId: section.id,
              heading: section.heading,
              summary: finding.summary,
            });
          } catch (err: any) {
            console.error(`[Research] Compression failed for section ${section.id}: ${err.message}`);
          }
        }

        // Phase 5: Gap Analysis
        yield emit({
          type: "phase_changed",
          phase: "analyzing",
          detail: "正在分析信息完整性...",
        });
        await updateStatus("analyzing");

        try {
          const gapResult = await analyzeGaps(ctx, query, currentRound, allFindings);

          if (gapResult.sufficient || gapResult.additionalQueries.length === 0) {
            break;
          }

          yield emit({
            type: "gap_detected",
            gaps: gapResult.additionalQueries,
          });

          additionalQueries = gapResult.additionalQueries;
        } catch (err: any) {
          console.error(`[Research] Gap analysis failed: ${err.message}`);
          break;
        }
      }

      // Phase 6: Report Generation
      yield emit({
        type: "phase_changed",
        phase: "writing",
        detail: "正在生成调研报告...",
      });
      await updateStatus("writing");

      let html: string;
      try {
        html = await generateReport(ctx, plan, allFindings);
      } catch (err: any) {
        html = await generateReport(ctx, plan, allFindings);
      }

      // Clean markdown code block wrapping from LLM
      html = html.replace(/^```html?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

      let reportPath: string | undefined;
      if (researchDb && taskId) {
        reportPath = await saveReportHtml(researchDb, taskId, html);
        await researchDb.updateTaskStatus(taskId, "completed", { reportPath });
      }

      await updateStatus("completed");
      yield emit({ type: "report_ready", taskId, reportPath });
    } catch (err: any) {
      await updateStatus("failed");
      yield emit({ type: "error", message: err.message });
    }
  }
}

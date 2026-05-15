import type { PipelineContext, ResearchPlan, SearchResult, PageContent, SectionFinding, GapAnalysis } from "./types.js";
import {
  DECOMPOSE_SYSTEM,
  DECOMPOSE_USER,
  COMPRESS_SYSTEM,
  COMPRESS_USER,
  GAP_ANALYSIS_SYSTEM,
  GAP_ANALYSIS_USER,
  REPORT_SYSTEM,
  REPORT_USER,
} from "./prompts.js";

// ── Utilities ──

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function deduplicateUrls(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

async function callLLMJson(
  ctx: PipelineContext,
  systemPrompt: string,
  userMessage: string
): Promise<any> {
  const response = await ctx.openai.chat.completions.create({
    model: ctx.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });
  const content = response.choices[0]?.message?.content || "{}";
  return JSON.parse(content);
}

async function callLLMText(
  ctx: PipelineContext,
  systemPrompt: string,
  userMessage: string,
  maxTokens?: number
): Promise<string> {
  const response = await ctx.openai.chat.completions.create({
    model: ctx.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0.5,
    max_tokens: maxTokens,
  });
  return response.choices[0]?.message?.content || "";
}

// ── Phase 1: Query Decomposition ──

export async function decomposeQuery(
  ctx: PipelineContext,
  query: string
): Promise<ResearchPlan> {
  const result = await callLLMJson(ctx, DECOMPOSE_SYSTEM, DECOMPOSE_USER(query));
  return {
    title: result.title || query,
    language: result.language || "zh-CN",
    sections: (result.sections || []).map((s: any, i: number) => ({
      id: s.id ?? i + 1,
      heading: s.heading || `Section ${i + 1}`,
      queries: s.queries || [],
    })),
  };
}

// ── Phase 2: Search ──

function parseSearchResults(raw: string): SearchResult[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((item: any) => ({
        title: item.title || "",
        url: item.url || item.link || "",
        snippet: item.snippet || item.content || item.text || "",
      }));
    }
    if (parsed.results && Array.isArray(parsed.results)) {
      return parseSearchResults(JSON.stringify(parsed.results));
    }
    if (parsed.data && Array.isArray(parsed.data)) {
      return parseSearchResults(JSON.stringify(parsed.data));
    }
  } catch {
    const urlRegex = /https?:\/\/[^\s"')\]]+/g;
    const urls = raw.match(urlRegex) || [];
    return urls.map((url) => ({ title: "", url, snippet: "" }));
  }
  return [];
}

export type PipelineEvent =
  | { type: "search_query"; query: string; round: number }
  | { type: "source_found"; title: string; url: string; snippet: string }
  | { type: "page_read"; url: string; title: string; status: "start" | "done" | "error" };

export async function* searchQueries(
  ctx: PipelineContext,
  queries: string[],
  round: number = 1
): AsyncGenerator<PipelineEvent, SearchResult[]> {
  const allResults: SearchResult[] = [];
  const batchSize = 3;

  for (let i = 0; i < queries.length; i += batchSize) {
    const batch = queries.slice(i, i + batchSize);

    // Yield search queries before executing
    for (const q of batch) {
      yield { type: "search_query", query: q, round };
    }

    const results = await Promise.allSettled(
      batch.map(async (q) => {
        try {
          const raw = await ctx.mcp.executeTool("mcp__web-search-prime__web_search_prime", {
            search_query: q,
            content_size: "medium",
          });
          return parseSearchResults(raw);
        } catch (err: any) {
          console.error(`[Research] Search failed for "${q}": ${err.message}`);
          return [] as SearchResult[];
        }
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        for (const item of r.value) {
          yield { type: "source_found", title: item.title, url: item.url, snippet: item.snippet };
        }
        allResults.push(...r.value);
      }
    }
  }

  return deduplicateUrls(allResults);
}

// ── Phase 3: Page Reading ──

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : "";
}

export async function* readPages(
  ctx: PipelineContext,
  results: SearchResult[],
  maxPages?: number
): AsyncGenerator<PipelineEvent, PageContent[]> {
  const limit = maxPages ?? ctx.config.maxPagesPerRound;
  const sorted = [...results]
    .filter((r) => r.url)
    .sort((a, b) => (b.snippet.length - a.snippet.length))
    .slice(0, limit);

  const batchSize = 5;
  const pages: PageContent[] = [];

  for (let i = 0; i < sorted.length; i += batchSize) {
    const batch = sorted.slice(i, i + batchSize);

    // Yield page_read start events
    for (const r of batch) {
      yield { type: "page_read", url: r.url, title: r.title || "", status: "start" };
    }

    const results = await Promise.allSettled(
      batch.map(async (r) => {
        try {
          const res = await fetch(r.url, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; ResearchBot/1.0)" },
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) {
            return { ok: false, url: r.url, title: r.title || "" };
          }
          const html = await res.text();
          const text = stripHtml(html);
          const title = r.title || extractTitle(html);
          return { ok: true, url: r.url, title, text: text.slice(0, 8000) };
        } catch (err: any) {
          console.warn(`[Research] Failed to fetch ${r.url}: ${err.message}`);
          return { ok: false, url: r.url, title: r.title || "" };
        }
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        if (r.value.ok) {
          yield { type: "page_read", url: r.value.url, title: r.value.title, status: "done" };
          pages.push({ url: r.value.url, title: r.value.title, text: r.value.text! });
        } else {
          yield { type: "page_read", url: r.value.url, title: r.value.title, status: "error" };
        }
      }
    }
  }

  return pages;
}

// ── Phase 4: Finding Compression ──

export async function compressFindings(
  ctx: PipelineContext,
  section: ResearchPlan["sections"][0],
  searchResults: SearchResult[],
  pageContents: PageContent[]
): Promise<SectionFinding> {
  const searchText = searchResults
    .slice(0, 10)
    .map((r, i) => `[${i + 1}] ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`)
    .join("\n\n");

  const pageText = pageContents
    .slice(0, 5)
    .map((p) => `来源：${p.title} (${p.url})\n${p.text}`)
    .join("\n\n---\n\n");

  const result = await callLLMJson(
    ctx,
    COMPRESS_SYSTEM,
    COMPRESS_USER(section.heading, section.queries, searchText, pageText)
  );

  return {
    sectionId: section.id,
    heading: section.heading,
    summary: result.summary || "",
    keyFacts: result.keyFacts || [],
    sources: (result.sources || []).map((s: any) => ({
      title: s.title || "",
      url: s.url || "",
      relevance: s.relevance || "中",
    })),
    gaps: result.gaps || [],
  };
}

// ── Phase 5: Gap Analysis ──

export async function analyzeGaps(
  ctx: PipelineContext,
  originalQuery: string,
  currentRound: number,
  findings: SectionFinding[]
): Promise<GapAnalysis> {
  const allFindings = findings
    .map((f) => `## ${f.heading}\n${f.summary}\n\n关键事实：${f.keyFacts.join("；")}\n\n信息缺口：${f.gaps.join("、") || "无"}`)
    .join("\n\n");

  const result = await callLLMJson(
    ctx,
    GAP_ANALYSIS_SYSTEM,
    GAP_ANALYSIS_USER(originalQuery, currentRound, allFindings)
  );

  return {
    sufficient: result.sufficient ?? true,
    additionalQueries: result.additionalQueries || [],
  };
}

// ── Phase 6: Report Generation ──

export async function generateReport(
  ctx: PipelineContext,
  plan: ResearchPlan,
  findings: SectionFinding[]
): Promise<string> {
  const findingsText = findings
    .map((f) => `## ${f.heading}\n${f.summary}\n\n关键事实：\n${f.keyFacts.map((fact) => `- ${fact}`).join("\n")}`)
    .join("\n\n");

  const allSources = findings
    .flatMap((f) => f.sources)
    .filter((s, i, arr) => arr.findIndex((x) => x.url === s.url) === i)
    .map((s, i) => `[${i + 1}] ${s.title} - ${s.url} (相关性: ${s.relevance})`)
    .join("\n");

  const html = await callLLMText(
    ctx,
    REPORT_SYSTEM,
    REPORT_USER(plan.title, findingsText, allSources),
    16000
  );

  return html;
}

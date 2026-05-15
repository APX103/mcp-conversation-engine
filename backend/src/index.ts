import express from "express";
import cors from "cors";
import path from "path";
import { loadConfig } from "./config.js";
import { McpManager } from "./mcp.js";
import { ConversationEngine } from "./engine.js";
import { findOrCreateUser } from "./users.js";
import { DbManager } from "./db.js";
import { MemoryEngine } from "./memory.js";
import { SkillEngine } from "./skill.js";
import { Scheduler } from "./scheduler.js";
import { CognitiveCore } from "./cognitive/index.js";
import OpenAI from "openai";
import { DeepResearchEngine } from "./research/index.js";
import type { ResearchStreamEvent, ChatMessage } from "./types.js";

const config = loadConfig();
const app = express();
const mcp = new McpManager();
let engine: ConversationEngine;
let db: DbManager | undefined;
let memory: MemoryEngine | undefined;
let skillEngine: SkillEngine | undefined;
let scheduler: Scheduler | undefined;
let cognitive: CognitiveCore | undefined;
let researchEngine: DeepResearchEngine | undefined;

app.use(cors());
app.use(express.json());
// 静态文件服务：workspace 目录（研究报告等产物）
app.use("/workspace", express.static(path.join(process.cwd(), "workspace")));
app.set("etag", false);
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// Root
app.get("/", (_req, res) => {
  res.json({
    name: "MCP Conversation Engine Backend",
    status: "running",
    endpoints: [
      { path: "POST /api/auth/login", desc: "用户名登录（不存在则自动创建）" },
      { path: "POST /api/sessions", desc: "创建新会话" },
      { path: "GET /api/sessions", desc: "获取用户会话列表 (?userId=xxx)" },
      { path: "GET /api/sessions/:id", desc: "获取会话消息历史" },
      { path: "POST /api/chat", desc: "发送消息，SSE 流式返回" },
      { path: "GET /api/health", desc: "健康检查" },
    { path: "GET /api/scheduler", desc: "定时任务状态" },
    { path: "POST /api/scheduler/:name/run", desc: "手动触发定时任务" },
      { path: "POST /api/research", desc: "启动深度研究，SSE 流式返回" },
      { path: "GET /api/research/:taskId", desc: "获取研究任务状态" },
      { path: "GET /api/research/:taskId/report", desc: "获取 HTML 调研报告" },
    ],
  });
});

// POST /api/auth/login — 用户名登录（不存在则自动创建）
app.post("/api/auth/login", (req, res) => {
  const { username } = req.body as { username?: string };
  if (!username || typeof username !== "string") {
    res.status(400).json({ error: "username is required" });
    return;
  }
  try {
    const user = findOrCreateUser(username);
    res.json({ user });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/sessions — create a new session
app.post("/api/sessions", async (req, res) => {
  const { userId, title } = req.body as { userId?: string; title?: string };
  if (!userId || typeof userId !== "string") {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  if (!db) {
    res.status(500).json({ error: "MongoDB not configured" });
    return;
  }
  try {
    const sessionId = await db.createSession(userId.trim(), title);
    res.json({ sessionId, userId: userId.trim(), title: title || "New Chat" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions — list sessions for a user
app.get("/api/sessions", async (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) {
    res.status(400).json({ error: "userId query parameter is required" });
    return;
  }
  if (!db) {
    res.status(500).json({ error: "MongoDB not configured" });
    return;
  }
  try {
    const sessions = await db.listSessions(userId);
    res.json({ sessions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat — SSE streaming
app.post("/api/chat", async (req, res) => {
  const { message, sessionId } = req.body as {
    message: string;
    sessionId?: string;
  };

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }

  // Resolve userId from session for memory injection & learning
  let userId: string | undefined;
  if (db) {
    const sessionDoc = await db.getSession(sessionId).catch(() => null);
    if (sessionDoc) userId = sessionDoc.userId;
  }

  await engine.loadSession(sessionId);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    for await (const event of engine.run(message, sessionId, userId)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ type: "error", content: err.message })}\n\n`);
  } finally {
    res.end();
    await engine.saveSession(sessionId);
  }
});

// GET /api/sessions/:id — get session messages (always from DB, bypass memory cache)
app.get("/api/sessions/:id", async (req, res) => {
  const sid = req.params.id;
  let messages: ChatMessage[] = [];
  let title = "New Chat";
  if (db) {
    try {
      const doc = await db.getSession(sid);
      if (doc) {
        title = doc.title;
        messages = (doc.messages as ChatMessage[]) ?? [];
      }
    } catch {
      // ignore
    }
  }
  // Also sync to engine memory so subsequent chat uses the latest data
  await engine.loadSession(sid);
  res.json({ sessionId: sid, title, messages });
});

// PATCH /api/sessions/:id — update session (title)
app.patch("/api/sessions/:id", async (req, res) => {
  const sid = req.params.id;
  const { title } = req.body as { title?: string };
  if (!db) {
    res.status(500).json({ error: "MongoDB not configured" });
    return;
  }
  try {
    if (title) await db.updateSessionTitle(sid, title);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sessions/:id — delete a session
app.delete("/api/sessions/:id", async (req, res) => {
  const sid = req.params.id;
  if (!db) {
    res.status(500).json({ error: "MongoDB not configured" });
    return;
  }
  try {
    await db.deleteSession(sid);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stop/:id — stop a running session
app.post("/api/stop/:id", (req, res) => {
  engine.stopSession(req.params.id);
  res.json({ success: true });
});

// GET /api/config/thinking — get current thinking config
app.get("/api/config/thinking", (_req, res) => {
  res.json(engine.getThinkingConfig());
});

// POST /api/config/thinking — update thinking config
app.post("/api/config/thinking", (req, res) => {
  const { thinking, reasoningEffort } = req.body as {
    thinking?: boolean;
    reasoningEffort?: "high" | "max";
  };
  if (typeof thinking === "boolean") engine.setThinking(thinking);
  if (reasoningEffort === "high" || reasoningEffort === "max") engine.setReasoningEffort(reasoningEffort);
  res.json(engine.getThinkingConfig());
});

// ── Memory (OpenClaw-style: MEMORY.md + daily logs) ──

// GET /api/memory/:userId — get long-term + recent daily logs
app.get("/api/memory/:userId", async (req, res) => {
  const userId = req.params.userId;
  if (!db) {
    res.status(500).json({ error: "MongoDB not configured" });
    return;
  }
  try {
    const longTerm = await db.getLongTermMemory(userId);
    const dailyLogs = await db.getDailyLogs(userId, 7);
    res.json({
      longTerm: longTerm?.markdown ?? "",
      dailyLogs: dailyLogs.map((d) => ({ date: d.date, content: d.content })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/memory/:userId/long-term — update MEMORY.md
app.put("/api/memory/:userId/long-term", async (req, res) => {
  const userId = req.params.userId;
  const { markdown } = req.body as { markdown?: string };
  if (!db) {
    res.status(500).json({ error: "MongoDB not configured" });
    return;
  }
  if (typeof markdown !== "string") {
    res.status(400).json({ error: "markdown is required" });
    return;
  }
  try {
    await db.updateLongTermMemory(userId, markdown);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/memory/:userId/consolidate — manually trigger consolidation
app.post("/api/memory/:userId/consolidate", async (req, res) => {
  const userId = req.params.userId;
  if (!memory) {
    res.status(500).json({ error: "Memory engine not available" });
    return;
  }
  try {
    await memory.consolidate(userId);
    const longTerm = await db!.getLongTermMemory(userId);
    res.json({ success: true, longTerm: longTerm?.markdown ?? "" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/memory/:userId — clear all memory
app.delete("/api/memory/:userId", async (req, res) => {
  const userId = req.params.userId;
  if (!db) {
    res.status(500).json({ error: "MongoDB not configured" });
    return;
  }
  try {
    await db.clearAllMemory(userId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Commitments (Inferred short-term follow-ups) ──

// GET /api/commitments/:userId — list pending commitments
app.get("/api/commitments/:userId", async (req, res) => {
  const userId = req.params.userId;
  if (!db) {
    res.status(500).json({ error: "MongoDB not configured" });
    return;
  }
  try {
    const commitments = await db.getCommitments(userId, false);
    res.json({ commitments });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/commitments/:userId/:id/fulfill — mark as done
app.post("/api/commitments/:userId/:id/fulfill", async (req, res) => {
  const id = req.params.id;
  if (!db) {
    res.status(500).json({ error: "MongoDB not configured" });
    return;
  }
  try {
    await db.fulfillCommitment(id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/commitments/:userId/:id — delete a commitment
app.delete("/api/commitments/:userId/:id", async (req, res) => {
  const id = req.params.id;
  if (!db) {
    res.status(500).json({ error: "MongoDB not configured" });
    return;
  }
  try {
    await db.deleteCommitment(id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Skills ──

// GET /api/skills/:userId — list skills for a user
app.get("/api/skills/:userId", async (req, res) => {
  const userId = req.params.userId;
  if (!db) {
    res.status(500).json({ error: "MongoDB not configured" });
    return;
  }
  try {
    const skills = await db.getSkills(userId, true);
    res.json({ skills });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/skills/:userId/:id — toggle skill enabled
app.put("/api/skills/:userId/:id", async (req, res) => {
  const id = req.params.id;
  const { enabled } = req.body as { enabled?: boolean };
  if (!db) {
    res.status(500).json({ error: "MongoDB not configured" });
    return;
  }
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled is required" });
    return;
  }
  try {
    await db.updateSkillEnabled(id, enabled);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cognitive Skills ──

app.get('/api/cognitive/skills/:userId', async (req, res) => {
  try {
    const skills = await db!.getCognitiveSkills(req.params.userId);
    res.json(skills);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cognitive/skills/:userId/pending', async (req, res) => {
  try {
    const all = await db!.getCognitiveSkills(req.params.userId);
    const pending = all.filter(s => s.confirmedAt === null);
    res.json(pending);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cognitive/skills/:userId/:id/confirm', async (req, res) => {
  try {
    await db!.confirmCognitiveSkill(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/cognitive/skills/:userId/:id', async (req, res) => {
  try {
    await db!.deactivateCognitiveSkill(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cognitive/candidates/:userId', async (req, res) => {
  try {
    const candidates = await db!.getCognitiveCandidates(req.params.userId, 'candidate');
    res.json(candidates);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cognitive/config', (_req, res) => {
  res.json(cognitive?.config || null);
});

// ── Deep Research ──

// POST /api/research — 启动深度研究，SSE 流式返回进度
app.post("/api/research", async (req, res) => {
  const { query, sessionId, userId } = req.body as { query?: string; sessionId?: string; userId?: string };

  if (!query) {
    res.status(400).json({ error: "query is required" });
    return;
  }

  if (!researchEngine) {
    res.status(500).json({ error: "Deep Research Engine not available" });
    return;
  }

  // 1. 把研究请求写入 session（持久化）
  if (sessionId && engine) {
    const msgs = engine.getOrCreateSession(sessionId);
    msgs.push({ role: "user", content: query });
    await engine.saveSession(sessionId);
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // 收集详细研究数据，用于生成持久化对话记录
  let taskId = "";
  let taskTitle = "";
  let reportPath: string | undefined;
  let hasError = false;
  let errorMsg = "";

  // 结构化收集搜索过程
  const allEvents: ResearchStreamEvent[] = [];
  const searchMap = new Map<string, { query: string; round: number; sources: Array<{ title: string; url: string; snippet: string }> }>();
  const readings: Array<{ url: string; title: string; status: string }> = [];
  const findings: Array<{ heading: string; summary: string }> = [];
  let maxRound = 0;

  try {
    for await (const event of researchEngine.run(query, sessionId)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      allEvents.push(event);

      if (event.type === "research_started") {
        taskId = event.taskId;
        taskTitle = event.title;
      }
      if (event.type === "search_query") {
        maxRound = Math.max(maxRound, event.round || 1);
        searchMap.set(event.query, { query: event.query, round: event.round || 1, sources: [] });
      }
      if (event.type === "source_found") {
        // 找到最近的一个搜索查询，把来源归属给它
        const lastSearch = Array.from(searchMap.values()).pop();
        if (lastSearch) {
          lastSearch.sources.push({ title: event.title, url: event.url, snippet: event.snippet });
        }
      }
      if (event.type === "page_read") {
        readings.push({ url: event.url, title: event.title, status: event.status });
      }
      if (event.type === "finding") {
        findings.push({ heading: event.heading || "", summary: event.summary || "" });
      }
      if (event.type === "report_ready") {
        reportPath = event.reportPath;
      }
      if (event.type === "error") {
        hasError = true;
        errorMsg = event.message;
      }
    }
  } catch (err: any) {
    hasError = true;
    errorMsg = err.message;
    res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
  } finally {
    res.end();
  }

  // 2. 研究完成后，生成详细对话记录写入 session（持久化）
  if (sessionId && engine && taskId) {
    try {
      const msgs = engine.getOrCreateSession(sessionId);

      // 生成 reasoning_content（思考过程）
      const reasoningLines: string[] = [];
      reasoningLines.push(`【研究目标】${taskTitle || query}`);
      reasoningLines.push(`【搜索策略】执行 ${maxRound} 轮搜索，共 ${searchMap.size} 个查询`);
      reasoningLines.push(`【信息源】找到 ${readings.filter(r => r.status === "done").length} 个有效网页`);
      reasoningLines.push(`【发现提取】提取 ${findings.length} 个章节的关键发现`);
      if (reportPath) {
        reasoningLines.push(`【结论】研究报告已生成，包含完整分析`);
      }
      const reasoningContent = reasoningLines.join("\n");

      // 生成详细 content（markdown）
      let content = "";

      if (hasError) {
        content = `🔬 深度研究任务失败\n\n**研究主题**: ${taskTitle || query}\n\n❌ 错误: ${errorMsg}`;
      } else {
        content = `🔬 深度研究完成\n\n**研究主题**: ${taskTitle || query}\n\n`;

        // 按轮次分组展示搜索过程
        const roundGroups = new Map<number, typeof searchMap extends Map<string, infer V> ? V[] : never>();
        for (const s of searchMap.values()) {
          if (!roundGroups.has(s.round)) roundGroups.set(s.round, []);
          roundGroups.get(s.round)!.push(s);
        }

        for (let r = 1; r <= maxRound; r++) {
          const searches = roundGroups.get(r) || [];
          if (searches.length === 0) continue;

          content += `---\n\n### 第 ${r} 轮搜索\n\n`;

          for (const s of searches) {
            content += `**🔍 搜索**: "${s.query}"\n\n`;
            if (s.sources.length > 0) {
              for (const src of s.sources) {
                const hostname = src.url ? (() => { try { return new URL(src.url).hostname; } catch { return src.url; } })() : "";
                content += `- ↳ **${src.title || "未知网页"}**`;
                if (hostname) content += ` (${hostname})`;
                content += "\n";
                if (src.snippet) {
                  const snippet = src.snippet.replace(/\n/g, " ").slice(0, 120);
                  content += `  > ${snippet}${src.snippet.length > 120 ? "..." : ""}\n`;
                }
                content += "\n";
              }
            }
          }
        }

        // 阅读记录
        const doneReadings = readings.filter(r => r.status === "done");
        if (doneReadings.length > 0) {
          content += `---\n\n### 📄 阅读记录\n\n`;
          for (const r of doneReadings) {
            content += `- ✓ ${r.title || r.url}\n`;
          }
          content += "\n";
        }

        // 发现
        if (findings.length > 0) {
          content += `---\n\n### 💡 研究发现\n\n`;
          for (const f of findings) {
            content += `**${f.heading}**\n\n`;
            const summary = f.summary.replace(/\n/g, " ").slice(0, 300);
            content += `${summary}${f.summary.length > 300 ? "..." : ""}\n\n`;
          }
        }

        // 报告链接
        if (reportPath) {
          const webPath = reportPath.replace(process.cwd(), "").replace(/\\/g, "/");
          content += `---\n\n### 📊 研究报告\n\n[查看完整报告 →](${webPath})\n`;
        }
      }

      msgs.push({
        role: "assistant",
        content,
        reasoning_content: reasoningContent,
      });
      await engine.saveSession(sessionId);

      // 3. 自动修改会话标题（如果是第一条消息，或者标题是默认的）
      if (db) {
        const title = taskTitle || query;
        const shortTitle = title.length > 30 ? title.slice(0, 30) + "..." : title;
        await db.updateSessionTitle(sessionId, `🔬 ${shortTitle}`).catch(() => {});
      }
    } catch (saveErr) {
      console.error("[Research] Failed to save research detail to session:", saveErr);
    }
  }
});

// GET /api/research — 查询会话的最新研究任务
app.get("/api/research", async (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  if (!db) {
    res.status(500).json({ error: "MongoDB not configured" });
    return;
  }
  try {
    const { ResearchDB } = await import("./research/db.js");
    const researchDb = new ResearchDB(db);
    const task = await researchDb.getLatestTaskBySession(sessionId);
    if (!task) {
      res.json(null);
      return;
    }
    // 同时检查报告是否存在
    const hasReport = !!(await researchDb.getReport(task._id!.toString()));
    res.json({ ...task, hasReport });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/research/:taskId — 获取研究任务状态
app.get("/api/research/:taskId", async (req, res) => {
  const taskId = req.params.taskId;
  if (!db) {
    res.status(500).json({ error: "MongoDB not configured" });
    return;
  }
  try {
    const { ResearchDB } = await import("./research/db.js");
    const researchDb = new ResearchDB(db);
    const task = await researchDb.getTask(taskId);
    if (!task) {
      res.status(404).json({ error: "Research task not found" });
      return;
    }
    res.json(task);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/research/:taskId/report — 获取 HTML 报告（从文件系统读取）
app.get("/api/research/:taskId/report", async (req, res) => {
  const taskId = req.params.taskId;
  if (!db) {
    res.status(500).json({ error: "MongoDB not configured" });
    return;
  }
  try {
    const { ResearchDB } = await import("./research/db.js");
    const { getReportHtml } = await import("./research/report.js");
    const researchDb = new ResearchDB(db);
    const html = await getReportHtml(researchDb, taskId);
    if (!html) {
      res.status(404).json({ error: "Report not found" });
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/research/:taskId/save-as-skill — 将研究报告保存为 Skill
app.post("/api/research/:taskId/save-as-skill", async (req, res) => {
  const taskId = req.params.taskId;
  const { userId } = req.body as { userId?: string };

  if (!db) {
    res.status(500).json({ error: "MongoDB not configured" });
    return;
  }
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }

  try {
    const { ResearchDB } = await import("./research/db.js");
    const researchDb = new ResearchDB(db);

    // 获取任务信息和报告
    const task = await researchDb.getTask(taskId);
    const { getReportHtml } = await import("./research/report.js");
    const html = await getReportHtml(researchDb, taskId);

    if (!task || !html) {
      res.status(404).json({ error: "Research task or report not found" });
      return;
    }

    // 简单的 HTML → 纯文本转换
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const title = task.query || "研究报告";
    const skillName = `research-${taskId.slice(-8)}`;

    await db.addSkill({
      userId,
      name: skillName,
      description: `深度研究报告: ${title}`,
      triggers: ["research", "调研", "研究"],
      content: `# ${title}\n\n> 来源: 深度研究任务 (${taskId})\n> 生成时间: ${new Date().toISOString()}\n\n${text.slice(0, 50000)}`,
      enabled: true,
      builtin: false,
    });

    res.json({ success: true, skillName });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Subagent ──

// GET /api/subagent/:id — 获取子 agent 状态
app.get("/api/subagent/:id", async (req, res) => {
  const subagentId = req.params.id;
  if (!db) {
    res.status(500).json({ error: "MongoDB not configured" });
    return;
  }
  try {
    const { SubagentDB } = await import("./subagent/db.js");
    const subagentDb = new SubagentDB(db);
    const doc = await subagentDb.get(subagentId);
    if (!doc) {
      res.status(404).json({ error: "Subagent not found" });
      return;
    }
    res.json(doc);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/subagent/:id/stream — SSE 流式返回子 agent 执行过程
app.get("/api/subagent/:id/stream", async (req, res) => {
  const subagentId = req.params.id;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const { subagentBus } = await import("./subagent/bus.js");
  const { SubagentDB } = await import("./subagent/db.js");

  let dbInstance: InstanceType<typeof SubagentDB> | undefined;
  if (db) dbInstance = new SubagentDB(db);

  // Send cached events first (from messages history)
  if (dbInstance) {
    try {
      const doc = await dbInstance.get(subagentId);
      if (doc?.messages) {
        for (const m of doc.messages) {
          if (m.role === "assistant" && m.reasoning_content) {
            res.write(`data: ${JSON.stringify({ type: "reasoning", content: m.reasoning_content })}\n\n`);
          }
          if (m.role === "assistant" && m.content) {
            res.write(`data: ${JSON.stringify({ type: "text", content: m.content })}\n\n`);
          }
          if (m.tool_calls) {
            for (const tc of m.tool_calls) {
              res.write(`data: ${JSON.stringify({ type: "tool_call_end", id: tc.id, name: tc.name, arguments: JSON.parse(tc.arguments || "{}") })}\n\n`);
            }
          }
          if (m.role === "tool") {
            res.write(`data: ${JSON.stringify({ type: "tool_result", id: m.tool_call_id || "", name: "", result: m.content })}\n\n`);
          }
        }
      }
      if (doc?.status === "completed") {
        res.write(`data: ${JSON.stringify({ type: "subagent_completed", result: doc.result })}\n\n`);
      } else if (doc?.status === "failed") {
        res.write(`data: ${JSON.stringify({ type: "error", message: doc.error || "失败" })}\n\n`);
      }
    } catch {
      // ignore
    }
  }

  const listener = (event: any) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  subagentBus.on(subagentId, listener);

  req.on("close", () => {
    subagentBus.off(subagentId, listener);
  });
});

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── Scheduler ──

app.get("/api/scheduler", (_req, res) => {
  if (!scheduler) {
    res.status(500).json({ error: "Scheduler not initialized" });
    return;
  }
  res.json({ tasks: scheduler.list() });
});

app.post("/api/scheduler/:name/run", async (req, res) => {
  if (!scheduler) {
    res.status(500).json({ error: "Scheduler not initialized" });
    return;
  }
  try {
    await scheduler.runNow(req.params.name);
    res.json({ success: true, tasks: scheduler.list() });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

async function start() {
  // Connect MongoDB if configured
  if (config.mongodb) {
    db = new DbManager(config.mongodb.uri, config.mongodb.dbName);
    await db.connect();
  }

  // Connect MCP servers
  if (config.mcpServers) {
    await mcp.connectAll(config.mcpServers);
  }

  // Initialize memory & skill engines if DB is available
  if (db) {
    const openai = new OpenAI({
      baseURL: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
    });
    memory = new MemoryEngine(openai, config.llm.model, db);
    skillEngine = new SkillEngine(db);
    await skillEngine.initBuiltinSkills();

    // Initialize CognitiveCore
    cognitive = CognitiveCore.create(db, openai, config.llm.model, config.cognitive as any);
    console.log('[Cognitive] Core initialized, mode:', cognitive.config.autoLevel);

    // ── Scheduler ──
    const schCfg = config.scheduler;
    if (schCfg?.enabled !== false) {
      scheduler = new Scheduler();
      const tz = schCfg?.timezone;

      // 1. Nightly memory consolidation for all users
      const nc = schCfg?.tasks?.nightlyConsolidate;
      if (nc?.enabled !== false && memory) {
        scheduler.register(
          "nightly-consolidate",
          nc?.cron ?? "0 3 * * *",
          async () => {
            const userIds = await db!.getAllUserIds();
            console.log(`[Scheduler] nightly-consolidate: ${userIds.length} users`);
            for (const userId of userIds) {
              try {
                await memory!.consolidate(userId);
              } catch (err: any) {
                console.error(`[Scheduler] consolidate failed for ${userId}:`, err.message);
              }
            }
          },
          { timezone: tz }
        );
      }

      // 2. Cleanup old daily logs
      const cl = schCfg?.tasks?.cleanupOldLogs;
      if (cl?.enabled !== false) {
        const retention = cl?.retentionDays ?? 30;
        scheduler.register(
          "cleanup-old-logs",
          cl?.cron ?? "0 4 * * *",
          async () => {
            const deleted = await db!.deleteOldDailyLogs(retention);
            console.log(`[Scheduler] cleanup-old-logs: deleted ${deleted} logs older than ${retention} days`);
          },
          { timezone: tz }
        );
      }

      // 3. Cleanup fulfilled old commitments
      const cc = schCfg?.tasks?.cleanupOldCommitments;
      if (cc?.enabled !== false) {
        const retention = cc?.retentionDays ?? 30;
        scheduler.register(
          "cleanup-old-commitments",
          cc?.cron ?? "30 4 * * *",
          async () => {
            const deleted = await db!.deleteOldCommitments(retention);
            console.log(`[Scheduler] cleanup-old-commitments: deleted ${deleted} commitments older than ${retention} days`);
          },
          { timezone: tz }
        );
      }

      // 4. Register cognitive decay task
      if (cognitive) {
        const DecayEngine = (await import('./cognitive/memory/decay.js')).DecayEngine;
        const decayEngine = new DecayEngine(db, cognitive.config);
        scheduler.register('cognitive-daily-decay', '0 5 * * *', async () => {
          const userIds = await db!.getAllUserIdsWithCandidates();
          let total = 0;
          for (const userId of userIds) {
            total += await decayEngine.applyDailyDecay(userId);
          }
          console.log(`[Cognitive] Daily decay: cleaned ${total} expired candidates across ${userIds.length} users`);
        }, { timezone: tz });
      }
    }
  }

  engine = new ConversationEngine(config, mcp, db, memory, skillEngine, cognitive?.adapter);

  // Initialize Deep Research Engine
  researchEngine = new DeepResearchEngine(config, mcp, db);
  if (researchEngine.enabled) {
    console.log("[Research] Deep Research Engine initialized");
  }

  app.listen(config.server.port, () => {
    console.log(`Server running at http://localhost:${config.server.port}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});

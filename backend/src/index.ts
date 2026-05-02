import express from "express";
import cors from "cors";
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

const config = loadConfig();
const app = express();
const mcp = new McpManager();
let engine: ConversationEngine;
let db: DbManager | undefined;
let memory: MemoryEngine | undefined;
let skillEngine: SkillEngine | undefined;
let scheduler: Scheduler | undefined;
let cognitive: CognitiveCore | undefined;

app.use(cors());
app.use(express.json());
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

// GET /api/sessions/:id — get session messages
app.get("/api/sessions/:id", async (req, res) => {
  const sid = req.params.id;
  await engine.loadSession(sid);
  const messages = engine.getOrCreateSession(sid);
  let title = "New Chat";
  if (db) {
    const doc = await db.getSession(sid).catch(() => null);
    if (doc) title = doc.title;
  }
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

  app.listen(config.server.port, () => {
    console.log(`Server running at http://localhost:${config.server.port}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});

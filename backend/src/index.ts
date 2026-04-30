import express from "express";
import cors from "cors";
import { loadConfig } from "./config.js";
import { McpManager } from "./mcp.js";
import { ConversationEngine } from "./engine.js";
import { findOrCreateUser } from "./users.js";
import { DbManager } from "./db.js";
import { MemoryEngine } from "./memory.js";
import OpenAI from "openai";

const config = loadConfig();
const app = express();
const mcp = new McpManager();
let engine: ConversationEngine;
let db: DbManager | undefined;
let memory: MemoryEngine | undefined;

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

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
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

  // Initialize memory engine if DB is available
  if (db) {
    const openai = new OpenAI({
      baseURL: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
    });
    memory = new MemoryEngine(openai, config.llm.model, db);
  }

  engine = new ConversationEngine(config, mcp, db, memory);

  app.listen(config.server.port, () => {
    console.log(`Server running at http://localhost:${config.server.port}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});

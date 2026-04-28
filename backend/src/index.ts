import express from "express";
import cors from "cors";
import { loadConfig } from "./config.js";
import { McpManager } from "./mcp.js";
import { ConversationEngine } from "./engine.js";
import { findOrCreateUser } from "./users.js";
import { DbManager } from "./db.js";

const config = loadConfig();
const app = express();
const mcp = new McpManager();
let engine: ConversationEngine;
let db: DbManager | undefined;

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

  await engine.loadSession(sessionId);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    for await (const event of engine.run(message, sessionId)) {
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

  engine = new ConversationEngine(config, mcp, db);

  app.listen(config.server.port, () => {
    console.log(`Server running at http://localhost:${config.server.port}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});

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

// Root
app.get("/", (_req, res) => {
  res.json({
    name: "MCP Conversation Engine Backend",
    status: "running",
    endpoints: [
      { path: "POST /api/auth/login", desc: "用户名登录（不存在则自动创建）" },
      { path: "POST /api/chat", desc: "发送消息，SSE 流式返回" },
      { path: "GET /api/sessions/:id", desc: "获取会话历史" },
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

// POST /api/chat — SSE streaming
app.post("/api/chat", async (req, res) => {
  const { message, sessionId = "default", username } = req.body as {
    message: string;
    sessionId?: string;
    username?: string;
  };

  // 优先用 username 作为会话隔离键
  const effectiveSessionId = username?.trim() || sessionId;

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  if (!effectiveSessionId) {
    res.status(400).json({ error: "username or sessionId is required" });
    return;
  }

  await engine.loadSession(effectiveSessionId);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    for await (const event of engine.run(message, effectiveSessionId)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ type: "error", content: err.message })}\n\n`);
  } finally {
    res.end();
    await engine.saveSession(effectiveSessionId);
  }
});

// GET /api/sessions/:id — get session messages
app.get("/api/sessions/:id", async (req, res) => {
  await engine.loadSession(req.params.id);
  const messages = engine.getOrCreateSession(req.params.id);
  res.json({ messages });
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

import express from "express";
import cors from "cors";
import { loadConfig } from "./config.js";
import { McpManager } from "./mcp.js";
import { ConversationEngine } from "./engine.js";

const config = loadConfig();
const app = express();
const mcp = new McpManager();
let engine: ConversationEngine;

app.use(cors());
app.use(express.json());

// POST /api/chat — SSE streaming
app.post("/api/chat", async (req, res) => {
  const { message, sessionId = "default" } = req.body as {
    message: string;
    sessionId?: string;
  };

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

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
  }
});

// GET /api/sessions/:id — get session messages
app.get("/api/sessions/:id", (req, res) => {
  const messages = engine.getOrCreateSession(req.params.id);
  res.json({ messages });
});

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

async function start() {
  // Connect MCP servers
  if (config.mcpServers) {
    await mcp.connectAll(config.mcpServers);
  }

  engine = new ConversationEngine(config, mcp);

  app.listen(config.server.port, () => {
    console.log(`Server running at http://localhost:${config.server.port}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});

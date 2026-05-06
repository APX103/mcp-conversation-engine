/**
 * Agent Self-Bootstrapping Service Template
 *
 * 这是给 MCP Conversation Engine agent 用 create_service 部署的示例服务。
 * 功能：
 * 1. 作为 A2A 客户端连接 A2A-center
 * 2. 调用 backend 自身 API 创建新会话并对话
 * 3. gRPC 客户端示例
 *
 * 用法：
 *   把下面这段代码作为字符串传给 create_service 工具的 code 参数即可。
 */

const SERVICE_TEMPLATE = `
import http from "http";
import { A2AClient } from "@a2a-js/sdk/client";
import * as grpc from "@grpc/grpc-js";

// ── Config ──
const BACKEND_API = "http://localhost:3000";   // backend 自身 API
const A2A_CENTER = process.env.A2A_CENTER_URL || "http://a2a-center:8888";
const USER_ID = process.env.USER_ID || "agent-self";

// ── Helpers ──

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { "Content-Type": "application/json", ...opts.headers } });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function createSession(title = "Auto Session") {
  return fetchJson(\`\${BACKEND_API}/api/sessions\`, {
    method: "POST",
    body: JSON.stringify({ userId: USER_ID, title }),
  });
}

async function sendToSession(sessionId, message) {
  return new Promise((resolve, reject) => {
    const req = http.request(\`\${BACKEND_API}/api/chat\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, (res) => {
      let buffer = "";
      res.on("data", (c) => (buffer += c));
      res.on("end", () => {
        const texts = [];
        const toolCalls = [];
        const toolResults = [];
        for (const line of buffer.split("\\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim());
            if (ev.type === "text") texts.push(ev.content);
            if (ev.type === "tool_call_start") toolCalls.push({ id: ev.id, name: ev.name, args: ev.arguments });
            if (ev.type === "tool_result") toolResults.push({ id: ev.id, name: ev.name, result: ev.result });
          } catch {}
        }
        resolve({ reply: texts.join(""), toolCalls, toolResults });
      });
    });
    req.on("error", reject);
    req.write(JSON.stringify({ sessionId, message }));
    req.end();
  });
}

// ── A2A Client ──

let a2aClient = null;

async function getA2AClient() {
  if (!a2aClient) {
    a2aClient = await A2AClient.fromCardUrl(A2A_CENTER);
  }
  return a2aClient;
}

// ── gRPC Client (示例) ──

function createGrpcChannel(address) {
  return new grpc.Channel(address, grpc.credentials.createInsecure(), {});
}

// ── HTTP Server ──

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  const send = (code, data) => {
    res.writeHead(code);
    res.end(JSON.stringify(data, null, 2));
  };

  try {
    // POST /a2a/discover  → 发现 A2A agent card
    if (req.url === "/a2a/discover" && req.method === "POST") {
      const client = await getA2AClient();
      // A2AClient 内部已持有 agentCard，我们通过一个内部 hack 或直接 fetch
      const cardRes = await fetch(\`\${A2A_CENTER}/.well-known/agent.json\`);
      const card = await cardRes.json();
      send(200, { success: true, card });
    }

    // POST /a2a/send  → 向 A2A agent 发消息
    else if (req.url === "/a2a/send" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const { text, streaming = false } = JSON.parse(body);
        const client = await getA2AClient();
        if (!streaming) {
          const result = await client.sendMessage({
            message: {
              kind: "message",
              messageId: crypto.randomUUID(),
              parts: [{ kind: "text", text }],
            },
          });
          send(200, { success: true, result });
        } else {
          const events = [];
          const stream = await client.sendMessageStream({
            message: {
              kind: "message",
              messageId: crypto.randomUUID(),
              parts: [{ kind: "text", text }],
            },
          });
          for await (const ev of stream) {
            events.push(ev);
          }
          send(200, { success: true, events });
        }
      });
      return;
    }

    // POST /chat/new  → 创建新会话并发送首条消息
    else if (req.url === "/chat/new" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const { message, title = "Auto Session" } = JSON.parse(body);
        const session = await createSession(title);
        if (!session.sessionId) {
          send(500, { error: "Failed to create session", details: session });
          return;
        }
        const result = await sendToSession(session.sessionId, message);
        send(200, {
          success: true,
          sessionId: session.sessionId,
          ...result,
        });
      });
      return;
    }

    // POST /chat/continue  → 向已有会话发消息
    else if (req.url === "/chat/continue" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const { sessionId, message } = JSON.parse(body);
        const result = await sendToSession(sessionId, message);
        send(200, { success: true, sessionId, ...result });
      });
      return;
    }

    // POST /grpc/call  → gRPC 一元调用示例
    else if (req.url === "/grpc/call" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const { address, method, request } = JSON.parse(body);
        const channel = createGrpcChannel(address);
        // 这里只是一个演示：用 grpc.Client 和动态方法调用
        const client = new grpc.Client(address, grpc.credentials.createInsecure());
        // 对于动态调用，需要知道 service definition。这里返回 channel 状态作为演示。
        const state = channel.getConnectivityState(true);
        client.close();
        send(200, { success: true, connectivityState: state });
      });
      return;
    }

    else {
      send(404, { error: "Not found", available: [
        "POST /a2a/discover",
        "POST /a2a/send",
        "POST /chat/new",
        "POST /chat/continue",
        "POST /grpc/call",
      ]});
    }
  } catch (err) {
    send(500, { error: err.message, stack: err.stack });
  }
});

server.listen(process.env.SERVICE_PORT, () => {
  console.log(\`[AgentSelfService] Running on port \${process.env.SERVICE_PORT}\`);
  console.log(\`[AgentSelfService] Backend API: \${BACKEND_API}\`);
  console.log(\`[AgentSelfService] A2A Center:  \${A2A_CENTER}\`);
});
`;

export default SERVICE_TEMPLATE;

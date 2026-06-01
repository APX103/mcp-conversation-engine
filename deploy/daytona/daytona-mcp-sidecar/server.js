import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import http from "http";

const DAYTONA_API = process.env.DAYTONA_API_URL || "http://10.1.52.70:3080/api";
const DAYTONA_TOOLBOX = process.env.DAYTONA_TOOLBOX_URL || "http://10.1.52.70:4000/toolbox";
const API_KEY = process.env.DAYTONA_API_KEY || "";
const PORT = process.env.PORT || 3100;

const sandboxes = new Map();
let requestCount = 0;

async function waitForSandbox(sandboxId, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`${DAYTONA_API}/sandbox/${sandboxId}`, {
        headers: { Authorization: `Bearer ${API_KEY}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.state === "ready" || data.state === "started" || data.status === "ready") {
          return data;
        }
      }
    } catch (err) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Sandbox ${sandboxId} not ready within ${timeout}ms`);
}

async function handleRunCode(args) {
  const code = args?.code;
  const language = args?.language || "python";
  if (!code) throw new Error("code is required");

  const createRes = await fetch(`${DAYTONA_API}/sandbox`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ target: "us" })
  });
  if (!createRes.ok) throw new Error(`Failed to create sandbox: ${createRes.statusText}`);
  const sandbox = await createRes.json();
  const sandboxId = sandbox.id || sandbox.sandboxId;

  await waitForSandbox(sandboxId);

  const execRes = await fetch(`${DAYTONA_TOOLBOX}/${sandboxId}/process/code-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
    body: JSON.stringify({ code, language })
  });

  let execResult;
  if (execRes.ok) {
    execResult = await execRes.json();
  } else {
    execResult = { error: execRes.statusText, result: "" };
  }

  await fetch(`${DAYTONA_API}/sandbox/${sandboxId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${API_KEY}` }
  }).catch(() => {});

  return { content: [{ type: "text", text: execResult.result || JSON.stringify(execResult) }] };
}

async function handleCreateSandbox(args) {
  const createRes = await fetch(`${DAYTONA_API}/sandbox`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ target: "us" })
  });
  if (!createRes.ok) throw new Error(`Failed to create sandbox: ${createRes.statusText}`);
  const sandbox = await createRes.json();
  const sandboxId = sandbox.id || sandbox.sandboxId;
  sandboxes.set(sandboxId, { createdAt: Date.now() });
  return { content: [{ type: "text", text: JSON.stringify({ sandboxId, message: "Sandbox created. Use run_code_in_sandbox to execute code." }, null, 2) }] };
}

async function handleRunCodeInSandbox(args) {
  const sandboxId = args?.sandboxId;
  const code = args?.code;
  const language = args?.language || "python";
  if (!sandboxId) throw new Error("sandboxId is required");
  if (!code) throw new Error("code is required");

  if (!sandboxes.has(sandboxId)) {
    try {
      await fetch(`${DAYTONA_API}/sandbox/${sandboxId}`, { headers: { Authorization: `Bearer ${API_KEY}` } });
      sandboxes.set(sandboxId, { createdAt: Date.now() });
    } catch (err) {
      throw new Error(`Sandbox ${sandboxId} not found`);
    }
  }

  const execRes = await fetch(`${DAYTONA_TOOLBOX}/${sandboxId}/process/code-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
    body: JSON.stringify({ code, language })
  });
  if (!execRes.ok) throw new Error(`Execution failed: ${execRes.statusText}`);
  const execResult = await execRes.json();
  return { content: [{ type: "text", text: execResult.result || JSON.stringify(execResult) }] };
}

async function handleListSandboxes() {
  const list = Array.from(sandboxes.keys()).map(id => ({ sandboxId: id, createdAt: sandboxes.get(id)?.createdAt }));
  return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
}

async function handleDeleteSandbox(args) {
  const sandboxId = args?.sandboxId;
  if (!sandboxId) throw new Error("sandboxId is required");
  await fetch(`${DAYTONA_API}/sandbox/${sandboxId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${API_KEY}` }
  });
  sandboxes.delete(sandboxId);
  return { content: [{ type: "text", text: `Sandbox ${sandboxId} deleted.` }] };
}

// Create HTTP server
const httpServer = http.createServer();

httpServer.on("request", async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  if (req.url === "/mcp") {
    requestCount++;
    console.log(`[MCP] Request #${requestCount}: ${req.method} ${req.url}`);
    console.log(`[MCP] Headers:`, JSON.stringify(req.headers, null, 2));

    // Parse body for POST requests
    let parsedBody = {};
    if (req.method === "POST") {
      try {
        const body = await new Promise(resolve => {
          let data = "";
          req.on("data", chunk => data += chunk);
          req.on("end", () => resolve(data));
        });
        parsedBody = body ? JSON.parse(body) : {};
        console.log(`[MCP] Method:`, parsedBody.method || parsedBody[0]?.method);
      } catch (err) {
        console.error(`[MCP] Error parsing body:`, err);
      }
    }

    try {
      // Log session ID before request
      console.log(`[MCP] Before request - transport.sessionId:`, transport.sessionId);
      // Let transport handle the request directly
      await transport.handleRequest(req, res, parsedBody);
      console.log(`[MCP] Response handled by transport (headersSent: ${res.headersSent}, statusCode: ${res.statusCode})`);
      console.log(`[MCP] After request - transport.sessionId:`, transport.sessionId);
      // Log response headers
      console.log(`[MCP] Response headers:`, res.getHeader('mcp-session-id'));
    } catch (err) {
      console.error(`[MCP] Error handling request:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// Create MCP server and transport
const mcpServer = new Server(
  { name: "daytona-sandbox", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "run_code",
      description: "Execute code in a Daytona sandbox. Creates a sandbox, runs the code, and destroys it. Returns the execution output.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "Code to execute" },
          language: { type: "string", description: "Programming language (python, javascript, typescript, etc.)", default: "python" }
        },
        required: ["code"]
      }
    },
    {
      name: "create_sandbox",
      description: "Create a new Daytona sandbox. Returns the sandbox ID for use with run_code_in_sandbox.",
      inputSchema: {
        type: "object",
        properties: {
          language: { type: "string", description: "Programming language for the sandbox", default: "python" }
        }
      }
    },
    {
      name: "run_code_in_sandbox",
      description: "Run code in an existing sandbox. Use after create_sandbox. Faster than run_code for multiple executions.",
      inputSchema: {
        type: "object",
        properties: {
          sandboxId: { type: "string", description: "Sandbox ID from create_sandbox" },
          code: { type: "string", description: "Code to execute" },
          language: { type: "string", description: "Programming language", default: "python" }
        },
        required: ["sandboxId", "code"]
      }
    },
    {
      name: "list_sandboxes",
      description: "List all active sandboxes created in this session.",
      inputSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "delete_sandbox",
      description: "Delete a sandbox by ID.",
      inputSchema: {
        type: "object",
        properties: {
          sandboxId: { type: "string", description: "Sandbox ID to delete" }
        },
        required: ["sandboxId"]
      }
    }
  ]
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  console.log(`[MCP] CallTool request:`, JSON.stringify(request));
  // CallToolRequest has structure: { method: "tools/call", params: { name, arguments } }
  const { params } = request;
  const name = params?.name;
  const args = params?.arguments;
  console.log(`[MCP] Tool name:`, name, `Args:`, args);
  try {
    if (!name) {
      return { content: [{ type: "text", text: `Error: Tool name is missing` }], isError: true };
    }
    switch (name) {
      case "run_code": return await handleRunCode(args);
      case "create_sandbox": return await handleCreateSandbox(args);
      case "run_code_in_sandbox": return await handleRunCodeInSandbox(args);
      case "list_sandboxes": return await handleListSandboxes();
      case "delete_sandbox": return await handleDeleteSandbox(args);
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

// Create transport with explicit session ID generator
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => {
    const id = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    console.log(`[MCP] Generated session ID: ${id}`);
    return id;
  }
});

// Set up error handler on transport
transport.onerror = (err) => {
  console.error("[MCP] Transport error:", err);
};

// Connect server to transport
mcpServer.connect(transport).catch(err => {
  console.error("[MCP] Failed to connect server to transport:", err);
});

httpServer.listen(PORT, () => {
  console.log(`Daytona MCP Sidecar listening on http://0.0.0.0:${PORT}`);
  console.log(`MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
  console.log(`Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`Daytona API: ${DAYTONA_API}`);
  console.log(`Daytona Toolbox: ${DAYTONA_TOOLBOX}`);
});

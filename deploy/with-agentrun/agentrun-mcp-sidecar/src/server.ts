#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { AgentRunClient } from "./agentrun.js";
import {
  createExecuteCodeTool,
  createExecuteCodeHandler,
  createInstallPackagesTool,
  createInstallPackagesHandler,
  createSandboxStatusTool,
  createSandboxStatusHandler,
} from "./tools.js";
import type { AgentRunConfig } from "./types.js";
import { InMemoryEventStore } from "./eventStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 加载配置文件
 */
function loadConfig(): AgentRunConfig {
  const configPath =
    process.env.AGENTRUN_CONFIG || resolve(__dirname, "..", "config.json");

  try {
    const content = readFileSync(configPath, "utf-8");
    const config = JSON.parse(content) as AgentRunConfig;

    const requiredFields: (keyof AgentRunConfig)[] = [
      "apiKey",
      "accountId",
      "region",
      "templateName",
      "sandboxIdleTimeout",
    ];

    for (const field of requiredFields) {
      if (!config[field]) {
        throw new Error(`配置缺少必需字段: ${field}`);
      }
    }

    return config;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[AgentRun MCP] 加载配置失败: ${message}`);
    console.error(`[AgentRun MCP] 请确保配置文件存在于: ${configPath}`);
    console.error(
      `[AgentRun MCP] 或设置环境变量 AGENTRUN_CONFIG 指向配置文件路径`
    );
    process.exit(1);
  }
}

/**
 * 创建 MCP Server 实例
 */
function createMcpServer(client: AgentRunClient): Server {
  const server = new Server(
    {
      name: "agentrun-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        createExecuteCodeTool(client),
        createInstallPackagesTool(client),
        createSandboxStatusTool(client),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "execute_code":
        return {
          content: [
            {
              type: "text",
              text: await createExecuteCodeHandler(client)(args as never),
            },
          ],
        };

      case "install_packages":
        return {
          content: [
            {
              type: "text",
              text: await createInstallPackagesHandler(client)(args as never),
            },
          ],
        };

      case "sandbox_status":
        return {
          content: [
            {
              type: "text",
              text: await createSandboxStatusHandler(client)(args as never),
            },
          ],
        };

      default:
        throw new Error(`未知工具: ${name}`);
    }
  });

  return server;
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const client = new AgentRunClient(config);

  // 创建 Express 应用（绑定 0.0.0.0 以支持 Docker）
  const app = createMcpExpressApp({ host: "0.0.0.0" });

  // Session -> Transport 映射
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // MCP 端点处理器
  const mcpHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId) {
      console.log(`[AgentRun MCP] ${req.method} /mcp session=${sessionId}`);
    } else {
      console.log(`[AgentRun MCP] ${req.method} /mcp (init)`);
    }

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        // 复用已有 transport
        transport = transports[sessionId];
      } else if (
        !sessionId &&
        req.method === "POST" &&
        isInitializeRequest(req.body)
      ) {
        // 新会话初始化
        const eventStore = new InMemoryEventStore();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          eventStore, // 启用断点续传
          onsessioninitialized: (sid: string) => {
            console.log(`[AgentRun MCP] Session initialized: ${sid}`);
            transports[sid] = transport;
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            console.log(`[AgentRun MCP] Transport closed: ${sid}`);
            delete transports[sid];
          }
        };

        const server = createMcpServer(client);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        // 无效请求
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        });
        return;
      }

      // 使用已有 transport 处理请求
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[AgentRun MCP] Error handling request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  };

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  app.all("/mcp", mcpHandler);

  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[AgentRun MCP] HTTP Server listening on 0.0.0.0:${PORT}`);
  });

  // 优雅关闭
  const shutdown = async (): Promise<void> => {
    console.error("[AgentRun MCP] 正在关闭...");
    await client.cleanup();
    for (const sid in transports) {
      try {
        await transports[sid].close();
      } catch {
        // ignore
      }
      delete transports[sid];
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: Error) => {
  console.error("[AgentRun MCP] 启动失败:", err);
  process.exit(1);
});

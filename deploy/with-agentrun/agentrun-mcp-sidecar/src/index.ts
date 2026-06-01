#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 加载配置文件
 */
function loadConfig(): AgentRunConfig {
  const configPath =
    process.env.AGENTRUN_CONFIG ||
    resolve(__dirname, "..", "config.json");

  try {
    const content = readFileSync(configPath, "utf-8");
    const config = JSON.parse(content) as AgentRunConfig;

    // 验证必需字段
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
    console.error(
      `[AgentRun MCP] 请确保配置文件存在于: ${configPath}`
    );
    console.error(
      `[AgentRun MCP] 或设置环境变量 AGENTRUN_CONFIG 指向配置文件路径`
    );
    process.exit(1);
  }
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  // 加载配置
  const config = loadConfig();

  // 创建 AgentRun 客户端
  const client = new AgentRunClient(config);

  // 创建 MCP Server
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

  // 注册工具列表处理器
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        createExecuteCodeTool(client),
        createInstallPackagesTool(client),
        createSandboxStatusTool(client),
      ],
    };
  });

  // 注册工具调用处理器
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

  // 优雅关闭处理
  const shutdown = async (): Promise<void> => {
    console.error("[AgentRun MCP] 正在关闭...");
    await client.cleanup();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 启动 stdio 传输
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[AgentRun MCP] Server 已启动");
}

// 启动服务器
main().catch((err: Error) => {
  console.error("[AgentRun MCP] 启动失败:", err);
  process.exit(1);
});

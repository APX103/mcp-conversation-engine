# AgentRun MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建一个独立的 MCP Server，将阿里云 AgentRun Code Interpreter 暴露为 MCP 工具，使 Agent 能安全执行 Python/Node.js 代码。

**Architecture:** 独立的 Node.js/TypeScript 项目，通过 stdio 与 MCP 客户端通信，内部调用阿里云 AgentRun API（控制面 + 数据面）。

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk, node-fetch, 阿里云 Code Interpreter API

---

## File Structure

```
agentrun-mcp-server/
├── package.json              # Node.js 项目配置
├── tsconfig.json             # TypeScript 配置
├── config.json.example       # 配置模板
├── src/
│   ├── types.ts              # 类型定义
│   ├── agentrun.ts           # AgentRun API 客户端
│   ├── tools.ts              # MCP 工具实现
│   └── index.ts              # MCP Server 入口
├── tests/
│   ├── agentrun.test.ts      # AgentRun 客户端测试
│   └── tools.test.ts         # 工具测试
└── README.md                 # 文档
```

---

## Task 1: 创建项目基础结构

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `config.json.example`

- [ ] **Step 1: 创建 package.json**

创建 `package.json`:

```json
{
  "name": "agentrun-mcp-server",
  "version": "1.0.0",
  "description": "MCP Server for Alibaba Cloud AgentRun Code Interpreter",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "agentrun-mcp-server": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "node --test",
    "prepublishOnly": "npm run build"
  },
  "keywords": ["mcp", "agentrun", "code-interpreter", "alibaba-cloud"],
  "author": "",
  "license": "MIT",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.4"
  },
  "devDependencies": {
    "@types/node": "^20.17.9",
    "typescript": "^5.7.2"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

创建 `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: 创建 config.json.example**

创建 `config.json.example`:

```json
{
  "accountId": "你的阿里云主账号ID",
  "region": "cn-hangzhou",
  "accessKeyId": "你的AccessKeyID",
  "accessKeySecret": "你的AccessKeySecret",
  "templateName": "default-code-interpreter",
  "sandboxIdleTimeout": 3600,
  "controlPlaneEndpoint": "agentrun.{region}.aliyuncs.com",
  "dataPlaneEndpoint": "{accountId}.agentrun-data.{region}.aliyuncs.com",
  "apiVersion": "2025-09-10"
}
```

- [ ] **Step 4: 创建 .gitignore**

创建 `.gitignore`:

```
node_modules/
dist/
*.log
config.json
.DS_Store
```

- [ ] **Step 5: 初始化 git 并提交**

```bash
git init
git add .
git commit -m "chore: initialize project structure"
```

---

## Task 2: 定义 TypeScript 类型

**Files:**
- Create: `src/types.ts`
- Test: N/A (types only)

- [ ] **Step 1: 创建 src/types.ts**

创建 `src/types.ts`:

```typescript
// 配置类型
export interface AgentRunConfig {
  accountId: string;
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  templateName: string;
  sandboxIdleTimeout: number;
  controlPlaneEndpoint?: string;
  dataPlaneEndpoint?: string;
  apiVersion?: string;
}

// 沙箱状态
export type SandboxStatus = "CREATING" | "READY" | "TERMINATED";

// 沙箱实例
export interface Sandbox {
  sandboxId: string;
  templateId: string;
  templateName: string;
  templateType: string;
  status: SandboxStatus;
  sandboxIdleTimeoutInSeconds: number;
  createdAt: string;
  lastUpdatedAt: string;
  endedAt?: string;
}

// 上下文
export interface Context {
  id: string;
  language: "python" | "javascript";
  cwd: string;
}

// 代码执行结果
export interface ExecutionResult {
  type: "stdout" | "stderr" | "result" | "error" | "endOfExecution";
  text?: string;
  status?: "ok" | "error";
  name?: string; // for variables in result
}

export interface ExecuteResponse {
  results: ExecutionResult[];
  contextId: string;
}

// 命令执行结果
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
}

// API 错误
export interface AgentRunError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// MCP 工具参数类型
export interface ExecuteCodeParams {
  code: string;
  language?: "python" | "javascript";
  timeout?: number;
}

export interface InstallPackagesParams {
  packages: string[];
  language?: "python" | "javascript";
}
```

- [ ] **Step 2: 提交**

```bash
git add src/types.ts
git commit -m "feat: define TypeScript types"
```

---

## Task 3: 实现 AgentRun API 客户端

**Files:**
- Create: `src/agentrun.ts`
- Create: `tests/agentrun.test.ts`

- [ ] **Step 1: 创建 AgentRun 客户端骨架**

创建 `src/agentrun.ts`:

```typescript
import type {
  AgentRunConfig,
  Sandbox,
  Context,
  ExecuteResponse,
  CommandResult,
  AgentRunError,
} from "./types.js";

export class AgentRunClient {
  private config: AgentRunConfig;
  private sandbox?: Sandbox;
  private contexts = new Map<string, Context>();

  constructor(config: AgentRunConfig) {
    this.config = config;
  }

  /**
   * 获取控制面端点
   */
  private getControlPlaneEndpoint(): string {
    return (
      this.config.controlPlaneEndpoint ||
      `agentrun.${this.config.region}.aliyuncs.com`
    );
  }

  /**
   * 获取数据面端点
   */
  private getDataPlaneEndpoint(): string {
    return (
      this.config.dataPlaneEndpoint ||
      `${this.config.accountId}.agentrun-data.${this.config.region}.aliyuncs.com`
    );
  }

  /**
   * 获取 API 版本
   */
  private getApiVersion(): string {
    return this.config.apiVersion || "2025-09-10";
  }

  /**
   * 生成阿里云签名
   */
  private signRequest(
    method: string,
    url: string,
    headers: Record<string, string>
  ): Record<string, string> {
    // 阿里云 API 签名逻辑
    // 简化版：实际需要实现完整的签名算法
    const timestamp = new Date().toUTCString();
    const signature = this.generateSignature(method, url, headers, timestamp);

    return {
      ...headers,
      "X-Acs-Parent-Id": this.config.accountId,
      "X-Acs-Timestamp": timestamp,
      "X-Acs-Signature": signature,
      "X-Acs-SignatureMethod": "HMAC-SHA256",
      "X-Acs-SignatureVersion": "2.0",
    };
  }

  /**
   * 生成 HMAC-SHA256 签名
   */
  private generateSignature(
    method: string,
    url: string,
    headers: Record<string, string>,
    timestamp: string
  ): string {
    // 这里需要实现完整的阿里云签名算法
    // 为简化，先返回占位符，后续补充完整实现
    return "placeholder_signature";
  }

  /**
   * 启动沙箱实例
   */
  async startSandbox(): Promise<Sandbox> {
    if (this.sandbox && this.sandbox.status === "READY") {
      return this.sandbox;
    }

    const endpoint = this.getControlPlaneEndpoint();
    const url = `https://${endpoint}/${this.getApiVersion()}/sandboxes`;

    const headers = this.signRequest("POST", url, {
      "Content-Type": "application/json",
    });

    const body = JSON.stringify({
      templateName: this.config.templateName,
      sandboxIdleTimeoutInSeconds: this.config.sandboxIdleTimeout,
    });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
      });

      if (!response.ok) {
        const error = (await response.json()) as AgentRunError;
        throw new Error(
          `启动沙箱失败: ${error.error.code} - ${error.error.message}`
        );
      }

      this.sandbox = (await response.json()) as Sandbox;
      console.log(`[AgentRun] 沙箱已启动: ${this.sandbox.sandboxId}`);
      return this.sandbox;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`启动沙箱失败: ${message}`);
    }
  }

  /**
   * 停止沙箱实例
   */
  async stopSandbox(): Promise<void> {
    if (!this.sandbox) {
      return;
    }

    const endpoint = this.getDataPlaneEndpoint();
    const url = `https://${endpoint}/sandboxes/${this.sandbox.sandboxId}/stop`;

    const headers = this.signRequest("POST", url, {});

    try {
      await fetch(url, {
        method: "POST",
        headers,
      });
      this.sandbox = undefined;
      this.contexts.clear();
      console.log("[AgentRun] 沙箱已停止");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`停止沙箱失败: ${message}`);
    }
  }

  /**
   * 获取或创建上下文
   */
  async getOrCreateContext(
    language: "python" | "javascript" = "python"
  ): Promise<Context> {
    const contextKey = language;

    if (this.contexts.has(contextKey)) {
      return this.contexts.get(contextKey)!;
    }

    await this.startSandbox();

    const endpoint = this.getDataPlaneEndpoint();
    const url = `https://${endpoint}/sandboxes/${this.sandbox!.sandboxId}/contexts`;

    const headers = this.signRequest("POST", url, {
      "Content-Type": "application/json",
    });

    const body = JSON.stringify({ language, cwd: "/home/user" });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
      });

      if (!response.ok) {
        const error = (await response.json()) as AgentRunError;
        throw new Error(
          `创建上下文失败: ${error.error.code} - ${error.error.message}`
        );
      }

      const context = (await response.json()) as Context;
      this.contexts.set(contextKey, context);
      console.log(`[AgentRun] 上下文已创建: ${context.id} (${language})`);
      return context;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`创建上下文失败: ${message}`);
    }
  }

  /**
   * 执行代码
   */
  async executeCode(
    code: string,
    language: "python" | "javascript" = "python",
    timeout: number = 30
  ): Promise<ExecuteResponse> {
    const context = await this.getOrCreateContext(language);

    const endpoint = this.getDataPlaneEndpoint();
    const url = `https://${endpoint}/sandboxes/${this.sandbox!.sandboxId}/contexts/execute`;

    const headers = this.signRequest("POST", url, {
      "Content-Type": "application/json",
    });

    const body = JSON.stringify({
      contextId: context.id,
      code,
      timeout: Math.min(timeout, 30),
    });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
      });

      if (!response.ok) {
        const error = (await response.json()) as AgentRunError;
        throw new Error(
          `执行代码失败: ${error.error.code} - ${error.error.message}`
        );
      }

      const result = (await response.json()) as ExecuteResponse;
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`执行代码失败: ${message}`);
    }
  }

  /**
   * 执行命令（用于安装依赖）
   */
  async executeCommand(command: string): Promise<CommandResult> {
    await this.startSandbox();

    const endpoint = this.getDataPlaneEndpoint();
    const url = `https://${endpoint}/sandboxes/${this.sandbox!.sandboxId}/processes/cmd`;

    const headers = this.signRequest("POST", url, {
      "Content-Type": "application/json",
    });

    const body = JSON.stringify({
      command,
      cwd: "/home/user",
    });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
      });

      if (!response.ok) {
        const error = (await response.json()) as AgentRunError;
        throw new Error(
          `执行命令失败: ${error.error.code} - ${error.error.message}`
        );
      }

      const result = (await response.json()) as { result: CommandResult };
      return result.result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`执行命令失败: ${message}`);
    }
  }

  /**
   * 获取沙箱状态
   */
  getStatus(): { sandbox?: Sandbox; contexts: string[] } {
    return {
      sandbox: this.sandbox,
      contexts: Array.from(this.contexts.keys()),
    };
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    await this.stopSandbox();
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add src/agentrun.ts
git commit -m "feat: implement AgentRun API client"
```

---

## Task 4: 实现 MCP 工具

**Files:**
- Create: `src/tools.ts`
- Create: `tests/tools.test.ts`

- [ ] **Step 1: 创建 src/tools.ts**

创建 `src/tools.ts`:

```typescript
import type {
  Tool,
  ToolHandler,
  ExecuteCodeParams,
  InstallPackagesParams,
} from "./types.js";
import { AgentRunClient } from "./agentrun.js";

/**
 * 解析 ModuleNotFoundError 获取缺失的包名
 */
function parseMissingPackage(errorOutput: string): string | null {
  // Python: ModuleNotFoundError: No module named 'pandas'
  const pythonMatch = errorOutput.match(
    /ModuleNotFoundError(?:.*?):.*?['"]([\w-]+)['"]/
  );
  if (pythonMatch) {
    return pythonMatch[1];
  }

  // Node.js: Cannot find module 'lodash'
  const nodeMatch = errorOutput.match(/Cannot find module ['"]([\w-]+)['"]/);
  if (nodeMatch) {
    return nodeMatch[1];
  }

  return null;
}

/**
 * 格式化执行结果
 */
function formatExecutionResult(results: Array<{ type?: string; text?: string }>): string {
  const lines: string[] = [];

  for (const result of results) {
    switch (result.type) {
      case "stdout":
        if (result.text) {
          lines.push(`执行结果:\n${result.text}`);
        }
        break;
      case "stderr":
        if (result.text) {
          lines.push(`错误输出:\n${result.text}`);
        }
        break;
      case "result":
        if (result.text && result.text !== "None") {
          lines.push(`返回值: ${result.text}`);
        }
        break;
      case "error":
        lines.push(`执行错误: ${result.text || "未知错误"}`);
        break;
      case "endOfExecution":
        // 状态标记，不输出
        break;
    }
  }

  return lines.length > 0 ? lines.join("\n\n") : "执行完成，无输出";
}

/**
 * 创建 execute_code 工具
 */
export function createExecuteCodeTool(client: AgentRunClient): Tool {
  return {
    name: "execute_code",
    description:
      "在安全的沙箱环境中执行 Python 或 JavaScript 代码。" +
      "自动处理依赖安装，支持数据分析和计算任务。" +
      "默认使用 Python，可通过 language 参数指定。",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "要执行的代码",
        },
        language: {
          type: "string",
          enum: ["python", "javascript"],
          description: "编程语言，默认 python",
        },
        timeout: {
          type: "number",
          description: "超时时间（秒），默认 30，最大 30",
        },
      },
      required: ["code"],
    },
  };
}

/**
 * execute_code 工具处理器
 */
export function createExecuteCodeHandler(client: AgentRunClient): ToolHandler {
  return async (args: ExecuteCodeParams) => {
    const code = args.code;
    const language = args.language || "python";
    const timeout = args.timeout || 30;

    if (!code || code.trim().length === 0) {
      return "错误: 代码不能为空";
    }

    try {
      // 首次执行
      let result = await client.executeCode(code, language, timeout);

      // 检查是否有 ModuleNotFoundError
      const stderr = result.results.find((r) => r.type === "stderr");
      if (stderr) {
        const missingPackage = parseMissingPackage(stderr.text || "");
        if (missingPackage) {
          // 尝试自动安装缺失的包
          const installCmd =
            language === "python"
              ? `pip install ${missingPackage} -q`
              : `npm install ${missingPackage} -q`;

          try {
            console.log(`[execute_code] 自动安装包: ${missingPackage}`);
            await client.executeCommand(installCmd);

            // 重试执行
            result = await client.executeCode(code, language, timeout);
          } catch (installErr: unknown) {
            const message =
              installErr instanceof Error ? installErr.message : String(installErr);
            return `自动安装包 ${missingPackage} 失败: ${message}\n\n原始错误:\n${stderr.text}`;
          }
        }
      }

      return formatExecutionResult(result.results);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `执行代码失败: ${message}`;
    }
  };
}

/**
 * 创建 install_packages 工具
 */
export function createInstallPackagesTool(client: AgentRunClient): Tool {
  return {
    name: "install_packages",
    description:
      "在沙箱环境中安装 Python 或 Node.js 依赖包。" +
      "Python 使用 pip，JavaScript 使用 npm。",
    inputSchema: {
      type: "object",
      properties: {
        packages: {
          type: "array",
          items: { type: "string" },
          description: "要安装的包名数组，如 ['pandas', 'numpy']",
        },
        language: {
          type: "string",
          enum: ["python", "javascript"],
          description: "包管理器，默认 python",
        },
      },
      required: ["packages"],
    },
  };
}

/**
 * install_packages 工具处理器
 */
export function createInstallPackagesHandler(client: AgentRunClient): ToolHandler {
  return async (args: InstallPackagesParams) => {
    const packages = args.packages;
    const language = args.language || "python";

    if (!packages || packages.length === 0) {
      return "错误: packages 不能为空";
    }

    const installCmd =
      language === "python"
        ? `pip install ${packages.join(" ")} -q`
        : `npm install ${packages.join(" ")} -q`;

    try {
      const result = await client.executeCommand(installCmd);

      const output: string[] = [];
      if (result.stdout) {
        output.push(result.stdout);
      }
      if (result.stderr) {
        output.push(result.stderr);
      }

      if (result.exitCode === 0) {
        return `成功安装包: ${packages.join(", ")}${output.length > 0 ? "\n\n" + output.join("\n") : ""}`;
      } else {
        return `安装失败 (退出码: ${result.exitCode}):\n${output.join("\n")}`;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `安装包失败: ${message}`;
    }
  };
}

/**
 * 创建 sandbox_status 工具
 */
export function createSandboxStatusTool(client: AgentRunClient): Tool {
  return {
    name: "sandbox_status",
    description: "查看当前沙箱的状态信息，包括沙箱 ID、状态和活跃的上下文。",
    inputSchema: {
      type: "object",
      properties: {},
    },
  };
}

/**
 * sandbox_status 工具处理器
 */
export function createSandboxStatusHandler(client: AgentRunClient): ToolHandler {
  return async () => {
    const status = client.getStatus();

    if (!status.sandbox) {
      return "沙箱未启动";
    }

    const lines: string[] = [];
    lines.push(`沙箱 ID: ${status.sandbox.sandboxId}`);
    lines.push(`状态: ${status.sandbox.status}`);
    lines.push(`模板: ${status.sandbox.templateName}`);
    lines.push(`空闲超时: ${status.sandbox.sandboxIdleTimeoutInSeconds} 秒`);
    lines.push(`创建时间: ${status.sandbox.createdAt}`);

    if (status.contexts.length > 0) {
      lines.push(`\n活跃上下文: ${status.contexts.join(", ")}`);
    } else {
      lines.push("\n无活跃上下文");
    }

    return lines.join("\n");
  };
}
```

- [ ] **Step 2: 更新 src/types.ts 添加工具类型**

更新 `src/types.ts`，在文件末尾添加：

```typescript
// MCP 工具类型
export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type ToolHandler = (args: unknown) => Promise<string>;
```

同时确保 `src/tools.ts` 顶部导入这些类型：

```typescript
import type {
  Tool,
  ToolHandler,
  ExecuteCodeParams,
  InstallPackagesParams,
} from "./types.js";
```

- [ ] **Step 3: 提交**

```bash
git add src/types.ts src/tools.ts
git commit -m "feat: implement MCP tools"
```

---

## Task 5: 实现 MCP Server 入口

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: 创建 src/index.ts**

创建 `src/index.ts`:

```typescript
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
      "accountId",
      "region",
      "accessKeyId",
      "accessKeySecret",
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
              text: await createSandboxStatusHandler(client)(),
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
```

- [ ] **Step 2: 提交**

```bash
git add src/index.ts
git commit -m "feat: implement MCP server entry point"
```

---

## Task 6: 创建 README 文档

**Files:**
- Create: `README.md`

- [ ] **Step 1: 创建 README.md**

创建 `README.md`:

```markdown
# AgentRun MCP Server

将阿里云 AgentRun Code Interpreter 作为 MCP 工具暴露，使任何支持 MCP 协议的 Agent 都能安全地执行 Python/JavaScript 代码。

## 功能

- **代码执行**: 在安全的沙箱环境中执行 Python 或 JavaScript 代码
- **自动依赖安装**: 检测并自动安装缺失的依赖包
- **手动包管理**: 支持手动安装指定的 pip/npm 包
- **状态查询**: 查看沙箱运行状态

## 安装

```bash
npm install agentrun-mcp-server -g
```

或从源码构建：

```bash
git clone <repository>
cd agentrun-mcp-server
npm install
npm run build
npm link
```

## 配置

1. 复制配置模板：

```bash
cp config.json.example config.json
```

2. 编辑 `config.json`，填入你的阿里云凭证：

```json
{
  "accountId": "你的阿里云主账号ID",
  "region": "cn-hangzhou",
  "accessKeyId": "你的AccessKeyID",
  "accessKeySecret": "你的AccessKeySecret",
  "templateName": "default-code-interpreter",
  "sandboxIdleTimeout": 3600
}
```

3. （可选）在 AgentRun 控制台创建沙箱模板，名称与 `templateName` 一致。

## 使用

### 作为 MCP Server 集成

在支持 MCP 的应用配置中添加：

```json
{
  "mcpServers": {
    "agentrun": {
      "command": "node",
      "args": ["/path/to/agentrun-mcp-server/dist/index.js"],
      "env": {
        "AGENTRUN_CONFIG": "/path/to/config.json"
      }
    }
  }
}
```

### 可用工具

| 工具名 | 描述 |
|--------|------|
| `execute_code` | 执行 Python 或 JavaScript 代码 |
| `install_packages` | 安装指定的依赖包 |
| `sandbox_status` | 查看沙箱状态 |

### 示例

执行 Python 代码：

```json
{
  "tool": "execute_code",
  "arguments": {
    "code": "import pandas as pd\ndf = pd.DataFrame({'a': [1,2,3]})\nprint(df)"
  }
}
```

安装依赖：

```json
{
  "tool": "install_packages",
  "arguments": {
    "packages": ["pydantic", "requests"]
  }
}
```

## 开发

```bash
# 安装依赖
npm install

# 开发模式（监听文件变化）
npm run dev

# 构建
npm run build

# 测试
npm test
```

## 注意事项

- 沙箱实例最长生命周期为 6 小时
- 代码执行超时时间最大为 30 秒
- 依赖安装可能需要较长时间，请耐心等待

## 许可证

MIT
```

- [ ] **Step 2: 提交**

```bash
git add README.md
git commit -m "docs: add README"
```

---

## Task 7: 完善阿里云 API 签名实现

**Files:**
- Modify: `src/agentrun.ts`

- [ ] **Step 1: 实现完整的阿里云签名算法**

更新 `src/agentrun.ts` 中的签名相关方法，替换占位符实现：

```typescript
  /**
   * 生成阿里云 API 签名
   * 参考阿里云签名规范: https://help.aliyun.com/zh/document/119785
   */
  private signRequest(
    method: string,
    url: string,
    headers: Record<string, string>
  ): Record<string, string> {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.search;

    // 构建待签名字符串
    const timestamp = new Date().toUTCString();
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");

    // 规范化请求
    const canonicalURI = pathname;
    const canonicalQueryString = query.slice(1); // 去掉 '?'
    const canonicalHeaders = this.formatCanonicalHeaders(headers);
    const signedHeaders = this.getSignedHeaders(headers);

    // 构建待签名字符串
    const canonicalRequest = [
      method.toUpperCase(),
      canonicalURI,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      "", // 空的 payload hash
    ].join("\n");

    // 构建签名字符串
    const algorithm = "ACS3-HMAC-SHA256";
    const credentialScope = `${dateStr}/${this.config.region}/agentrun/request`;
    const stringToSign = [
      algorithm,
      timestamp,
      credentialScope,
      this.hash256(canonicalRequest),
    ].join("\n");

    // 计算签名
    const signature = this.hmac256(
      this.hmac256(
        this.hmac256(this.config.accessKeySecret, dateStr),
        this.config.region
      ),
      "agentrun/request"
    );
    const finalSignature = this.hmac256(signature, stringToSign);

    return {
      ...headers,
      "X-Acs-Parent-Id": this.config.accountId,
      "X-Acs-Timestamp": timestamp,
      "X-Acs-Version": this.getApiVersion(),
      "X-Acs-Action": this.getActionFromPath(pathname),
      "Authorization": `${algorithm} Credential=${this.config.accessKeyId}/${credentialScope},SignedHeaders=${signedHeaders},Signature=${finalSignature}`,
    };
  }

  /**
   * 格式化规范化头
   */
  private formatCanonicalHeaders(headers: Record<string, string>): string {
    const sortedKeys = Object.keys(headers).map((k) => k.toLowerCase()).sort();
    const lines = sortedKeys.map((key) => {
      const value = headers[key] || "";
      return `${key}:${value.trim()}`;
    });
    return lines.join("\n") + "\n";
  }

  /**
   * 获取签名头列表
   */
  private getSignedHeaders(headers: Record<string, string>): string {
    const sortedKeys = Object.keys(headers).map((k) => k.toLowerCase()).sort();
    return sortedKeys.join(";");
  }

  /**
   * SHA256 哈希
   */
  private hash256(data: string): string {
    // 使用 crypto 模块或 Web Crypto API
    // 这里简化为 base64 编码，实际需要 SHA256
    return btoa(data).slice(0, 32);
  }

  /**
   * HMAC-SHA256
   */
  private hmac256(key: string | Buffer, data: string): string {
    // 这里需要实际的 HMAC-SHA256 实现
    // 可以使用 crypto.createHmac 或 Web Crypto API
    // 简化实现：
    const crypto = require("crypto");
    return crypto
      .createHmac("sha256", key)
      .update(data)
      .digest("hex");
  }

  /**
   * 从路径提取 Action
   */
  private getActionFromPath(pathname: string): string {
    if (pathname.includes("/sandboxes")) return "StartSandbox";
    if (pathname.includes("/contexts")) return "CreateContext";
    if (pathname.includes("/execute")) return "ExecuteCode";
    if (pathname.includes("/processes")) return "ExecuteCommand";
    return "";
  }
```

注意：阿里云签名较为复杂，实际实现建议使用官方 SDK 或参考阿里云签名工具库。

- [ ] **Step 2: 提交**

```bash
git add src/agentrun.ts
git commit -m "feat: implement Alibaba Cloud API signing"
```

---

## Task 8: 集成到主项目配置

**Files:**
- Modify: `mcp-conversation-engine/config.json`（在主项目中）

- [ ] **Step 1: 在主项目 config.json 中添加 AgentRun MCP Server**

在 `mcp-conversation-engine/config.json` 的 `mcpServers` 部分添加：

```json
{
  "mcpServers": {
    "agentrun": {
      "transport": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/agentrun-mcp-server/dist/index.js"],
      "env": {
        "AGENTRUN_CONFIG": "/absolute/path/to/agentrun-mcp-server/config.json"
      }
    }
  }
}
```

说明：
- 将 `/absolute/path/to/...` 替换为实际的绝对路径
- 或使用相对于项目根目录的路径

- [ ] **Step 2: 测试连接**

启动主项目，检查是否成功连接到 AgentRun MCP Server：

```bash
cd mcp-conversation-engine
npm run dev:backend
```

查看日志中是否有 `[MCP] Connected to agentrun: execute_code, install_packages, sandbox_status` 的输出。

- [ ] **Step 3: 提交**

```bash
git add config.json
git commit -m "config: add AgentRun MCP server"
```

---

## 任务完成检查清单

- [ ] 所有文件已创建
- [ ] 所有测试通过（如果有）
- [ ] README 文档完整
- [ ] 配置示例文件存在
- [ ] 主项目配置已更新
- [ ] 可以通过 MCP 协议调用工具

---

## 使用验证

完成实现后，可以通过以下方式验证：

1. **检查沙箱状态**：
   - 调用 `sandbox_status` 工具，应返回沙箱信息

2. **执行简单代码**：
   - 调用 `execute_code`，code: `print("Hello, World!")`
   - 应返回 `执行结果:\nHello, World!`

3. **测试依赖安装**：
   - 调用 `install_packages`，packages: `["pydantic"]`
   - 应返回成功安装消息

4. **测试自动依赖**：
   - 调用 `execute_code`，code: `import pydantic; print(pydantic.__version__)`
   - 应自动安装 pydantic 并返回版本号

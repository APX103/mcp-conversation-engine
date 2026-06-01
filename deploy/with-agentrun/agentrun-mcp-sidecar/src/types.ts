// 配置类型
export interface AgentRunConfig {
  apiKey: string;
  accountId: string; // 阿里云主账号ID，用于构造数据面端点和认证头
  region: string;
  templateName: string;
  sandboxIdleTimeout: number;
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
  code: string;
  message: string;
  requestId?: string;
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

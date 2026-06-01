import type {
  AgentRunConfig,
  Sandbox,
  Context,
  ExecuteResponse,
  CommandResult,
  AgentRunError,
} from "./types.js";

/**
 * 解析 API 错误响应（兼容两种格式）
 */
function parseApiError(body: unknown): { code: string; message: string } {
  const data = body as Record<string, unknown>;
  if (data.error && typeof data.error === "object") {
    const err = data.error as Record<string, string>;
    return { code: err.code || "Unknown", message: err.message || "Unknown error" };
  }
  return {
    code: (data.code as string) || "Unknown",
    message: (data.message as string) || "Unknown error",
  };
}

/**
 * AgentRun API 客户端
 * 使用 API Key 认证方式调用阿里云 AgentRun 服务
 */
export class AgentRunClient {
  private config: AgentRunConfig;
  private sandbox?: Sandbox;
  private contexts = new Map<string, Context>();

  constructor(config: AgentRunConfig) {
    this.config = config;
  }

  /**
   * 获取认证头
   */
  private getAuthHeaders(): Record<string, string> {
    return {
      "X-API-Key": this.config.apiKey,
      "Content-Type": "application/json",
      "X-Acs-Parent-Id": this.config.accountId,
    };
  }

  /**
   * 获取控制面端点
   */
  private getControlPlaneEndpoint(): string {
    return `agentrun.${this.config.region}.aliyuncs.com`;
  }

  /**
   * 获取数据面端点
   */
  private getDataPlaneEndpoint(): string {
    return this.config.dataPlaneEndpoint ||
      `${this.config.accountId}.agentrun-data.${this.config.region}.aliyuncs.com`;
  }

  /**
   * 获取 API 版本
   */
  private getApiVersion(): string {
    return this.config.apiVersion || "2025-09-10";
  }

  /**
   * 启动沙箱实例
   */
  async startSandbox(): Promise<Sandbox> {
    if (this.sandbox && this.sandbox.status === "READY") {
      return this.sandbox;
    }

    const endpoint = this.getDataPlaneEndpoint();
    const url = `https://${endpoint}/sandboxes`;

    const headers = this.getAuthHeaders();

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
        const error = parseApiError(await response.json());
        throw new Error(
          `启动沙箱失败: ${error.code} - ${error.message}`
        );
      }

      const result = (await response.json()) as { data: Sandbox };
      this.sandbox = result.data;
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

    const headers = this.getAuthHeaders();

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

    const headers = this.getAuthHeaders();

    const body = JSON.stringify({ language, cwd: "/home/user" });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
      });

      if (!response.ok) {
        const error = parseApiError(await response.json());
        throw new Error(
          `创建上下文失败: ${error.code} - ${error.message}`
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

    const headers = this.getAuthHeaders();

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
        const error = parseApiError(await response.json());
        throw new Error(
          `执行代码失败: ${error.code} - ${error.message}`
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

    const headers = this.getAuthHeaders();

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
        const error = parseApiError(await response.json());
        throw new Error(
          `执行命令失败: ${error.code} - ${error.message}`
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

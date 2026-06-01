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
 * 导入名到安装包名的映射（常见别名修正）
 */
const PACKAGE_NAME_MAP: Record<string, string> = {
  sklearn: "scikit-learn",
  PIL: "Pillow",
  cv2: "opencv-python",
  bs4: "beautifulsoup4",
  yaml: "PyYAML",
  jwt: "PyJWT",
  dotenv: "python-dotenv",
};

function resolvePackageName(name: string): string {
  return PACKAGE_NAME_MAP[name] || name;
}

/**
 * 格式化执行结果
 */
function formatExecutionResult(results: Array<{ type?: string; text?: string; data?: Record<string, unknown> }>): string {
  const lines: string[] = [];

  for (const result of results) {
    switch (result.type) {
      case "stdout":
        if (result.text) {
          lines.push(result.text);
        }
        break;
      case "stderr":
        if (result.text) {
          lines.push(`错误输出:\n${result.text}`);
        }
        break;
      case "result":
        if (result.data) {
          // 处理不同格式的返回值
          const plainText = result.data["text/plain"];
          if (typeof plainText === "string") {
            lines.push(plainText);
          } else {
            lines.push(JSON.stringify(result.data));
          }
        } else if (result.text && result.text !== "None") {
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

  return lines.length > 0 ? lines.join("\n") : "执行完成，无输出";
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
  return async (args: unknown) => {
    const params = args as ExecuteCodeParams;
    const code = params.code;
    const language = params.language || "python";
    const timeout = params.timeout || 30;

    if (!code || code.trim().length === 0) {
      return "错误: 代码不能为空";
    }

    try {
      // 首次执行
      let result = await client.executeCode(code, language, timeout);

      // 检查是否有 ModuleNotFoundError（可能出现在 stderr 或 error 中）
      const errorOutput = result.results.find((r) => r.type === "stderr")?.text
        || result.results.find((r) => r.type === "error")?.text
        || "";
      const missingPackage = parseMissingPackage(errorOutput);
      if (missingPackage) {
        // 尝试自动安装缺失的包（修正常见别名）
        const resolvedPackage = resolvePackageName(missingPackage);
        const installCmd =
          language === "python"
            ? `pip install ${resolvedPackage} -q`
            : `npm install ${resolvedPackage} -q`;

        try {
          console.log(`[execute_code] 自动安装包: ${missingPackage}`);
          await client.executeCommand(installCmd);

          // 重试执行
          result = await client.executeCode(code, language, timeout);
        } catch (installErr: unknown) {
          const message =
            installErr instanceof Error ? installErr.message : String(installErr);
          return `自动安装包 ${missingPackage} 失败: ${message}\n\n原始错误:\n${errorOutput}`;
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
  return async (args: unknown) => {
    const params = args as InstallPackagesParams;
    const packages = params.packages;
    const language = params.language || "python";

    if (!packages || packages.length === 0) {
      return "错误: packages 不能为空";
    }

    const resolvedPackages = packages.map(resolvePackageName);
    const installCmd =
      language === "python"
        ? `pip install ${resolvedPackages.join(" ")} -q`
        : `npm install ${resolvedPackages.join(" ")} -q`;

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

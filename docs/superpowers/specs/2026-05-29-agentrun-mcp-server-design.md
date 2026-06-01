# AgentRun Code Interpreter MCP Server 设计文档

**日期**: 2026-05-29
**状态**: 设计阶段

---

## 概述

创建一个独立的 MCP Server，将阿里云 AgentRun 的 Code Interpreter 能力暴露为 MCP 工具，使任何支持 MCP 协议的 Agent 都能安全地执行 Python/Node.js 代码。

### 目标

1. **隔离性** — AgentRun 认证、配置、错误处理独立于主项目
2. **复用性** — 任何 MCP 兼容的 Agent 都可以使用
3. **易用性** — 自动处理依赖安装，对 Agent 透明
4. **可维护性** — 独立仓库、独立部署、独立版本

---

## 架构

```
┌─────────────────┐      stdio/SSE      ┌──────────────────────────┐
│  mcp-conversation│◄─────────────────────┤  agentrun-mcp-server     │
│  -engine         │                      │  (新建的独立项目)         │
└─────────────────┘                      └──────────────────────────┘
                                                      │
                                                      ▼
                                         ┌──────────────────────────┐
                                         │  AgentRun Code Interpreter│
                                         │  API (阿里云)             │
                                         └──────────────────────────┘
```

### 组件

| 组件 | 职责 |
|------|------|
| `MCP Server` | 实现 MCP 协议，暴露工具给 Agent |
| `AgentRun Client` | 封装 AgentRun API 调用（控制面 + 数据面） |
| `Tool Executor` | 处理工具执行逻辑，包括依赖检测 |
| `Config Manager` | 管理认证信息和沙箱配置 |

---

## MCP 工具定义

### 1. execute_code

执行 Python 或 Node.js 代码，自动处理依赖安装。

**参数**:
```typescript
{
  name: "execute_code",
  parameters: [
    { name: "code", type: "string", required: true, description: "要执行的代码" },
    { name: "language", type: "string", required: false, description: "python 或 javascript，默认 python" },
    { name: "timeout", type: "number", required: false, description: "超时时间（秒），默认 30，最大 30" }
  ]
}
```

**执行流程**:
1. 检查沙箱是否已启动，未启动则调用启动接口
2. （可选）解析 import 语句，检测缺失的依赖
3. 如有缺失依赖，调用 `install_packages` 或 shell 命令安装
4. 调用 AgentRun `/contexts/execute` 执行代码
5. 返回执行结果（stdout/stderr/result）

**返回格式**:
```
执行结果: {stdout 内容}
返回值: {result}
状态: ok/error
```

### 2. install_packages

手动安装指定的 pip/npm 包。

**参数**:
```typescript
{
  name: "install_packages",
  parameters: [
    { name: "packages", type: "array", required: true, description: "包名数组，如 ['pydantic', 'pandas']" },
    { name: "language", type: "string", required: false, description: "python 或 npm，默认 python" }
  ]
}
```

**执行流程**:
1. 调用 AgentRun `/processes/cmd` 执行安装命令
2. Python: `pip install {packages} -q`
3. Node.js: `npm install {packages} -q`
4. 返回安装结果

### 3. sandbox_status

查看当前沙箱状态信息。

**参数**:
```typescript
{
  name: "sandbox_status",
  parameters: []
}
```

**返回信息**:
- 沙箱 ID
- 沙箱状态（CREATING/READY/TERMINATED）
- 上下文列表
- 运行时间

---

## AgentRun API 集成

### 控制面 API（生命周期管理）

| 操作 | 端点 | 说明 |
|------|------|------|
| 创建模板 | `POST /templates` | 一次性操作，创建后可复用 |
| 启动沙箱 | `POST /sandboxes` | 每次会话启动一次 |
| 停止沙箱 | `POST /sandboxes/{id}/stop` | 会话结束时调用 |
| 删除沙箱 | `DELETE /sandboxes/{id}` | 清理资源 |

### 数据面 API（代码执行）

| 操作 | 端点 | 说明 |
|------|------|------|
| 创建上下文 | `POST /sandboxes/{id}/contexts` | 每种语言一个上下文 |
| 执行代码 | `POST /sandboxes/{id}/contexts/execute` | 核心执行接口 |
| 执行命令 | `POST /sandboxes/{id}/processes/cmd` | 用于安装依赖 |

### 认证

- **Header**: `X-Acs-Parent-Id: ${阿里云主账号ID}`
- **签名**: 阿里云 AK/SK 签名（使用 SDK 处理）
- **Region**: 默认 `cn-hangzhou`

---

## 依赖自动安装机制

### 方案一：解析 import 语句

在执行代码前，正则匹配 import 语句，检测常见包：

```typescript
const commonPackages = {
  'pandas': 'pandas',
  'numpy': 'numpy',
  'pydantic': 'pydantic',
  // ...
};

function detectDependencies(code: string): string[] {
  const imports = code.match(/import\s+(\w+)|from\s+(\w+)\s+import/g) || [];
  return imports.flatMap(i => {
    const name = i.match(/(?:import|from)\s+(\w+)/)?.[1];
    return commonPackages[name] ? [commonPackages[name]] : [];
  });
}
```

### 方案二：执行失败时重试

先执行代码，如果报错 `ModuleNotFoundError`，解析错误信息安装包，然后重试。

**建议**: 先实现方案二（更简单），后续可加方案一作为优化。

---

## 项目结构

```
agentrun-mcp-server/
├── package.json
├── config.json.example      # 配置模板
├── config.json              # 实际配置（gitignore）
├── src/
│   ├── index.ts             # MCP server 入口，注册工具
│   ├── agentrun.ts          # AgentRun API 客户端封装
│   ├── tools.ts             # MCP 工具实现
│   └── types.ts             # TypeScript 类型定义
├── README.md
└── tsconfig.json
```

### config.json.example

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

---

## 配置集成（主项目）

在 `mcp-conversation-engine` 的 `config.json` 中添加：

```json
{
  "mcpServers": {
    "agentrun": {
      "transport": "stdio",
      "command": "node",
      "args": ["/path/to/agentrun-mcp-server/dist/index.js"],
      "env": {
        "AGENTRUN_CONFIG": "/path/to/agentrun/config.json"
      }
    }
  }
}
```

---

## 错误处理

| 错误场景 | 处理方式 |
|----------|----------|
| 沙箱启动失败 | 返回错误，建议检查配置 |
| 代码执行超时 | 返回 timeout 错误和已输出的内容 |
| 依赖安装失败 | 返回 pip/npm 错误信息 |
| 沙箱已停止 | 自动重新启动 |
| 认证失败 | 返回 401 错误，建议检查 AK/SK |

---

## 后续扩展（可选）

1. **文件操作工具** — 读写沙箱内的文件
2. **多会话管理** — 支持多个独立的执行上下文
3. **结果缓存** — 缓存常用代码段的执行结果
4. **资源监控** — 监控沙箱的 CPU/内存使用

---

## 参考资料

- [AgentRun 官方文档](https://help.aliyun.com/zh/functioncompute/fc/what-is-agentrun)
- [Code Interpreter API](https://help.aliyun.com/zh/functioncompute/fc/sandbox-sandbox-code-interepreter)
- [AgentRun Python SDK](https://github.com/Serverless-Devs/agentrun-sdk-python)

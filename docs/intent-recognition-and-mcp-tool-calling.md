# 意图识别与 MCP 工具调用机制

## 概述

本项目（mcp-conversation-engine）是一个基于 LLM 的对话引擎，通过 **LLM 原生 Function Calling** 实现意图识别，并集成了 **MCP（Model Context Protocol）** 协议来调用外部工具。

**核心设计思想**：项目没有使用传统的意图分类器（如 NLU 模型、关键词匹配），而是将所有可用工具的描述和参数 schema 交给 LLM，由 LLM 自主判断是否需要调用工具以及调用哪个工具。

---

## 整体架构

```
用户消息
   │
   ▼
┌─────────────────────┐
│   Frontend (React)  │  发送 POST /api/chat
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  ConversationEngine │  核心对话引擎
│   (engine.ts)       │
├─────────────────────┤
│  1. 构建系统提示词   │  包含所有工具名称和描述
│  2. 调用 LLM API    │  附带 tool definitions
│  3. 处理 LLM 响应   │  文本 / 工具调用
│  4. 循环迭代        │  将工具结果喂回 LLM
└────────┬────────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌──────┐  ┌──────────────┐
│内置工具│  │ MCP Manager  │
│tools.ts│ │  (mcp.ts)    │
└──────┘  ├──────────────┤
          │ tool_search  │  stdio / HTTP / SSE
          │ MCP 工具执行  │
          └──────────────┘
```

---

## 一、意图识别机制

### 1.1 没有"意图分类器"

项目不包含任何独立的意图识别模块。意图识别完全依赖 LLM 的 **Function Calling 能力**：

- 系统提示词中列出了所有可用工具的名称和描述
- 工具的完整参数 schema 通过 OpenAI Function Calling 格式传给 LLM
- LLM 根据用户消息的语义，自主决定是否调用工具、调用哪个工具、传什么参数

### 1.2 系统提示词构建

在 [engine.ts:191-201](backend/src/engine.ts#L191-L201) 中，`buildSystemPrompt()` 方法动态构建系统提示词：

```typescript
private buildSystemPrompt(): string {
  const toolNames = this.getTools().map((t) => `- ${t.name}: ${t.description}`).join("\n");
  return `You are a helpful assistant with access to tools...

Available tools:
${toolNames}

When you need to use a tool, use the appropriate function call.
For MCP tools, use tool_search first to get the full parameter schema...`;
}
```

系统提示词包含两个层次的信息：
- **工具摘要**：每个工具的名称和描述，让 LLM 快速了解能力范围
- **使用指引**：告知 LLM 如何正确调用工具（尤其是先用 `tool_search` 查询参数 schema）

### 1.3 工具注册与合并

在 [engine.ts:54-61](backend/src/engine.ts#L54-L61) 中，所有工具被合并为一个统一列表：

```typescript
(this as any)._allTools = () => {
  return [
    ...createBuiltinTools({ getToolSchemas: (pattern) => this.mcp.getFullTools(pattern) }),
    ...this.mcp.getAllTools(),
  ];
};
```

工具列表 = 内置工具（如 `tool_search`）+ 所有 MCP 服务器提供的工具。

### 1.4 工具 Schema 转换

在 [engine.ts:8-33](backend/src/engine.ts#L8-L33) 中，内部 `ToolDef` 格式被转换为 OpenAI Function Calling 格式：

```typescript
function toolDefToOpenAI(tool: ToolDef): OpenAI.ChatCompletionTool {
  const properties: Record<string, any> = {};
  const required: string[] = [];
  for (const p of tool.parameters) {
    properties[p.name] = { type: p.type, description: p.description };
    if (p.required) required.push(p.name);
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: { type: "object", properties, ...(required.length ? { required } : {}) },
    },
  };
}
```

转换后的 schema 随 API 请求发送给 LLM，LLM 据此决定是否发起工具调用。

---

## 二、MCP 工具调用机制

### 2.1 MCP 连接管理

[McpManager](backend/src/mcp.ts) 负责管理所有 MCP 服务器的连接：

**支持两种传输协议**：
- **stdio**：通过子进程启动 MCP 服务器（如示例中的 calculator）
- **HTTP/SSE**：通过 HTTP 连接远程 MCP 服务器（如 web-search-prime）

在 [mcp.ts:47-62](backend/src/mcp.ts#L47-L62) 中根据配置选择传输方式：

```typescript
private async connect(serverName: string, conf: McpServerConfig): Promise<void> {
  if (conf.transport === "http" || conf.transport === "sse") {
    const transport = new StreamableHTTPClientTransport(new URL(conf.url!), ...);
    await this.connectClient(serverName, transport);
    return;
  }
  const transport = new StdioClientTransport({ command: conf.command!, args: conf.args });
  await this.connectClient(serverName, transport);
}
```

### 2.2 工具发现与注册

连接 MCP 服务器后，在 [mcp.ts:72-94](backend/src/mcp.ts#L72-L94) 中：

1. 调用 `client.listTools()` 获取服务器提供的所有工具
2. 将每个 MCP 工具转换为内部 `ToolDef` 格式，名称加上 `mcp__{server}__{tool}` 前缀避免冲突
3. 为每个工具注册执行器（executor），通过 `client.callTool()` 调用

```typescript
const toolsList = await client.listTools();
for (const tool of toolsList.tools) {
  const def = toolDefFromMcp(serverName, tool);  // 名称: mcp__{server}__{tool}

  this.toolExecuteMap.set(fullName, async (args) => {
    const result = await client.callTool({ name: tool.name, arguments: args });
    // 将结果转为文本返回
  });

  this.toolDefs.set(fullName, def);
}
```

### 2.3 工具调用执行流程

在 [engine.ts:77-172](backend/src/engine.ts#L77-L172) 的 `run()` 方法中，工具调用的完整流程如下：

```
用户消息 → 构建 API 请求（含工具定义） → 调用 LLM
                                            │
                                      ┌─────┴─────┐
                                      │  LLM 返回  │
                                      └─────┬─────┘
                                            │
                              ┌─────────────┼─────────────┐
                              ▼             ▼             ▼
                         纯文本响应     工具调用       推理内容
                         → 结束     → 执行并循环    → 展示给用户
```

具体步骤：

1. **LLM 决定调用工具**（第 125-130 行）：检查响应中是否包含 `tool_calls`
2. **发送开始事件**（第 138-143 行）：通过 SSE 发送 `tool_call_start` 事件给前端
3. **执行工具**（第 145 行）：调用 `executeTool()` 方法
4. **发送结果事件**（第 147-152 行）：通过 SSE 发送 `tool_result` 事件
5. **结果回填**（第 154-158 行）：将工具结果以 `role: "tool"` 加入消息历史
6. **继续循环**（第 162 行）：带着工具结果再次调用 LLM，让 LLM 生成最终回复

### 2.4 工具路由

在 [engine.ts:174-189](backend/src/engine.ts#L174-L189) 中，工具执行根据名称前缀路由：

```typescript
private async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  // MCP 工具：名称以 "mcp__" 开头
  if (name.startsWith("mcp__")) {
    return this.mcp.executeTool(name, args);
  }
  // 内置工具：直接执行
  return await tool.execute(args);
}
```

- `mcp__` 前缀的工具 → 委托给 `McpManager`，通过 MCP 协议调用远程工具
- 其他工具 → 直接执行本地 `execute` 函数（如 `tool_search`）

### 2.5 延迟 Schema 查询（tool_search）

项目设计了一个精巧的 `tool_search` 内置工具（[tools.ts:5-23](backend/src/tools.ts#L5-L23)）：

```typescript
{
  name: "tool_search",
  description: "Search available MCP tools by name and get their full parameter schemas...",
  parameters: [{ name: "name", type: "string", ... }],
  async execute(args) {
    const matches = getToolSchemas(args.name);
    return matches.map(t => `${t.name}: ${t.description}\nParameters: ...`).join("\n\n");
  },
}
```

**作用**：LLM 看到系统提示词中的工具列表后，如果不确定某个工具需要什么参数，可以先调用 `tool_search` 查询完整 schema，再发起正式的工具调用。这是一种**延迟加载**策略，减少了初始 API 请求的 payload 大小。

---

## 三、端到端调用示例

以用户说"帮我算一下 (3 + 5) * 2"为例：

```
1. 用户: "帮我算一下 (3 + 5) * 2"
   │
2. ConversationEngine 构建请求:
   ├── 系统提示词（含工具列表）
   │   - tool_search: Search available MCP tools...
   │   - mcp__calculator__add: Add two numbers
   │   - mcp__calculator__multiply: Multiply two numbers
   ├── 用户消息
   └── 工具定义（OpenAI Function Calling 格式）
   │
3. LLM 返回 tool_calls:
   ├── { name: "mcp__calculator__add", arguments: { a: 3, b: 5 } }
   │
4. 执行工具:
   ├── executeTool("mcp__calculator__add", { a: 3, b: 5 })
   │   → McpManager.executeTool()
   │   → client.callTool({ name: "add", arguments: { a: 3, b: 5 } })
   │   → 结果: "8"
   │
5. 将结果回填消息历史，再次调用 LLM:
   ├── LLM 返回 tool_calls:
   │   ├── { name: "mcp__calculator__multiply", arguments: { a: 8, b: 2 } }
   │
6. 执行工具:
   ├── 结果: "16"
   │
7. 再次调用 LLM，生成最终回复:
   └── "(3 + 5) * 2 = 16"
```

---

## 四、关键设计决策

| 决策 | 说明 |
|------|------|
| **LLM 即意图识别器** | 利用 Function Calling 能力，无需独立的 NLU 模块 |
| **延迟 Schema 加载** | 通过 `tool_search` 工具按需查询参数，减少初始请求体积 |
| **工具命名空间** | `mcp__{server}__{tool}` 前缀避免不同服务器的工具名冲突 |
| **循环迭代** | 最多 10 轮工具调用（`MAX_TOOL_ROUNDS`），防止无限循环 |
| **SSE 流式传输** | 自定义事件类型（text/reasoning/tool_call_start/tool_result），前端实时展示 |
| **统一工具接口** | 所有工具（内置 + MCP）实现相同的 `ToolDef` 接口，执行路径统一 |

---

## 五、核心文件索引

| 文件 | 职责 |
|------|------|
| [engine.ts](backend/src/engine.ts) | 对话引擎主循环：提示词构建、LLM 调用、工具路由、SSE 事件产出 |
| [mcp.ts](backend/src/mcp.ts) | MCP 连接管理：多服务器连接、工具发现、工具执行 |
| [tools.ts](backend/src/tools.ts) | 内置工具定义（tool_search） |
| [types.ts](backend/src/types.ts) | 类型定义：ToolDef、ChatMessage、StreamEvent 等 |
| [index.ts](backend/src/index.ts) | HTTP 服务入口：/api/chat SSE 端点 |
| [config.json](config.json) | 配置文件：LLM 设置、MCP 服务器配置 |

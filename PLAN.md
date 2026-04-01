# MCP Conversation Engine — 执行计划

## 目标

参考 Claude Code 的架构，做一个对话引擎：用户发消息 → LLM 自动判断意图 → 调用对应工具（MCP工具/网络搜索） → 返回结果。

## 技术栈

- **后端**: Node.js + Express, OpenAI SDK (兼容智谱GLM)
- **前端**: React + Vite, 单页聊天UI
- **MCP**: @modelcontextprotocol/sdk, stdio + SSE 双transport
- **搜索**: Tavily API

## 项目结构（最终态）

```
mcp-conversation-engine/
├── config.json              # API keys（gitignored）
├── config.example.json      # 模板
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts         # HTTP server 启动
│       ├── config.ts        # 读 config.json
│       ├── types.ts         # 所有类型
│       ├── engine.ts        # 对话主循环
│       ├── tools.ts         # 内置工具 (web_search, tool_search)
│       └── mcp.ts           # MCP 连接管理
└── frontend/
    ├── package.json
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx
        └── App.css
```

---

## 执行阶段

### Phase 0: 骨架 (5 min)
- [ ] `npm init` × 2 (backend + frontend)
- [ ] `config.example.json`
- [ ] `tsconfig.json`
- [ ] `gitignore`

### Phase 1: 后端核心 (一次写完，一次跑通)
- [ ] `types.ts` — ToolDef, ChatMessage, StreamEvent
- [ ] `config.ts` — 读 config.json
- [ ] `tools.ts` — web_search (Tavily) + tool_search (加载deferred MCP工具)
- [ ] `mcp.ts` — 连接 MCP server, tools/list → 注册到工具池
- [ ] `engine.ts` — 主循环: `message → LLM → tool_calls → execute → tool_result → loop`
- [ ] `index.ts` — Express + POST /api/chat (SSE streaming)

### Phase 2: 前端
- [ ] Vite + React 脚手架
- [ ] `App.tsx` — 聊天界面: 消息列表 + 输入框
- [ ] SSE 消费: EventSource → 渲染 text / tool_call / tool_result
- [ ] 工具调用可视化: 折叠块显示工具名 + 参数 + 结果

### Phase 3: Example MCP Server
- [ ] 一个最简单的 stdio MCP server (加法计算器)
- [ ] config.json 里配好，验证端到端

---

## 核心流程（一次写对）

```
用户消息 → POST /api/chat
  → engine.run(message, sessionId)
    → LLM.chat({messages, tools, systemPrompt})
      → LLM 返回 tool_calls?
        → 否: yield text, 结束
        → 是: yield tool_call_start
          → 遍历 tool_calls:
            → tool_search? → 返回匹配工具的完整 schema
            → web_search? → Tavily API
            → mcp__*? → MCP client.tools/call
            → yield tool_result
          → 把 tool_result 加回 messages
          → 再次调 LLM（循环）
    → yield done
  → SSE 推送给前端
```

## 关键设计决策

1. **意图识别 = LLM 自行决定**，不做单独分类器。工具描述写好就行。
2. **MCP 工具 deferred**: 初始只给 LLM 看名字，需要时调 tool_search 加载 schema。
3. **工具命名**: `mcp__{server}__{tool}` 避免冲突。
4. **API Key 全部放 config.json**，gitignore。

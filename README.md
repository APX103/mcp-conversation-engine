# MCP Conversation Engine

参考 Claude Code 架构的对话引擎：用户发消息 → LLM 自动判断意图 → 调用对应工具（MCP 工具 / 网络搜索） → 返回结果。

## 技术栈

- **后端**: Node.js + Express + TypeScript, OpenAI SDK（兼容智谱 GLM）
- **前端**: React + Vite + TypeScript, 单页聊天 UI
- **MCP**: @modelcontextprotocol/sdk, stdio transport
- **搜索**: Tavily API

## 快速开始

### 1. 安装依赖

```bash
npm install
cd backend && npm install && cd ..
cd frontend && npm install && cd ..
cd example-mcp-server && npm install && cd ..
```

### 2. 配置 API Key

```bash
cp config.example.json config.json
```

编辑 `config.json`，填入你的 API Key：

```json
{
  "llm": {
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "apiKey": "你的智谱 API Key",
    "model": "glm-4-flash"
  },
  "tavily": {
    "apiKey": "你的 Tavily API Key（可选，用于网络搜索）"
  }
}
```

### 3. 一键启动

```bash
./start.sh
```

这会同时启动后端（:3000）、前端（:5173）和示例 MCP Server。

### 4. 访问

打开浏览器访问 http://localhost:5173

### 停止服务

```bash
./stop.sh
```

## 手动启动（开发模式）

分别在不同终端运行：

```bash
# 终端 1：后端（端口 3000）
cd backend && npm run dev

# 终端 2：前端（端口 5173）
cd frontend && npm run dev

# 终端 3：示例 MCP Server（可选）
cd example-mcp-server && node index.js
```

## 项目结构

```
├── config.json              # API Key 配置（gitignored）
├── config.example.json      # 配置模板
├── backend/                 # Express 后端
│   └── src/
│       ├── index.ts         # HTTP 服务入口
│       ├── config.ts        # 配置加载
│       ├── types.ts         # 类型定义
│       ├── engine.ts        # 对话主循环
│       ├── tools.ts         # 内置工具 (web_search, tool_search)
│       └── mcp.ts           # MCP 连接管理
├── frontend/                # React 聊天界面
│   └── src/
│       ├── main.tsx
│       └── App.tsx
├── example-mcp-server/      # 示例 MCP Server（计算器）
│   └── index.js
├── start.sh                 # 一键启动脚本
└── stop.sh                  # 一键停止脚本
```

## 核心设计

- **意图识别**: LLM 自行判断，不做单独分类器
- **MCP 工具延迟加载**: 初始只给 LLM 工具名称，需要时通过 `tool_search` 获取完整 schema
- **工具命名**: `mcp__{server}__{tool}` 避免冲突
- **SSE 流式响应**: 后端通过 Server-Sent Events 实时推送文本、工具调用和结果

## API

| 端点 | 方法 | 说明 |
|------|------|------|
| `POST /api/chat` | POST | 发送消息，SSE 流式返回 |
| `GET /api/sessions/:id` | GET | 获取会话历史 |
| `GET /api/health` | GET | 健康检查 |

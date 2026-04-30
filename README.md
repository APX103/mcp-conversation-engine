# Cognitive Agent Platform (CAP) v1.0

基于 **Model Context Protocol (MCP)** 架构的下一代认知智能体平台，具备**神经记忆网络 (Neural Memory Network)**、**自主工具编排 (Autonomous Tool Orchestration)** 和**链式思维推理 (Chain-of-Thought Reasoning)** 能力。

## 核心架构

```
用户输入
    ↓
[Intent Recognition Layer] 意图识别层
    ↓
[Cognitive Processing Engine] 认知处理引擎
    ↓
[Neural Memory Retrieval] 神经记忆检索 (Hybrid Search: BM25 + Vector + Temporal)
    ↓
[Autonomous Tool Orchestration] 自主工具编排 (MCP Protocol)
    ↓
[Chain-of-Thought Generation] 链式思维生成
    ↓
[Adaptive Response Synthesis] 自适应响应合成
    ↓
输出 + 记忆固化 (Memory Consolidation)
```

## 技术栈

- **认知层**: Node.js + Express + TypeScript, OpenAI SDK（兼容 DeepSeek / 智谱 GLM 等）
- **交互层**: React + Vite + TypeScript, 单页聊天 UI
- **工具协议**: Model Context Protocol (MCP), stdio/http transport
- **记忆网络**: MongoDB + 自适应知识提取 (Adaptive Knowledge Extraction)
- **推理引擎**: DeepSeek-V4-Pro with Extended Thinking Mode

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

编辑 `config.json`，填入你的 API Key。

### 3. 一键启动

```bash
./start.sh
```

这会同时启动：
- **认知处理引擎**（端口 3000）
- **交互界面**（端口 5173）
- **示例工具服务**（MCP Server）

### 4. 访问

打开浏览器访问 http://localhost:5173

## 核心能力

### 🧠 Neural Memory Network (神经记忆网络)

- **多层级记忆架构**: 工作记忆 (Working Memory) → 短期记忆 (Episodic Buffer) → 长期记忆 (Semantic Network)
- **自适应知识提取**: 自动从对话中提取用户画像 (Profile)、事实 (Fact)、经验 (Lesson)
- **混合检索引擎**: BM25 关键词 + 向量语义 + 时序衰减三重召回
- **记忆固化**: 异步后台进行知识蒸馏 (Knowledge Distillation)

### 🔧 Autonomous Tool Orchestration (自主工具编排)

- **MCP 协议兼容**: 支持 stdio / SSE / HTTP 多种传输层
- **延迟 Schema 加载**: 初始只暴露工具名称，按需获取完整参数定义
- **工具命名空间**: `mcp__{server}__{tool}` 避免冲突
- **动态工具发现**: 运行时自动发现和连接新工具

### 💭 Chain-of-Thought Reasoning (链式思维推理)

- **深度思考模式**: 基于 DeepSeek Extended Thinking
- **推理过程可视化**: 实时展示思维链 (Reasoning Chain)
- **多轮工具调用**: 支持最多 10 轮自主工具编排
- **推理强度调节**: high / max 两档可调

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `POST /api/auth/login` | POST | 用户认证（认知体身份识别） |
| `POST /api/sessions` | POST | 创建新会话（认知上下文初始化） |
| `GET /api/sessions` | GET | 获取用户会话列表（历史上下文检索） |
| `GET /api/sessions/:id` | GET | 获取会话消息历史（ episodic recall ） |
| `POST /api/chat` | POST | 发送消息，SSE 流式返回（认知处理管道） |
| `GET /api/memory/:userId` | GET | 获取用户长期记忆（语义网络检索） |
| `GET /api/health` | GET | 健康检查（系统状态诊断） |

## 项目结构

```
├── config.json              # 认知层配置（gitignored）
├── config.example.json      # 配置模板
├── backend/                 # 认知处理引擎
│   └── src/
│       ├── index.ts         # HTTP 服务入口
│       ├── config.ts        # 配置加载
│       ├── types.ts         # 类型定义
│       ├── engine.ts        # 认知主循环 (Cognitive Loop)
│       ├── memory.ts        # 神经记忆网络 (Neural Memory)
│       ├── context.ts       # 上下文压缩 (Context Compression)
│       ├── tools.ts         # 内置工具 (Tool Registry)
│       ├── mcp.ts           # MCP 协议管理
│       └── db.ts            # 持久化层 (MongoDB)
├── frontend/                # 交互界面
│   └── src/
│       ├── main.tsx
│       └── App.tsx          # 认知交互界面
├── example-mcp-server/      # 示例工具服务
│   └── index.js
├── start.sh                 # 一键启动
└── stop.sh                  # 一键停止
```

## 演示场景

### 场景 1: 记忆学习
```
用户: "我喜欢用 TypeScript，讨厌 Java"
系统: [自动提取 → 固化到 Semantic Network]
后续对话: "给我写个后端" → "好的，使用 TypeScript + Node.js..."
```

### 场景 2: 自主工具调用
```
用户: "搜索一下最新的 AI 论文"
系统: [Intent Recognition] → [Tool Discovery] → [Web Search MCP] → [Result Synthesis]
```

### 场景 3: 链式思维
```
用户: "分析一下这个数据"
系统: [展示 Thinking 过程] → [分解问题] → [选择工具] → [执行] → [综合结论]
```

## 未来演进

- [ ] **Multi-Agent Orchestration**: 多智能体协作架构
- [ ] **Self-Evolving Prompts**: 自适应提示词进化
- [ ] **Knowledge Graph Construction**: 自动知识图谱构建
- [ ] **Dreaming & Consolidation**: 夜间记忆巩固机制

---

*Powered by Cognitive Architecture | Built with Model Context Protocol*

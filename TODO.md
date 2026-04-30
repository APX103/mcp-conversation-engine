# TODO — MCP Conversation Engine

> 本项目现状盘点与后续规划。基于 README.md 宣称的核心能力与未来演进。

---

## ✅ 已完成

### 基础架构
- [x] Express + TypeScript 后端 (`backend/src/`)
- [x] React + Vite 前端 (`frontend/src/App.tsx`)
- [x] MongoDB 持久化 (`backend/src/db.ts`)
- [x] SSE 流式传输 (`POST /api/chat`)
- [x] `npm run dev` 一键启动（`concurrently`）

### 用户与会话
- [x] 用户名登录（自动创建）
- [x] 多会话管理（创建 / 列表 / 切换 / 删除 / 重命名）
- [x] 会话自动标题

### 链式思维推理 (Chain-of-Thought)
- [x] DeepSeek thinking mode 支持
- [x] 推理过程实时可视化（前端展示 `reasoning_content`）
- [x] Thinking 强度调节（`high` / `max`）
- [x] 前端侧栏开关 thinking

### 自主工具编排 (MCP)
- [x] MCP 协议兼容（stdio / HTTP transport）
- [x] 工具命名空间 `mcp__{server}__{tool}`
- [x] 延迟 Schema 加载（`tool_search` 内置工具）
- [x] 多轮工具调用（最多 10 轮）
- [x] 流式停止 / 中断按钮

### 上下文管理
- [x] Token budget 压缩 (`context.ts`)
- [x] 智能摘要回退（`summarizeMessages`）
- [x] 修复压缩导致的消息顺序错乱
- [x] Flush 丢弃的消息到日志，防止信息丢失

### 神经记忆网络 (OpenClaw 风格)
- [x] 长期记忆 `MEMORY.md`（markdown 自由格式）
- [x] 每日日志 `memory/YYYY-MM-DD.md` 风格
- [x] 自动知识蒸馏（`consolidate`）
- [x] 对话后自动追加 daily log
- [x] 自动触发 consolidate（≥3 turns）
- [x] Inferred commitments（短期提醒提取）
- [x] 前端记忆面板（longTerm / dailyLogs / commitments）

### Skill 系统
- [x] `SkillEngine`（YAML frontmatter 解析 + prompt 注入）
- [x] `skills` 集合 CRUD
- [x] API 路由（`GET/PUT /api/skills/:userId`）
- [x] 内置 demo skill：`emoji-translator`
- [x] 前端技能面板（列表 / 添加 / 预览 / 启用开关）
- [x] 端到端触发测试通过

---

## 🚧 待实现 / 部分实现

### 神经记忆网络 — 检索层
- [ ] **BM25 关键词检索**：当前全量读取，无关键词打分
- [ ] **向量语义检索**：未接入 Embedding 模型，无向量索引
- [ ] **时序衰减召回**：未实现按时间权重排序

> 当前实现是"把整个 MEMORY.md + 最近 daily logs 塞进系统提示"，属于简单全量召回。要升级为 README 宣称的"混合检索引擎（BM25 + Vector + Temporal）"。

### MCP 工具编排
- [ ] **运行时热插拔 MCP 服务器**：目前只在启动时 `connectAll`，运行时无法动态增删
- [ ] **SSE transport**：当前仅支持 stdio 和 HTTP，未支持 SSE

### Skill 系统增强
- [ ] **语义触发匹配**：当前是简单关键词 `includes`，未来可用 Embedding 语义匹配
- [ ] **Skill 优先级 / 冲突处理**：多个 skill 同时触发时无优先级策略
- [ ] **Skill 参数化**：YAML frontmatter 中支持变量插值

### 定时任务 (Scheduler)
- [x] **node-cron 框架**：`backend/src/scheduler.ts`，支持注册 / 手动触发 / 状态查询 / 停止
- [x] **夜间记忆巩固**：每天凌晨 3 点对所有用户执行 `memory.consolidate()`
- [x] **旧日志清理**：每天凌晨 4 点删除 N 天前的 daily logs（默认 30 天）
- [x] **旧承诺清理**：每天凌晨 4:30 删除已完成的旧 commitments（默认 30 天）
- [x] **API 路由**：`GET /api/scheduler` 查看状态，`POST /api/scheduler/:name/run` 手动触发

---

## 🔮 未来演进（README 远期规划）

- [ ] **Multi-Agent Orchestration**：多智能体协作架构（路由 Agent → 专用 Agent）
- [ ] **Self-Evolving Prompts**：系统提示词根据对话历史自动进化
- [ ] **Knowledge Graph Construction**：从记忆中自动抽取实体关系，构建知识图谱
- [x] **Dreaming & Consolidation**：夜间批处理机制（`nightly-consolidate` 定时任务，每天凌晨 3 点自动 consolidate 所有用户）

---

## 🔧 技术债务

- [ ] **拆分前端单文件**：`App.tsx` 已 2057 行，需拆分为组件目录
- [ ] **补全单元测试**：目前零测试，至少覆盖 `skill.ts`、`context.ts`、`memory.ts`
- [ ] **清理废弃脚本**：`start.sh` / `stop.sh` 已废弃但仍在目录，README 已更新
- [ ] **API Key 安全管理**：`config.json` 在磁盘上，考虑支持环境变量覆盖
- [ ] **TypeScript 严格模式**：检查 `tsconfig.json` 是否开启 `strict`，补全缺失类型

---

## 📝 最近 commit 速览

```
3767ea0 chore: replace shell scripts with npm scripts + concurrently
039e78c feat: align memory system with OpenClaw latest design
a3c6354 wip: before refactoring to OpenClaw-style markdown memory
107d23e feat: Phase 2 long-term memory + incremental learning
```

---

*最后更新：2026-04-30*

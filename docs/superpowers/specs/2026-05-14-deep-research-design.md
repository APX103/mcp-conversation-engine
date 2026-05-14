# Deep Research 功能设计

## 概述

为认知 Agent 平台添加深度研究能力。用户输入研究主题后，系统自动搜索多个信息源、阅读网页、综合发现并生成结构化的 HTML 调研报告。支持手动触发（前端开关 / `/research` 指令）和自动触发（LLM 判断用户问题需要深度研究时自动启动）。

**目标耗时**: 每次研究任务 5-15 分钟。
**输出格式**: 独立 HTML 页面，内嵌样式，可在新标签页中直接查看。

## 市面方案调研

| 方案 | 架构模式 | 效果 | 成本 |
|------|----------|------|------|
| OpenAI Deep Research | ReAct Agent Loop (o3) | 顶级 | $5-20/次 |
| Gemini Deep Research | Plan-Search-Read-Iterate 流水线 | 顶级 | $1-7/次 |
| LangChain open_deep_research | Supervisor-Researcher 多 Agent | 优秀（Bench #6） | $0.46-1.87/次 |
| 阿里 DeepResearch | 微调 30B 专用模型 | 优秀 | 自部署 |

各方案共同模式：**规划 → 搜索 → 阅读 → 综合 → 报告**。

**选定方案**: 结构化流水线（非多 Agent，因为平台当前为单实例架构，A2A 多 Agent 能力已移除）。

## 整体架构

### 流水线流程

```
用户输入研究主题
       |
       v
1. 查询分解（Query Decomposition）
   LLM 将主题拆解为 4-8 个章节，每个章节 1-3 个搜索查询
       |
       v
2. 迭代搜索（Iterative Search）
   对每个查询调用 web-search-prime，收集 {标题, URL, 摘要}
       |
       v
3. 网页阅读（Page Reading）
   用 fetch_url 抓取 top-10 结果的全文（每页最多 8000 字符）
       |
       v
4. 发现压缩（Finding Compression）
   LLM 对每个章节独立摘要（控制上下文大小）
   输出：摘要、关键事实、来源链接、信息缺口
       |
       v
5. 缺口分析（Gap Analysis）
   LLM 分析所有发现，识别信息缺口
   若发现缺口 → 生成补充查询 → 回到步骤 2
   最多迭代 3 轮（可配置）
       |
       v
6. 报告生成（Report Generation）
   LLM 基于所有压缩后的发现生成 HTML 报告
   包含：章节标题、正文、数据表格、引用来源、总结
```

### 组件设计

**DeepResearchEngine**（新类，`backend/src/research/index.ts`）：
- 编排上述 6 个阶段的流水线
- 每个阶段独立调用 LLM（不使用 tool loop），精确控制输入输出
- 复用现有工具：`web-search-prime` MCP 工具、`fetch_url` 内置工具
- 作为后台任务运行，通过 SSE 推送进度事件
- 结果存入 MongoDB

不修改现有 ConversationEngine。DeepResearchEngine 是独立的引擎，在 `index.ts` 中与 ConversationEngine 并列初始化。

## 触发机制

### 手动触发
- 前端：开关按钮或 `/research` 指令
- 开启后，用户下一条消息直接进入 DeepResearchEngine，跳过普通对话流程

### 自动触发（LLM 判断）
- 在 `tools.ts` 中注册 `deep_research` 内置工具
- 系统提示词指导 LLM 在以下情况调用该工具：
  1. 需要跨多个信息源的综合分析
  2. 涉及最新数据或趋势
  3. 用户明确要求"调研"、"分析"、"研究"
  4. 问题复杂度高，单次搜索无法充分回答
- ConversationEngine 执行该工具时，将请求转发给 DeepResearchEngine 作为后台任务，当前对话不受阻塞

### 配置开关
```json
{
  "deepResearch": {
    "enabled": true,
    "maxSearchRounds": 3,
    "maxPagesPerRound": 10,
    "maxTokensPerFinding": 2000,
    "timeout": 900000
  }
}
```

## 流水线各阶段详细设计

### 阶段 1：查询分解

输入：用户的原始研究主题（字符串）
LLM 调用：一次调用，结构化输出
输出：
```typescript
{
  title: string           // 报告标题
  language: string        // "zh-CN" | "en-US"（跟随用户输入）
  sections: {
    id: number
    heading: string
    queries: string[]     // 每章节 1-3 个搜索查询
  }[]
}
```

### 阶段 2：迭代搜索

- 对所有章节的每个查询调用 `web-search-prime` MCP 工具
- 每个查询取 top-5 搜索结果：`{ title, url, snippet }`
- 使用 `Promise.all` 并行调用（注意 API 速率限制）
- 跨查询去重 URL

### 阶段 3：网页阅读

- 从搜索结果中选取 top-10 URL（根据摘要相关性排序）
- 用 `fetch_url` 内置工具抓取每个 URL 的全文
- 去除 HTML 标签，提取纯文本
- 每页截断至 8000 字符
- 抓取失败则跳过

### 阶段 4：发现压缩

输入：某个章节的所有搜索结果 + 网页内容
LLM 调用：每章节一次调用
输出：
```typescript
{
  sectionId: number
  heading: string
  summary: string          // 核心发现，最多 500 字
  keyFacts: string[]       // 关键事实陈述
  sources: {
    title: string
    url: string
    relevance: string      // "高" | "中" | "低"
  }[]
  gaps: string[]           // 尚未找到的信息
}
```

每章节独立压缩，防止上下文窗口溢出。

### 阶段 5：缺口分析

输入：所有章节的发现 + 所有缺口
LLM 调用：一次调用
输出：
```typescript
{
  sufficient: boolean
  additionalQueries: string[]   // 若不充分，补充搜索查询
}
```

若 `sufficient: false`，用 `additionalQueries` 回到阶段 2 继续搜索。
最多迭代 3 轮（通过 `maxSearchRounds` 配置）。

### 阶段 6：报告生成

输入：所有章节压缩后的发现
LLM 调用：一次调用，大输出 token 预算
输出：完整 HTML 报告，包含：
- 标题与摘要
- 各章节正文（带标题层级）
- 数据表格（如适用）
- 内联引用（编号脚注）与来源链接
- 总结与展望
- 内嵌 CSS 样式（Tailwind 工具类或内联 style）

## 进度推送与 API

### SSE 事件

端点：`POST /api/research`
```
research_started   { taskId, title }
phase_changed      { phase: "decomposing"|"searching"|"reading"|"compressing"|"analyzing"|"writing", detail }
progress           { current: number, total: number, message: string }
finding            { sectionId, heading, summary }
gap_detected       { gaps: string[] }
report_ready       { taskId }
error              { message }
```

### REST 端点

```
POST /api/research          启动研究任务，返回 SSE 流
GET  /api/research/:taskId  获取研究状态和进度
GET  /api/research/:taskId/report  获取 HTML 报告内容
```

## 数据模型

```typescript
// MongoDB 集合：researchTasks
interface ResearchTask {
  _id: string
  sessionId?: string
  query: string
  status: 'pending' | 'decomposing' | 'searching' | 'reading'
         | 'compressing' | 'analyzing' | 'writing'
         | 'completed' | 'failed'
  plan?: ResearchPlan
  findings: SectionFinding[]
  currentRound: number
  createdAt: Date
  completedAt?: Date
  error?: string
}

// MongoDB 集合：researchReports
interface ResearchReport {
  taskId: string
  html: string
  createdAt: Date
}

interface ResearchPlan {
  title: string
  language: string
  sections: { id: number; heading: string; queries: string[] }[]
}

interface SectionFinding {
  sectionId: number
  heading: string
  summary: string
  keyFacts: string[]
  sources: { title: string; url: string; relevance: string }[]
  gaps: string[]
}
```

## 文件结构

```
backend/src/
  research/
    index.ts          # DeepResearchEngine 主类
    types.ts          # 类型定义
    pipeline.ts       # 流水线各阶段实现
    prompts.ts        # 各阶段 LLM 提示词
    report.ts         # HTML 报告生成与 MongoDB 存储
  routes/
    research.ts       # /api/research 路由
```

与现有代码的集成点：
- `DeepResearchEngine` 在 `backend/src/index.ts` 中初始化，与 ConversationEngine 并列
- 新增 `deep_research` 内置工具，在 `backend/src/tools.ts` 中注册
- 研究路由在 `backend/src/index.ts` 中注册
- 前端修改 `frontend/src/App.tsx`：开关按钮、进度卡片、报告查看器

## 前端改动

- **开关按钮**：聊天输入框旁的"深度研究"开关，开启后下一条消息进入研究模式
- **进度卡片**：研究运行时，对话区域显示非聊天气泡的卡片，展示当前阶段、进度百分比、已完成章节
- **报告按钮**：研究完成后，"查看报告"按钮在新标签页打开 HTML 报告
- **`/research` 指令**：从聊天输入框快速触发研究模式

## 错误处理

- 搜索 API 失败：跳过失败查询，用已有结果继续
- 网页抓取失败：跳过失败 URL，记录警告日志
- LLM 调用失败：重试一次，仍失败则跳过该阶段
- 超时：超过 `config.deepResearch.timeout`（默认 15 分钟）后取消任务，返回已有发现
- 发现不充分：经过最大轮次后缺口分析仍发现缺口，用已有信息生成报告，在报告中注明局限性

## 配置项

```typescript
interface DeepResearchConfig {
  enabled: boolean              // 总开关（默认: true）
  maxSearchRounds: number       // 最大搜索迭代轮数（默认: 3）
  maxPagesPerRound: number      // 每轮最大阅读页数（默认: 10）
  maxTokensPerFinding: number   // 每章节发现压缩最大 token（默认: 2000）
  timeout: number               // 超时时间，单位毫秒（默认: 900000 = 15分钟）
}
```

在 `config.json` 中以 `deepResearch` 为键添加。同时在 `types.ts` 的 `Config` 接口中添加对应字段。

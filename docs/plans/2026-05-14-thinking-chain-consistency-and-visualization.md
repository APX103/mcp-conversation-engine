# 调研报告：思考链一致性约束与问题链可视化

**Date**: 2026-05-14
**Status**: 调研完成，待决策
**Scope**: 1) 解决 Agent 多轮工具调用后"跑偏"问题；2) 深度研究模式的"想-查-想-查"链条可视化

---

## 一、问题定义：截图对比分析

### 1.1 Kimi K2.6 思考模式（目标截图1）

**用户问题**: "Claude 有服务模式么，或者说，可以做一个 HTTP 服务实现远程调用 claudecode 么"

**思考链条**:
```
⚫ Claude 是否具备服务模式              ← 思考节点1：理解问题
🔍 搜索网页 | Claude Code server mode   ← 查询节点1：主动搜索
⚫ Claude 无 HTTP 仅 MCP                ← 思考节点2：总结发现
🔍 搜索网页 | claude mcp serve command  ← 查询节点2：深入验证
💡 思考中                                ← 思考节点3：准备最终回答
```

**关键特征**:
- 严格的 **想→查→想→查→想** 交替节奏
- 每个思考节点都在 **回顾原始问题** 并 **总结当前发现**
- 查询节点有明确的目的性（不是随机搜索）
- 最终回答前有一个收敛的"思考中"节点

### 1.2 当前 Repo Agent（问题截图2）

**用户问题**: "帮我调研一下 goal 模式，我想给我自己写的 agent 加上这种能力"

**实际链条**:
```
💭 Thinking → 🔍 web_search_prime "goal模式 agent 设计模式..."   ← 相关
💭 Thinking → 🔗 fetch_url https://ginonotes.com/...             ← 相关
💭 Thinking → 🔍 web_search_prime "goal-based agent 实现..."      ← 相关
💭 Thinking → 🔍 web_search_prime "plan-and-execute agent..."     ← 开始发散
💭 Thinking → 🔗 fetch_url https://github.langchain.ac.cn/...     ← 相关
💭 Thinking → ❌ "全部文件扫描完成。下面是对 learn-claude-code 
              教程项目的完整逐字逐句逐文件详审报告..."             ← 严重跑偏！
```

**跑偏表现**:
- 第4轮搜索从"goal 模式"扩展到"plan-and-execute"（主题漂移）
- 第6轮完全偏离，开始审查 `learn-claude-code` 项目文件（与用户问题无关）
- 没有**收敛节点**，LLM 一直在"发散"而非"聚焦"

---

## 二、根因分析：当前代码的问题

### 2.1 架构层面

**当前 `engine.ts` 的核心循环**（第188-344行）:

```
for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
  // 1. 调用 LLM（带全部历史消息）
  const stream = await openai.chat.completions.create({ messages: apiMessages, ... });
  
  // 2. 流式接收 reasoning + content + tool_calls
  
  // 3. 如果有 tool_calls：
  //    - 执行工具
  //    - 把 assistant(tool_calls) + tool(results) 塞进 messages
  //    - continue（回到第1步）
  
  // 4. 如果没有 tool_calls：done
}
```

**问题清单**:

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 1 | **无目标锚定** | System Prompt 第437行 | LLM 没有收到"你最初要回答什么"的提醒 |
| 2 | **无偏差检测** | 循环内无检查点 | 多轮后上下文膨胀，原始问题权重被稀释 |
| 3 | **无收敛机制** | 仅通过"无 tool_calls"停止 | LLM 无法主动判断"信息已足够" |
| 4 | **reasoning 不参与决策** | `reasoning_content` 只展示 | DeepSeek 的思考过程不影响工具选择逻辑 |
| 5 | **System Prompt 过简** | 仅3行工具说明 | 缺少"如何正确使用工具"的元认知指导 |
| 6 | **Tool results 全量回填** | 第327-333行 | 网页内容等大段文本直接塞入 context，干扰注意力 |

### 2.2 Prompt 层面

当前 System Prompt（engine.ts 第437-444行）:
```
你是一位 helpful assistant，拥有访问工具的能力。

可用工具列表：...

当需要使用工具时，请通过 function call 调用...
请使用与用户相同的语言回复。
```

**缺失的元认知指令**:
- 没有"工具调用前回顾目标"的要求
- 没有"信息足够时停止搜索"的要求
- 没有"忽略无关信息"的要求
- 没有"每轮后自我检查方向"的要求

### 2.3 为什么多轮后会跑偏？

```
Round 1: userQ → search "goal模式" → 获得10条结果
         ↓
Round 2: context[userQ, search_results] → fetch_url 网页A
         ↓
Round 3: context[userQ, results, 网页A内容] → search "goal-based agent"
         （LLM 被网页A中的"goal-based"关键词吸引，开始主题漂移）
         ↓
Round 4: context[...越来越大...] → search "plan-and-execute"
         （LLM 注意到网页内容中提到 plan-and-execute，进一步漂移）
         ↓
Round 5: context[...膨胀...] → fetch_url 网页B
         （网页B恰好是 learn-claude-code 的文档）
         ↓
Round 6: context[...严重膨胀...] → "扫描 learn-claude-code 文件"
         （LLM 完全忘记了用户要的是"goal模式调研"，被当前文档内容主导）
```

**核心机制**: LLM 的注意力被**最新、最长、最详细**的上下文内容主导，原始用户问题的**首因效应**被稀释。

---

## 三、业界方案调研

### 3.1 ReAct + Goal Tracking（最相关）

**来源**: Yao et al. "ReAct: Synergizing Reasoning and Acting in Language Models" (ICLR 2023)

**核心思想**: 在 ReAct 的 `Thought → Action → Observation` 循环中加入显式的 Goal 状态跟踪。

**标准 ReAct 格式**:
```
Thought: 我需要查找 Claude 的服务模式
Action: web_search("Claude Code server mode HTTP")
Observation: [搜索结果...]
Thought: 从结果看，Claude Code 没有内置 HTTP 服务...
Action: web_search("claude mcp serve")
Observation: [搜索结果...]
Thought: 现在我已经确认 Claude 没有 HTTP 服务模式，只有 MCP...
Action: finish("Claude 没有 HTTP 服务模式...")
```

**Goal Tracking 增强**:
```
[目标] 用户问：Claude 是否有服务模式？
[进度] 已确认 Claude Code 没有 HTTP 服务
[检查] 当前信息是否足以回答目标？否，需要确认 MCP 方式
[行动] web_search("claude mcp serve command")
```

**适用性**: ⭐⭐⭐⭐⭐ 与当前架构完全兼容，只需增强 prompt

### 3.2 Plan-and-Solve / Plan-and-Verify

**来源**: Wang et al. "Plan-and-Solve Prompting: Improving Zero-Shot Chain-of-Thought Reasoning by Large Language Models" (2023)

**核心思想**: 
1. **Plan 阶段**: LLM 先制定一个解决步骤的 plan
2. **Solve 阶段**: 按 plan 执行
3. **Verify 阶段**: 每步后检查是否偏离 plan

**Prompt 模板**:
```
首先，制定一个回答用户问题的计划：
1. [步骤1]
2. [步骤2]
3. [步骤3]

然后按步骤执行。每完成一步，检查是否偏离计划。
如果偏离，请纠正并说明原因。
```

**适用性**: ⭐⭐⭐⭐ 适合深度研究模式，但需要额外 LLM 调用生成 plan

### 3.3 Chain-of-Verification (CoVe)

**来源**: Dhuliawala et al. "Chain-of-Verification Reduces Hallucination in Large Language Models" (2023)

**核心思想**:
1. 先生成草稿回答
2. 生成验证问题来检查草稿
3. 根据验证结果修正

**变体——用于一致性约束**:
```
在每次工具调用后，请回答以下验证问题：
1. 我当前收集的信息与用户的原始问题相关吗？
2. 我是否已经收集了足够的信息来回答原问题？
3. 我是否需要继续调用工具，还是可以直接回答？
```

**适用性**: ⭐⭐⭐⭐ 可作为 system prompt 的一部分，零代码改动

### 3.4 Self-Refine / Self-Correction

**来源**: Madaan et al. "Self-Refine: Iterative Refinement with Self-Feedback" (2023)

**核心思想**: 让 LLM 对自己的输出进行反思和修正。

**Prompt 模板**:
```
在每次决定调用工具前，请先进行以下自我检查：
- STOP: 我当前要做什么？
- CHECK: 这与用户的问题相关吗？
- DECIDE: 如果相关，继续；如果不相关，纠正方向。
```

**适用性**: ⭐⭐⭐⭐⭐ 最简单，直接加入 prompt 即可

### 3.5 结构化 Chain-of-Thought

**来源**: DeepSeek Extended Thinking 官方文档

**核心思想**: 利用 `reasoning_content` 的特性，在 prompt 中引导思考结构。

**推荐结构**（基于 DeepSeek 的 `thinking` 模式）:
```
你的思考过程应遵循以下结构：

【目标回顾】用户的原始问题是：{original_question}
【当前进度】我已完成的步骤：...
【信息分析】从工具返回中我获得的关键信息：...
【偏差检查】我是否在回答原问题？是/否，因为...
【足够判断】我是否已收集足够信息？是/否
【下一步】我将...
```

**适用性**: ⭐⭐⭐⭐⭐ 与本项目 DeepSeek 集成完美匹配

### 3.6 工具调用层面的硬约束

**来源**: OpenAI Function Calling best practices, Anthropic Claude tool use patterns

**核心思想**: 通过工具设计来约束行为。

**方案 A: finish 工具**
添加一个 `finish` 工具，LLM 调用它表示"我已收集足够信息，准备回答"。

**方案 B: self_check 工具**
添加一个 `self_check` 工具，LLM 定期调用它来评估当前进度。

**方案 C: 强制 checkpoint**
在代码层面，每 N 轮强制插入一个 reflection 消息。

**适用性**: ⭐⭐⭐ 需要修改工具定义和循环逻辑，侵入性较大

---

## 四、推荐实现方案：三层一致性保障

### 4.1 总体策略

采用 **Prompt 为主、代码为辅** 的轻量级策略，最小化对现有架构的侵入。

```
┌─────────────────────────────────────────────────────────────┐
│  第一层：System Prompt 增强（软约束）                          │
│  - 目标锚定指令                                               │
│  - 工具调用前的自我检查要求                                     │
│  - 信息足够时的停止规则                                        │
├─────────────────────────────────────────────────────────────┤
│  第二层：结构化 Thinking 引导（中约束）                         │
│  - 利用 DeepSeek reasoning_content                              │
│  - 引导 LLM 在 thinking 中执行"目标回顾→偏差检查→足够判断"       │
├─────────────────────────────────────────────────────────────┤
│  第三层：代码级循环守卫（硬约束）                                │
│  - 每轮强制保留原始问题引用                                     │
│  - 可选：每 N 轮插入 checkpoint 伪消息                         │
│  - 工具结果摘要化（减少 context 噪声）                          │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 第一层：System Prompt 增强

**当前 Prompt 的问题**: 过于简单，缺少元认知指导。

**增强后的 System Prompt 建议**:

```markdown
你是一位 helpful assistant，拥有访问工具的能力。

## 可用工具列表
{toolNames}

## 工具调用纪律（必须遵守）

1. **目标锚定**：每次调用工具前，回顾用户的原始问题，确认当前行动与之相关。
2. **偏差检查**：如果你发现工具返回的信息让你偏离了原问题，请主动纠正方向，忽略无关信息。
3. **收敛判断**：当你已经获得足够信息来回答原问题时，请立即停止调用工具，直接给出最终回答。
4. **避免发散**：不要基于工具返回的内容引入新的子主题或展开无关讨论。
5. ** thinking 结构**：你的思考过程应遵循：
   - 【目标回顾】用户的原始问题是...
   - 【当前进度】我已完成的步骤...
   - 【信息分析】从工具返回中获得的关键信息...
   - 【偏差检查】我是否在回答原问题？
   - 【足够判断】信息是否已足够？
   - 【下一步】调用工具或直接回答

## 语言
请使用与用户相同的语言回复。
{memorySection}
```

**实施位置**: `backend/src/engine.ts` 第437-444行

**改动量**: 小（仅修改 prompt 字符串）

**预期效果**: LLM 的 reasoning_content 会自然包含目标回顾和偏差检查，减少跑偏概率。

### 4.3 第二层：结构化 Thinking 引导

**核心洞察**: DeepSeek 的 `reasoning_content` 是**模型内部思考**，不参与后续 LLM 决策（它只被展示给用户）。真正影响工具调用的是 `messages` 数组中的 `assistant` message 的 `content` 和 `tool_calls`。

**所以正确的策略是**: 让 LLM 在 `content`（或 thinking 后接的 content）中输出结构化的自我检查，而不仅仅是 reasoning。

**具体做法**:

在 System Prompt 中增加一个 `finish` 工具的描述:
```
当你已经收集了足够的信息来回答用户的原始问题时，请调用 finish 工具并给出最终回答。
不要无休止地调用搜索工具。
```

但更简单的方式是——利用现有的 `content` 输出:

让 LLM 在每次工具调用后的 content 中包含一个简短的 "Status" 段落：
```
我已经搜索了 goal 模式的相关资料，发现主要有以下几种实现方式...

[Status] 进度：已收集 goal-based agent 和 plan-and-execute 两种模式的资料。
        偏差检查：仍在回答用户关于 goal 模式的问题，方向正确。
        足够判断：信息基本足够，可以开始组织回答。
```

**实施方式**: 通过 few-shot 示例在 system prompt 中展示。

### 4.4 第三层：代码级循环守卫

**方案 A: 原始问题持久化 + 每轮注入**

在 `run()` 方法中保存原始问题，在每次 tool loop 开始时通过 system prompt 注入:

```typescript
// engine.ts 中
async *run(userMessage: string, sessionId: string, userId?: string) {
  const originalQuestion = userMessage; // 保存原始问题
  
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // 构建 apiMessages 时，在 system prompt 中注入原始问题提醒
    const systemPrompt = await this.buildSystemPrompt(userId, originalQuestion, round);
    // ...
  }
}

// buildSystemPrompt 增加参数
private async buildSystemPrompt(userId?: string, originalQuestion?: string, round?: number): Promise<string> {
  // ... existing code ...
  
  let prompt = `你是一位 helpful assistant...`;
  
  if (originalQuestion) {
    prompt += `\n\n【当前任务】用户的原始问题是："${originalQuestion}"。`;
    if (round && round > 0) {
      prompt += ` 这是你第 ${round} 轮工具调用。请检查你是否仍在回答这个问题。`;
    }
  }
  
  // ... rest of prompt ...
}
```

**方案 B: 工具结果摘要化（Context 降噪）**

当前代码直接把完整工具结果塞入 messages（第327-333行），导致 context 膨胀。

改进：对过长的 tool results 进行摘要后再回填。

```typescript
// 在 executeTool 后，如果结果过长，进行摘要
let resultToStore = result;
if (result.length > 4000) {
  resultToStore = await this.summarizeToolResult(result, entry.name);
}

toolResults.push({ id: entry.id, content: resultToStore });
```

**方案 C: 可选的每 N 轮 Checkpoint**

```typescript
// 每 3 轮插入一个 reflection 用户消息
if (round > 0 && round % 3 === 0) {
  messages.push({
    role: "user",
    content: `[系统提示] 你已经进行了 ${round} 轮工具调用。请确认：
1. 你当前的方向是否仍然与用户的原始问题（"${originalQuestion}"）相关？
2. 如果已经收集到足够信息，请直接给出最终回答，不要继续调用工具。`
  });
}
```

> ⚠️ 这个方案会改变对话历史，可能影响上下文连贯性。建议作为可选配置。

### 4.5 三层方案的优先级建议

```
Phase 1（立即实施，零风险）:
  ├── 增强 System Prompt（4.2节）
  └── 添加原始问题持久化 + 每轮注入（4.4节方案A）
  
Phase 2（验证有效后实施）:
  ├── 工具结果摘要化（4.4节方案B）
  └── 添加 finish 工具或收敛引导（4.3节）
  
Phase 3（如有必要）:
  └── 每 N 轮 Checkpoint（4.4节方案C）
```

---

## 五、深度研究模式：问题链可视化方案

### 5.1 目标

在深度研究模式下，展示一个独立的"思考链"对话框，通过 SSE 实时推送节点，画出类似 Kimi 的垂直时间线：

```
用户：帮我调研一下 goal 模式

[深度研究对话框]
│
├─ 💭 正在分析研究主题...                    ← 思考节点（黄色）
│     └─ 将问题分解为 3 个章节
│
├─ 🔍 搜索: "goal模式 agent 设计模式..."      ← 查询节点（蓝色）
│     └─ 找到 5 条结果
│
├─ 💭 提取 "Goal-Based Agent" 章节的发现...   ← 思考节点（黄色）
│     └─ 发现 3 种主要实现方式
│
├─ 🔍 搜索: "plan-and-execute LangChain..."   ← 查询节点（蓝色）
│     └─ 找到 4 条结果
│
├─ 💭 分析信息完整性...                       ← 思考节点（黄色）
│     └─ 发现缺口: "缺少代码示例"
│
├─ 🔍 搜索: "goal-based agent 代码示例 Python" ← 查询节点（蓝色）
│
├─ 💭 生成最终报告...                         ← 思考节点（黄色）
│
└─ ✅ 报告已生成                              ← 完成节点（绿色）
```

### 5.2 技术架构

```
DeepResearchEngine.run()
    │
    ├─ emit chain_node_start  {id, type, title}     ───┐
    ├─ emit chain_node_update {id, detail}              ├── SSE 流
    ├─ emit chain_node_end    {id, status}          ───┘
    │
    └─ 现有事件 (phase_changed, progress, finding...)
         │
         ▼
    前端 ResearchChainPanel 组件
         │
         ├─ 垂直时间线布局（CSS Flex Column）
         ├─ 节点类型图标 + 标题
         ├─ 可展开详情
         └─ SVG 连接线
```

### 5.3 数据结构

**后端：扩展 ResearchStreamEvent**

```typescript
// backend/src/types.ts
interface ChainNodeEvent {
  type: 'chain_node_start' | 'chain_node_update' | 'chain_node_end';
  nodeId: string;
  nodeType?: 'thought' | 'query' | 'read' | 'analysis' | 'answer';
  title?: string;
  detail?: string;
  status?: 'running' | 'completed' | 'error';
  parentId?: string;     // 用于层级关系
  depth?: number;        // 缩进层级（子查询）
}

// 扩展现有 ResearchStreamEvent union
type ResearchStreamEvent =
  | ChainNodeEvent
  | { type: 'research_started'; taskId: string; title: string }
  | { type: 'phase_changed'; phase: string; detail: string }
  // ... 保留现有事件
```

**前端：节点状态**

```typescript
interface ChainNode {
  id: string;
  type: 'thought' | 'query' | 'read' | 'analysis' | 'answer';
  title: string;
  detail?: string;
  status: 'running' | 'completed' | 'error';
  parentId?: string;
  depth: number;
  children: string[];
  timestamp: number;
}

interface ChainState {
  nodes: ChainNode[];
  nodeMap: Map<string, ChainNode>;  // 快速查找
  rootNodes: string[];               // 顶层节点ID
}
```

### 5.4 后端实现：在 DeepResearchEngine 中插入节点事件

```typescript
// research/index.ts - run() 方法中

// Phase 1: Decompose
yield { type: 'chain_node_start', nodeId: 'decompose', nodeType: 'thought', title: '正在分析研究主题...' };
const plan = await decomposeQuery(ctx, query);
yield { type: 'chain_node_update', nodeId: 'decompose', detail: `已分解为 ${plan.sections.length} 个章节` };
yield { type: 'chain_node_end', nodeId: 'decompose', status: 'completed' };

// 为每个 section 创建查询节点
for (const section of plan.sections) {
  yield { type: 'chain_node_start', nodeId: `query-${section.id}`, nodeType: 'query', title: section.heading, parentId: 'decompose' };
}

// Search loop
while (currentRound < maxSearchRounds) {
  // Phase 2: Search
  for (const section of plan.sections) {
    yield { type: 'chain_node_update', nodeId: `query-${section.id}`, detail: `搜索: ${section.queries.join(', ')}` };
  }
  const results = await searchQueries(ctx, queriesForRound);
  
  // Phase 3: Read
  yield { type: 'chain_node_start', nodeId: `read-${currentRound}`, nodeType: 'read', title: `阅读 ${results.length} 个网页...` };
  const pages = await readPages(ctx, results);
  yield { type: 'chain_node_end', nodeId: `read-${currentRound}`, status: 'completed' };
  
  // Phase 4: Compress
  for (const section of processSections) {
    yield { type: 'chain_node_start', nodeId: `compress-${section.id}`, nodeType: 'thought', title: `提取 "${section.heading}" 的发现` };
    const finding = await compressFindings(ctx, section, results, pages);
    yield { type: 'chain_node_update', nodeId: `compress-${section.id}`, detail: finding.summary.slice(0, 100) + '...' };
    yield { type: 'chain_node_end', nodeId: `compress-${section.id}`, status: 'completed' };
    
    // 完成 section 查询
    yield { type: 'chain_node_end', nodeId: `query-${section.id}`, status: 'completed' };
  }
  
  // Phase 5: Gap Analysis
  yield { type: 'chain_node_start', nodeId: `gap-${currentRound}`, nodeType: 'analysis', title: '分析信息完整性...' };
  const gapResult = await analyzeGaps(ctx, query, currentRound, allFindings);
  if (gapResult.sufficient) {
    yield { type: 'chain_node_update', nodeId: `gap-${currentRound}`, detail: '信息已足够，准备生成报告' };
    yield { type: 'chain_node_end', nodeId: `gap-${currentRound}`, status: 'completed' };
    break;
  } else {
    yield { type: 'chain_node_update', nodeId: `gap-${currentRound}`, detail: `发现缺口: ${gapResult.additionalQueries.join(', ')}` };
    yield { type: 'chain_node_end', nodeId: `gap-${currentRound}`, status: 'completed' };
    // 为缺口创建新的查询节点
    for (const q of gapResult.additionalQueries) {
      yield { type: 'chain_node_start', nodeId: `query-gap-${q}`, nodeType: 'query', title: q, parentId: `gap-${currentRound}` };
    }
  }
}

// Phase 6: Report
yield { type: 'chain_node_start', nodeId: 'report', nodeType: 'answer', title: '生成调研报告...' };
const html = await generateReport(ctx, plan, allFindings);
yield { type: 'chain_node_end', nodeId: 'report', status: 'completed' };
```

### 5.5 前端实现：ResearchChainPanel 组件

**布局**: 独立的对话框/抽屉，右侧滑出或中央弹窗。

**视觉设计**:
```
节点类型 → 颜色/图标:
  thought   → 💭 黄色 #f59e0b
  query     → 🔍 蓝色 #3b82f6
  read      → 📄 灰色 #6b7280
  analysis  → 🔬 紫色 #8b5cf6
  answer    → ✅ 绿色 #16a34a

连接线 → 左侧垂直线（SVG 或 CSS border）
运行中 → 脉冲动画
完成   → 静态
错误   → 红色 + 错误图标
```

**核心组件结构**:
```tsx
function ResearchChainPanel({ nodes }: { nodes: ChainNode[] }) {
  return (
    <div className="chain-panel">
      <div className="chain-timeline">
        {nodes.map(node => (
          <ChainNodeItem key={node.id} node={node} />
        ))}
      </div>
    </div>
  );
}

function ChainNodeItem({ node }: { node: ChainNode }) {
  const icon = NODE_ICONS[node.type];
  const color = NODE_COLORS[node.type];
  
  return (
    <div className="chain-node" style={{ marginLeft: node.depth * 20 }}>
      {/* 连接线 */}
      <div className="chain-connector" />
      
      {/* 节点卡片 */}
      <div className="chain-card" style={{ borderLeftColor: color }}>
        <div className="chain-header">
          <span style={{ color }}>{icon}</span>
          <span className="chain-title">{node.title}</span>
          {node.status === 'running' && <Spinner />}
        </div>
        
        {node.detail && (
          <div className="chain-detail">{node.detail}</div>
        )}
      </div>
    </div>
  );
}
```

### 5.6 与现有 UI 的集成

当前前端已有 `ResearchState` 和进度卡片（App.tsx 第1197-1274行）。建议：

1. **保持现有进度卡片**（简洁的进度条 + 阶段标签）
2. **新增"查看详情"按钮** → 展开 ResearchChainPanel
3. **或者**：在研究进行时，自动弹出 ResearchChainPanel，完成后可收起

**SSE 消费端修改**（App.tsx 第647-727行）:
```typescript
// 在现有的 research event handler 中增加 chain_node 处理
case 'chain_node_start':
  setResearchChainNodes(prev => [...prev, {
    id: event.nodeId,
    type: event.nodeType!,
    title: event.title!,
    status: 'running',
    depth: calculateDepth(event.parentId),
    children: [],
    timestamp: Date.now(),
  }]);
  break;
  
case 'chain_node_update':
  setResearchChainNodes(prev => prev.map(n =>
    n.id === event.nodeId ? { ...n, detail: event.detail } : n
  ));
  break;
  
case 'chain_node_end':
  setResearchChainNodes(prev => prev.map(n =>
    n.id === event.nodeId ? { ...n, status: event.status! } : n
  ));
  break;
```

---

## 六、实施计划

### Phase 1: 一致性约束（Prompt 级，1-2 天）

**任务 1: 增强 System Prompt**
- 文件: `backend/src/engine.ts`
- 修改: `buildSystemPrompt()` 方法，加入"工具调用纪律"段落
- 加入: 原始问题持久化，每轮注入提醒

**任务 2: 验证效果**
- 用截图2中的问题"调研 goal 模式"测试
- 观察 reasoning_content 是否包含目标回顾和偏差检查
- 统计多轮后的跑偏率

### Phase 2: 问题链可视化（2-3 天）

**任务 3: 后端扩展 SSE 事件**
- 文件: `backend/src/types.ts`, `backend/src/research/index.ts`
- 新增: `chain_node_start/update/end` 事件类型
- 修改: `DeepResearchEngine.run()` 在关键节点 emit 事件

**任务 4: 前端实现 ResearchChainPanel**
- 文件: `frontend/src/App.tsx` 或新建 `frontend/src/components/ResearchChainPanel.tsx`
- 实现: 垂直时间线、节点卡片、连接线、动画
- 集成: 与现有研究进度 UI 联动

### Phase 3: 硬约束（如有必要，2-3 天）

**任务 5: 工具结果摘要化**
- 文件: `backend/src/engine.ts`
- 新增: `summarizeToolResult()` 方法
- 修改: `run()` 循环中过长结果的处理

**任务 6: 收敛判断增强**
- 可选：添加 `finish` 工具
- 可选：每 N 轮 checkpoint

---

## 七、风险与对策

| 风险 | 概率 | 影响 | 对策 |
|------|------|------|------|
| Prompt 增强后 LLM 仍然跑偏 | 中 | 中 | 升级到 Phase 3 硬约束 |
| System Prompt 过长导致 token 浪费 | 低 | 低 | Prompt 精简，核心指令放前面 |
| 问题链可视化增加前端复杂度 | 低 | 低 | 独立组件，不影响主对话流 |
| SSE 事件过多导致前端卡顿 | 低 | 中 | 节点数量控制 + 虚拟滚动 |
| 每轮重建 system prompt 增加延迟 | 低 | 低 | 缓存 system prompt，仅修改动态部分 |

---

## 八、参考资源

1. **DeepSeek Extended Thinking**: https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
2. **DeepSeek Tool Calls**: https://api-docs.deepseek.com/zh-cn/guides/tool_calls
3. **ReAct Paper**: Yao et al., "ReAct: Synergizing Reasoning and Acting in Language Models" (ICLR 2023)
4. **Plan-and-Solve**: Wang et al., "Plan-and-Solve Prompting" (2023)
5. **Chain-of-Verification**: Dhuliawala et al., "Chain-of-Verification Reduces Hallucination in Large Language Models" (2023)
6. **Self-Refine**: Madaan et al., "Self-Refine: Iterative Refinement with Self-Feedback" (2023)

---

## 九、结论

1. **跑偏问题的核心原因是**: 当前 System Prompt 缺少元认知指导，工具循环没有目标锚定机制。
2. **最优先的解决方案是**: 增强 System Prompt（加入工具调用纪律 + 结构化 thinking 引导）+ 原始问题持久化注入。这是零侵入、高回报的改动。
3. **问题链可视化是**: 在前端增加一个独立组件，通过扩展 SSE 事件类型实现。技术路径清晰，与现有架构兼容。
4. **建议的实施顺序**: Phase 1（Prompt 增强）→ 验证效果 → Phase 2（可视化）→ 如有必要 Phase 3（硬约束）。

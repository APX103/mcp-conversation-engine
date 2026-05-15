import OpenAI from "openai";
import type { Config, ChatMessage, StreamEvent, ToolDef, ToolCall } from "./types.js";
import { createBuiltinTools } from "./tools.js";
import { ServiceManager } from "./services/manager.js";
import { McpManager } from "./mcp.js";
import type { DbManager } from "./db.js";
import { buildApiMessages, compressMessages } from "./context.js";
import { MemoryEngine } from "./memory.js";
import { SkillEngine } from "./skill.js";
import type { CognitiveAdapter } from './cognitive/adapter.js';
import { SubagentEngine } from "./subagent/engine.js";
import { SubagentDB } from "./subagent/db.js";
import { subagentBus } from "./subagent/bus.js";

const MAX_TOOL_ROUNDS = parseInt(process.env.MAX_TOOL_ROUNDS || "100", 10);

function toolDefToOpenAI(tool: ToolDef): OpenAI.ChatCompletionTool {
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const p of tool.parameters) {
    properties[p.name] = {
      type: p.type,
      description: p.description,
      ...(p.type === "array" && p.items ? { items: p.items } : {}),
    };
    if (p.required) required.push(p.name);
  }

  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
      },
    },
  };
}

function allTools(): ToolDef[] {
  return [];
}

export class ConversationEngine {
  private openai: OpenAI;
  private mcp: McpManager;
  private model: string;
  private thinking: boolean;
  private reasoningEffort?: "high" | "max";
  private sessions = new Map<string, ChatMessage[]>();
  private stopFlags = new Map<string, boolean>();
  private db?: DbManager;
  private memory?: MemoryEngine;
  private skill?: SkillEngine;
  private cognitiveAdapter?: CognitiveAdapter;
  private serviceManager: ServiceManager;
  private config: Config;

  constructor(config: Config, mcp: McpManager, db?: DbManager, memory?: MemoryEngine, skill?: SkillEngine, cognitiveAdapter?: CognitiveAdapter) {
    this.config = config;
    this.openai = new OpenAI({
      baseURL: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
    });
    this.model = config.llm.model;
    this.thinking = config.llm.thinking ?? true;
    this.reasoningEffort = config.llm.reasoningEffort ?? "high";
    this.mcp = mcp;
    this.db = db;
    this.memory = memory;
    this.skill = skill;
    this.cognitiveAdapter = cognitiveAdapter;
    this.serviceManager = new ServiceManager();
  }

  // 基础工具列表（不含 spawn_agent，用于子 agent）
  private getBaseTools(): ToolDef[] {
    return [
      ...createBuiltinTools({
        getToolSchemas: (pattern) => this.mcp.getFullTools(pattern),
        db: this.db,
        serviceManager: this.serviceManager,
        mode: this.config.builtinTools?.mode,
        disabled: this.config.builtinTools?.disabled,
        enabled: this.config.builtinTools?.enabled,
      }),
      ...this.mcp.getAllTools(),
    ];
  }

  // 完整工具列表（含 spawn_agent）
  private getTools(): ToolDef[] {
    const tools = this.getBaseTools();
    // 动态注入 spawn_agent
    tools.push({
      name: "spawn_agent",
      description:
        "启动一个子 agent（Subagent）来执行特定任务。子 agent 拥有独立的上下文和完整的工具访问权限，可以自主调用工具完成复杂子任务。任务完成后返回结果给父 agent。" +
        "适用于：1) 需要多步骤独立执行的复杂子任务；2) 需要并行处理的任务；3) 需要隔离上下文的探索性任务。",
      parameters: [
        { name: "task", type: "string", description: "子 agent 需要完成的具体任务描述，要尽可能详细和明确，包括目标、约束条件和期望的输出格式", required: true },
        { name: "context", type: "string", description: "可选的上下文信息。如果需要子 agent 了解父对话中的某些信息（如已确认的结论、相关文件路径等），可以在这里提供摘要", required: false },
        { name: "mode", type: "string", description: "执行模式: 'sync'（同步等待结果，默认）| 'async'（后台运行，结果稍后返回）", required: false },
      ],
      execute: async (args) => this.spawnSubagent(args),
    });
    return tools;
  }

  private async spawnSubagent(args: Record<string, unknown>): Promise<string> {
    const task = args.task as string;
    const context = (args.context as string) || undefined;
    const mode = (args.mode as string) || "sync";

    if (!this.db) {
      return JSON.stringify({ error: "Database not available" });
    }

    const subagentDb = new SubagentDB(this.db);
    const subagentEngine = new SubagentEngine(this.config, subagentDb);

    const subagentId = await subagentDb.create({
      parentSessionId: "", // 会在 run 时由调用方填入
      parentToolCallId: "",
      task,
      context: context || "",
      status: "running",
      messages: [],
      result: "",
    });

    // MCP tools from getBaseTools don't have execute() — they rely on McpManager.toolExecuteMap.
    // SubagentEngine runs standalone and only has the tools array, so we must inject execute()
    // for every MCP tool before passing them to the subagent.
    const childTools = this.getBaseTools()
      .filter((t) => t.name !== "spawn_agent")
      .map((t) => {
        if (t.name.startsWith("mcp__") && !t.execute) {
          return {
            ...t,
            execute: async (args: Record<string, unknown>, _userId?: string) => {
              return this.mcp.executeTool(t.name, args, _userId);
            },
          };
        }
        return t;
      });

    if (mode === "async") {
      // 异步模式：后台运行，事件推送到 bus，立即返回
      (async () => {
        try {
          for await (const event of subagentEngine.run(subagentId, task, childTools, context)) {
            subagentBus.emit(subagentId, event);
          }
        } catch (err: any) {
          console.error("[Subagent] Async run failed:", err);
          await subagentDb.fail(subagentId, err.message);
          subagentBus.emit(subagentId, { type: "error", message: err.message });
        }
      })();
      return JSON.stringify({
        subagentId,
        status: "started",
        mode: "async",
        message: `子 agent 已在后台启动（ID: ${subagentId}），任务: ${task}`,
      });
    }

    // 同步模式：阻塞等待子 agent 完成，返回实际结果
    try {
      for await (const event of subagentEngine.run(subagentId, task, childTools, context)) {
        subagentBus.emit(subagentId, event);
      }
      const doc = await subagentDb.get(subagentId);
      let result = doc?.result;
      // Fallback: if DB result is empty, extract from the last assistant message
      if (!result && doc?.messages) {
        const lastAssistant = [...doc.messages].reverse().find((m) => m.role === "assistant");
        result = lastAssistant?.content || lastAssistant?.reasoning_content || "";
      }
      return JSON.stringify({
        subagentId,
        status: "completed",
        mode: "sync",
        result: result || "无结果",
        message: `子 agent 已完成任务。结果：\n${result || "无结果"}`,
      });
    } catch (err: any) {
      await subagentDb.fail(subagentId, err.message);
      subagentBus.emit(subagentId, { type: "error", message: err.message });
      return JSON.stringify({
        subagentId,
        status: "failed",
        mode: "sync",
        error: err.message,
        message: `子 agent 执行失败：${err.message}`,
      });
    }
  }

  getOrCreateSession(sessionId: string): ChatMessage[] {
    let msgs = this.sessions.get(sessionId);
    if (!msgs) {
      msgs = [];
      this.sessions.set(sessionId, msgs);
    }
    return msgs;
  }

  async loadSession(sessionId: string): Promise<void> {
    if (!this.db || this.sessions.has(sessionId)) return;
    let msgs = await this.db.loadSession(sessionId);
    // 修复旧代码产生的错误顺序：[user, tool, assistant(tool_calls)] -> [user, assistant(tool_calls), tool]
    msgs = this.fixMessageOrder(msgs);
    this.sessions.set(sessionId, msgs);
  }

  private fixMessageOrder(msgs: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];

    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];
      if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        const toolCallIds = new Set(msg.tool_calls.map((tc) => tc.id));
        const toolsToMove: ChatMessage[] = [];
        let j = result.length - 1;
        while (
          j >= 0 &&
          result[j].role === "tool" &&
          result[j].tool_call_id &&
          toolCallIds.has(result[j].tool_call_id!)
        ) {
          toolsToMove.unshift(result[j]);
          result.splice(j, 1);
          j--;
        }
        result.push(msg);
        result.push(...toolsToMove);
      } else {
        result.push(msg);
      }
    }

    return result;
  }

  async saveSession(sessionId: string): Promise<void> {
    if (!this.db) return;
    const msgs = this.sessions.get(sessionId);
    if (!msgs) return;
    await this.db.saveSession(sessionId, msgs);
  }

  getThinkingConfig() {
    return { thinking: this.thinking, reasoningEffort: this.reasoningEffort };
  }

  setThinking(enabled: boolean) {
    this.thinking = enabled;
  }

  setReasoningEffort(value: "high" | "max") {
    this.reasoningEffort = value;
  }

  stopSession(sessionId: string) {
    this.stopFlags.set(sessionId, true);
  }

  private shouldStop(sessionId: string): boolean {
    return !!this.stopFlags.get(sessionId);
  }

  private clearStop(sessionId: string) {
    this.stopFlags.delete(sessionId);
  }

  async *run(
    userMessage: string,
    sessionId: string,
    userId?: string
  ): AsyncGenerator<StreamEvent> {
    this.clearStop(sessionId);
    const messages = this.getOrCreateSession(sessionId);
    messages.push({ role: "user", content: userMessage });

    // 保存原始问题，用于多轮工具调用时的目标锚定和偏差检查
    const originalQuestion = userMessage;

    // Flush dropped messages before compression to prevent info loss
    const { removed } = compressMessages(messages);
    if (removed.length > 0 && userId && this.memory) {
      this.memory.flushDroppedMessages(userId, removed).catch(() => {});
    }

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const tools = this.getTools();
      const openaiTools = tools.map(toolDefToOpenAI);

      // 每轮重建 system prompt，注入原始问题和当前轮次，防止多轮后跑偏
      const systemPrompt = await this.buildSystemPrompt(userId, originalQuestion, round);

      const apiMessages = await buildApiMessages(systemPrompt, messages, {
        summarize: (texts) => this.summarizeMessages(texts),
      });

      const stream = await (this.openai.chat.completions.create as any)({
        model: this.model,
        messages: apiMessages,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        stream: true,
        reasoning_effort: this.thinking ? this.reasoningEffort : undefined,
        extra_body: this.thinking ? { thinking: { type: "enabled" } } : undefined,
      });

      // Accumulators for streamed content
      let fullContent = "";
      let fullReasoning = "";
      // Map: tool call index → { id, name, argumentsStr }
      const toolCallAccum = new Map<number, { id: string; name: string; argumentsStr: string }>();

      for await (const chunk of stream) {
        if (this.shouldStop(sessionId)) {
          yield { type: "error", content: "已停止" };
          return;
        }
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // Stream reasoning content (Chain of Thought)
        const reasoningDelta = (delta as any).reasoning_content as string | undefined;
        if (reasoningDelta) {
          fullReasoning += reasoningDelta;
          yield { type: "reasoning", content: reasoningDelta };
        }

        // Stream text content
        if (delta.content) {
          fullContent += delta.content;
          yield { type: "text", content: delta.content };
        }

        // Stream tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            let entry = toolCallAccum.get(idx);

            if (!entry) {
              entry = { id: tc.id ?? "", name: tc.function?.name ?? "", argumentsStr: "" };
              toolCallAccum.set(idx, entry);
              yield {
                type: "tool_call_start",
                id: entry.id,
                name: entry.name,
                arguments: {},
              };
            }

            if (tc.function?.name && !entry.name) {
              entry.name = tc.function.name;
            }
            if (tc.id && !entry.id) {
              entry.id = tc.id;
            }
            if (tc.function?.arguments) {
              entry.argumentsStr += tc.function.arguments;
              yield {
                type: "tool_call_delta",
                id: entry.id,
                name: entry.name,
                arguments_delta: tc.function.arguments,
              };
            }
          }
        }
      }

      // Build assistant message for history
      const chatMsg: ChatMessage = {
        role: "assistant",
        content: fullContent,
      };
      // DeepSeek thinking mode: always include reasoning_content field
      // (even if empty) so subsequent API calls don't throw 400.
      if (this.thinking) {
        chatMsg.reasoning_content = fullReasoning;
      }

      // If there were tool calls, execute them
      if (toolCallAccum.size > 0) {
        const toolCalls: ToolCall[] = [];
        const toolResults: { id: string; content: string }[] = [];

        for (const [idx, entry] of toolCallAccum) {
          const parsedArgs: Record<string, unknown> = entry.argumentsStr
            ? JSON.parse(entry.argumentsStr)
            : {};

          toolCalls.push({
            id: entry.id,
            name: entry.name,
            arguments: entry.argumentsStr,
          });

          yield { type: "tool_call_end", id: entry.id, arguments: parsedArgs };

          if (this.shouldStop(sessionId)) {
            yield { type: "error", content: "已停止" };
            return;
          }
          const result = await this.executeTool(entry.name, parsedArgs, userId);

          yield {
            type: "tool_result",
            id: entry.id,
            name: entry.name,
            result,
          };

          // deep_research: inject research notification into conversation
          if (entry.name === "deep_research") {
            try {
              const parsed = JSON.parse(result);
              if (parsed.action === "start_research") {
                yield { type: "text", content: `\n\n> 🔬 ${parsed.message}` };
              }
            } catch {}
          }

          toolResults.push({ id: entry.id, content: result });
        }

        // Assistant message with tool_calls must come BEFORE tool messages
        chatMsg.tool_calls = toolCalls;
        messages.push(chatMsg);

        for (const tr of toolResults) {
          messages.push({
            role: "tool",
            content: tr.content,
            tool_call_id: tr.id,
          });
        }

        // Loop to feed results back to LLM
        continue;
      }

      // No tool calls — we're done
      messages.push(chatMsg);
      this.triggerMemoryHooks(sessionId, userId);
      yield { type: "done" };
      return;
    }

    // Max rounds reached — ask the LLM to summarize progress and prompt the user
    const summarySystemPrompt = await this.buildSystemPrompt(userId, originalQuestion);
    const summaryMessages = await buildApiMessages(summarySystemPrompt, messages, {
      summarize: (texts) => this.summarizeMessages(texts),
    });
    summaryMessages.push({
      role: "user",
      content:
        "你已经达到了最大工具调用轮次限制。请总结一下你到目前为止做了什么、进行到了哪一步、还有什么未完成的工作，然后询问用户是否要继续。",
    });

    const summaryStream = await (this.openai.chat.completions.create as any)({
      model: this.model,
      messages: summaryMessages,
      stream: true,
    });

    let summaryContent = "";
    for await (const chunk of summaryStream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        summaryContent += delta.content;
        yield { type: "text", content: delta.content };
      }
    }

    messages.push({ role: "assistant", content: summaryContent });
    this.triggerMemoryHooks(sessionId, userId);
    yield { type: "done" };
  }

  private async executeTool(name: string, args: Record<string, unknown>, userId?: string): Promise<string> {
    const tools = this.getTools();
    const tool = tools.find((t) => t.name === name);
    if (!tool) return `Unknown tool: ${name}`;

    // MCP tools go through the manager
    if (name.startsWith("mcp__")) {
      return this.mcp.executeTool(name, args, userId);
    }

    try {
      return await tool.execute(args, userId);
    } catch (err: any) {
      return `Error executing ${name}: ${err.message}`;
    }
  }

  private async buildSystemPrompt(userId?: string, originalQuestion?: string, currentRound?: number): Promise<string> {
    const toolNames = this.getTools().map((t) => `- ${t.name}: ${t.description}`).join("\n");

    const sections: string[] = [];

    if (userId) {
      if (this.cognitiveAdapter) {
        const latestUserMsg = this.findLatestUserMessage();
        const memoryContext = await this.cognitiveAdapter.getMemoryContext(userId, latestUserMsg);
        if (memoryContext) {
          sections.push(`【关于用户的记忆】\n${memoryContext}\n请始终记住以上信息，并在回复中自然地体现。`);
        }
      } else if (this.memory) {
        const memoryContext = await this.memory.getMemoryContext(userId);
        if (memoryContext) {
          sections.push(`【关于用户的记忆】\n${memoryContext}\n请始终记住以上信息，并在回复中自然地体现。`);
        }
      }

      if (this.memory) {
        const commitmentsContext = await this.memory.getCommitmentsContext(userId);
        if (commitmentsContext) {
          sections.push(commitmentsContext);
        }
      }
    }

    if (userId) {
      if (this.cognitiveAdapter) {
        const skillsContext = await this.cognitiveAdapter.getSkillsContext(userId);
        if (skillsContext) {
          sections.push(skillsContext);
        }
      } else if (this.skill) {
        const skillsContext = await this.skill.getSkillsContext(userId);
        if (skillsContext) {
          sections.push(skillsContext);
        }
      }
    }

    const memorySection = sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";

    // 动态目标锚定：每轮提醒 LLM 原始问题，防止多轮工具调用后跑偏
    let goalAnchorSection = "";
    if (originalQuestion) {
      goalAnchorSection = `\n\n【当前任务】用户的原始问题是："${originalQuestion}"。`;
      if (typeof currentRound === "number" && currentRound > 0) {
        goalAnchorSection += ` 这是你第 ${currentRound + 1} 轮工具调用。请检查你是否仍在回答这个问题。如果已经收集到足够信息，请直接给出最终回答，不要继续调用工具。`;
      }
    }

    return `你是一位 helpful assistant，拥有访问工具的能力。

## 可用工具列表
${toolNames}

## 工具调用纪律（必须遵守）

1. **目标锚定**：每次调用工具前，回顾用户的原始问题，确认当前行动与之相关。
2. **偏差检查**：如果你发现工具返回的信息让你偏离了原问题，请主动纠正方向，忽略无关信息。
3. **收敛判断**：当你已经获得足够信息来回答原问题时，请立即停止调用工具，直接给出最终回答。
4. **避免发散**：不要基于工具返回的内容引入新的子主题或展开无关讨论。
5. **思考结构**：你的思考过程应遵循以下框架：
   - 【目标回顾】用户的原始问题是...
   - 【当前进度】我已完成的步骤...
   - 【信息分析】从工具返回中获得的关键信息...
   - 【偏差检查】我是否在回答原问题？是/否，因为...
   - 【足够判断】信息是否已足够？是/否
   - 【下一步】调用工具或直接回答

当需要使用工具时，请通过 function call 调用。对于 MCP 工具，如不确定参数 schema，可先使用 tool_search 获取完整定义。

请使用与用户相同的语言回复。${goalAnchorSection}${memorySection}`;
  }

  private findLatestUserMessage(): string {
    for (const msgs of this.sessions.values()) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') return msgs[i].content;
      }
    }
    return '';
  }

  /**
   * Trigger memory hooks after a conversation ends:
   * 1. Append to daily log
   * 2. Consolidate into long-term memory if enough new entries
   * Non-blocking — errors are silently caught.
   */
  triggerMemoryHooks(sessionId: string, userId?: string): void {
    if (!userId || !this.memory) return;
    const messages = this.getOrCreateSession(sessionId);
    // Strip reasoning_content before memory processing — it's display-only
    // and must never leak into daily logs or consolidation prompts.
    const cleaned = messages.map((m) => {
      const copy = { ...m };
      delete (copy as any).reasoning_content;
      return copy;
    });
    // Fire-and-forget
    this.memory.afterConversation(userId, cleaned).catch((err) => {
      console.error("[Engine] triggerMemoryHooks failed:", err);
    });

    if (this.cognitiveAdapter && userId) {
      this.cognitiveAdapter.afterConversation(userId, cleaned).catch(err => {
        console.error('[Cognitive] event emit failed:', err);
      });
    }
  }

  private async summarizeMessages(texts: string[]): Promise<string> {
    const prompt = `请用一句话总结以下对话片段的核心内容（50字以内）：\n\n${texts.join("\n")}`;
    const res = await this.openai.chat.completions.create({
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
      temperature: 0.3,
    });
    return res.choices[0]?.message?.content?.trim() || "对话摘要";
  }
}

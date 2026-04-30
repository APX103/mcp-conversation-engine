import OpenAI from "openai";
import type { Config, ChatMessage, StreamEvent, ToolDef, ToolCall } from "./types.js";
import { createBuiltinTools } from "./tools.js";
import { McpManager } from "./mcp.js";
import type { DbManager } from "./db.js";
import { buildApiMessages, compressMessages } from "./context.js";
import { MemoryEngine } from "./memory.js";
import { SkillEngine } from "./skill.js";

const MAX_TOOL_ROUNDS = 10;

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

  constructor(config: Config, mcp: McpManager, db?: DbManager, memory?: MemoryEngine, skill?: SkillEngine) {
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

    // Monkey-patch allTools to close over current state
    (this as any)._allTools = () => {
      return [
        ...createBuiltinTools({
          getToolSchemas: (pattern) => this.mcp.getFullTools(pattern),
          db: this.db,
          mode: config.builtinTools?.mode,
          disabled: config.builtinTools?.disabled,
          enabled: config.builtinTools?.enabled,
        }),
        ...this.mcp.getAllTools(),
      ];
    };
  }

  private getTools(): ToolDef[] {
    return (this as any)._allTools();
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

    const systemPrompt = await this.buildSystemPrompt(userId);

    // Flush dropped messages before compression to prevent info loss
    const { removed } = compressMessages(messages);
    if (removed.length > 0 && userId && this.memory) {
      this.memory.flushDroppedMessages(userId, removed).catch(() => {});
    }

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const tools = this.getTools();
      const openaiTools = tools.map(toolDefToOpenAI);

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

    yield { type: "error", content: "Max tool rounds reached" };
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

  private async buildSystemPrompt(userId?: string): Promise<string> {
    const toolNames = this.getTools().map((t) => `- ${t.name}: ${t.description}`).join("\n");

    const sections: string[] = [];

    if (userId && this.memory) {
      const memoryContext = await this.memory.getMemoryContext(userId);
      if (memoryContext) {
        sections.push(`【关于用户的记忆】\n${memoryContext}\n请始终记住以上信息，并在回复中自然地体现。`);
      }

      const commitmentsContext = await this.memory.getCommitmentsContext(userId);
      if (commitmentsContext) {
        sections.push(commitmentsContext);
      }
    }

    if (userId && this.skill) {
      const skillsContext = await this.skill.getSkillsContext(userId);
      if (skillsContext) {
        sections.push(skillsContext);
      }
    }

    const memorySection = sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";

    return `你是一位 helpful assistant，拥有访问工具的能力。

可用工具列表：
${toolNames}

当需要使用工具时，请通过 function call 调用。对于 MCP 工具，如不确定参数 schema，可先使用 tool_search 获取完整定义。

请使用与用户相同的语言回复。${memorySection}`;
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

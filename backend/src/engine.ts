import OpenAI from "openai";
import type { Config, ChatMessage, StreamEvent, ToolDef, ToolCall } from "./types.js";
import { createBuiltinTools } from "./tools.js";
import { McpManager } from "./mcp.js";

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
  private sessions = new Map<string, ChatMessage[]>();

  constructor(config: Config, mcp: McpManager) {
    this.openai = new OpenAI({
      baseURL: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
    });
    this.model = config.llm.model;
    this.mcp = mcp;

    // Monkey-patch allTools to close over current state
    (this as any)._allTools = () => {
      return [
        ...createBuiltinTools({
          getToolSchemas: (pattern) => this.mcp.getFullTools(pattern),
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

  async *run(userMessage: string, sessionId: string): AsyncGenerator<StreamEvent> {
    const messages = this.getOrCreateSession(sessionId);
    messages.push({ role: "user", content: userMessage });

    const systemPrompt = this.buildSystemPrompt();

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const tools = this.getTools();
      const openaiTools = tools.map(toolDefToOpenAI);

      const apiMessages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
        ...this.toOpenAIMessages(messages),
      ];

      const stream = await this.openai.chat.completions.create({
        model: this.model,
        messages: apiMessages,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        stream: true,
      });

      // Accumulators for streamed content
      let fullContent = "";
      let fullReasoning = "";
      // Map: tool call index → { id, name, argumentsStr }
      const toolCallAccum = new Map<number, { id: string; name: string; argumentsStr: string }>();

      for await (const chunk of stream) {
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

      // If there were tool calls, execute them
      if (toolCallAccum.size > 0) {
        const toolCalls: ToolCall[] = [];
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

          const result = await this.executeTool(entry.name, parsedArgs);

          yield {
            type: "tool_result",
            id: entry.id,
            name: entry.name,
            result,
          };

          messages.push({
            role: "tool",
            content: result,
            tool_call_id: entry.id,
          });
        }

        chatMsg.tool_calls = toolCalls;
        messages.push(chatMsg);

        // Loop to feed results back to LLM
        continue;
      }

      // No tool calls — we're done
      messages.push(chatMsg);
      yield { type: "done" };
      return;
    }

    yield { type: "error", content: "Max tool rounds reached" };
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tools = this.getTools();
    const tool = tools.find((t) => t.name === name);
    if (!tool) return `Unknown tool: ${name}`;

    // MCP tools go through the manager
    if (name.startsWith("mcp__")) {
      return this.mcp.executeTool(name, args);
    }

    try {
      return await tool.execute(args);
    } catch (err: any) {
      return `Error executing ${name}: ${err.message}`;
    }
  }

  private buildSystemPrompt(): string {
    const toolNames = this.getTools().map((t) => `- ${t.name}: ${t.description}`).join("\n");
    return `You are a helpful assistant with access to tools. You can search the web and use MCP tools.

Available tools:
${toolNames}

When you need to use a tool, use the appropriate function call. For MCP tools, use tool_search first to get the full parameter schema if you don't know it yet.

Respond in the same language the user uses.`;
  }

  private toOpenAIMessages(messages: ChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
    return messages.map((m) => {
      const base: any = { role: m.role, content: m.content };
      if (m.tool_calls) {
        base.tool_calls = m.tool_calls.map((tc: ToolCall) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      if (m.tool_call_id) {
        base.tool_call_id = m.tool_call_id;
      }
      return base;
    });
  }
}

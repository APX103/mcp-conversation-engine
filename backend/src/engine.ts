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

      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: apiMessages,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        stream: false, // We handle our own streaming via yield
      });

      const choice = response.choices[0];
      if (!choice) {
        yield { type: "error", content: "No response from LLM" };
        return;
      }

      const assistantMsg = choice.message;

      // Text content
      if (assistantMsg.content) {
        yield { type: "text", content: assistantMsg.content };
      }

      // Reasoning content (Chain of Thought, e.g. GLM-4.7 / GLM-5)
      const reasoningContent = (choice.message as any).reasoning_content as string | undefined;
      if (reasoningContent) {
        yield { type: "reasoning", content: reasoningContent };
      }

      // Save assistant message
      const chatMsg: ChatMessage = {
        role: "assistant",
        content: assistantMsg.content ?? "",
      };

      // Check for tool calls
      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        chatMsg.tool_calls = assistantMsg.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        }));
        messages.push(chatMsg);

        // Execute each tool call
        for (const tc of assistantMsg.tool_calls) {
          const args = JSON.parse(tc.function.arguments);
          const toolName = tc.function.name;

          yield {
            type: "tool_call_start",
            id: tc.id,
            name: toolName,
            arguments: args,
          };

          const result = await this.executeTool(toolName, args);

          yield {
            type: "tool_result",
            id: tc.id,
            name: toolName,
            result,
          };

          messages.push({
            role: "tool",
            content: result,
            tool_call_id: tc.id,
          });
        }

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

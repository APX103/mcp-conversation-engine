import OpenAI from "openai";
import type { Config, ToolDef, ToolCall } from "../types.js";
import type { SubagentStreamEvent, SubagentMessage } from "./types.js";
import type { SubagentDB } from "./db.js";

const MAX_TOOL_ROUNDS = 10;
const SUBAGENT_TIMEOUT_MS = 300_000; // 5 minutes

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

export class SubagentEngine {
  private openai: OpenAI;
  private model: string;
  private thinking: boolean;
  private reasoningEffort?: "high" | "max";
  private db: SubagentDB;

  constructor(config: Config, db: SubagentDB) {
    this.openai = new OpenAI({
      baseURL: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
    });
    this.model = config.llm.model;
    this.thinking = config.llm.thinking ?? true;
    this.reasoningEffort = config.llm.reasoningEffort ?? "high";
    this.db = db;
  }

  async *run(
    subagentId: string,
    task: string,
    tools: ToolDef[],
    context?: string
  ): AsyncGenerator<SubagentStreamEvent> {
    const messages: SubagentMessage[] = [];

    // Build system prompt
    const toolNames = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
    const contextSection = context ? `\n\n【父对话提供的上下文】\n${context}` : "";

    const systemPrompt = `你是一个子 agent（Subagent），被父 agent 调用来完成特定任务。

你的任务：${task}

可用工具列表：
${toolNames}

当需要使用工具时，请通过 function call 调用。对于 MCP 工具，如不确定参数 schema，可先使用 tool_search 获取完整定义。

请专注于完成任务，不要发散到无关主题。如果任务无法完成，请说明原因和已尝试的步骤。${contextSection}`;

    messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: task });

    // Save initial messages
    console.log(`[SubagentEngine] ${subagentId} saving initial messages`);
    await this.db.updateMessages(subagentId, messages);

    yield { type: "subagent_started", subagentId, task };

    const startTime = Date.now();

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Check timeout
      if (Date.now() - startTime > SUBAGENT_TIMEOUT_MS) {
        const timeoutMsg = "子 agent 执行超时（超过 5 分钟），请简化任务或分步骤执行。";
        console.log(`[SubagentEngine] ${subagentId} timed out`);
        await this.db.fail(subagentId, timeoutMsg);
        yield { type: "error", message: timeoutMsg };
        return;
      }

      const openaiTools = tools.map(toolDefToOpenAI);

      const apiMessages = messages.map((m) => {
        const base: any = { role: m.role, content: m.content };
        if (m.role === "assistant") {
          base.reasoning_content = m.reasoning_content ?? "";
        }
        if (m.tool_calls) {
          base.tool_calls = m.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }
        if (m.tool_call_id) {
          base.tool_call_id = m.tool_call_id;
        }
        return base;
      });

      console.log(`[SubagentEngine] ${subagentId} calling API (round ${round + 1}/${MAX_TOOL_ROUNDS})`);
      const stream = await (this.openai.chat.completions.create as any)({
        model: this.model,
        messages: apiMessages,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        stream: true,
        reasoning_effort: this.thinking ? this.reasoningEffort : undefined,
        extra_body: this.thinking ? { thinking: { type: "enabled" } } : undefined,
      });

      let fullContent = "";
      let fullReasoning = "";
      const toolCallAccum = new Map<number, { id: string; name: string; argumentsStr: string }>();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        const reasoningDelta = (delta as any).reasoning_content as string | undefined;
        if (reasoningDelta) {
          fullReasoning += reasoningDelta;
          yield { type: "reasoning", content: reasoningDelta };
        }

        if (delta.content) {
          fullContent += delta.content;
          yield { type: "text", content: delta.content };
        }

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

      // Build assistant message
      const assistantMsg: SubagentMessage = {
        role: "assistant",
        content: fullContent,
      };
      if (this.thinking) {
        assistantMsg.reasoning_content = fullReasoning;
      }

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

          const result = await this.executeTool(entry.name, parsedArgs, tools);

          yield {
            type: "tool_result",
            id: entry.id,
            name: entry.name,
            result,
          };

          toolResults.push({ id: entry.id, content: result });
        }

        assistantMsg.tool_calls = toolCalls;
        messages.push(assistantMsg);

        for (const tr of toolResults) {
          messages.push({
            role: "tool",
            content: tr.content,
            tool_call_id: tr.id,
          });
        }

        await this.db.updateMessages(subagentId, messages);
        continue;
      }

      // No tool calls — done
      messages.push(assistantMsg);
      await this.db.updateMessages(subagentId, messages);

      const result = fullContent || "子 agent 未返回内容";
      console.log(`[SubagentEngine] ${subagentId} completed with result length=${result.length}`);
      await this.db.complete(subagentId, result);
      yield { type: "subagent_completed", result };
      return;
    }

    // Max rounds reached
    console.log(`[SubagentEngine] ${subagentId} max rounds reached`);
    const maxRoundsMsg = `子 agent 已达到最大工具调用轮次（${MAX_TOOL_ROUNDS} 轮）。当前进度：\n\n${messages.filter((m) => m.role === "assistant").map((m) => m.content).join("\n\n")}`;
    await this.db.complete(subagentId, maxRoundsMsg);
    yield { type: "subagent_completed", result: maxRoundsMsg };
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    tools: ToolDef[]
  ): Promise<string> {
    const tool = tools.find((t) => t.name === name);
    if (!tool) return `Unknown tool: ${name}`;

    // Prevent recursive spawn_agent (only allow 1 level deep)
    if (name === "spawn_agent") {
      return "Error: 子 agent 不能递归调用 spawn_agent。请将任务分解后在父 agent 中并行调用。";
    }

    if (!tool.execute) {
      return `Error: Tool "${name}" has no execute function`;
    }

    try {
      return await tool.execute(args);
    } catch (err: any) {
      return `Error executing ${name}: ${err.message}`;
    }
  }
}

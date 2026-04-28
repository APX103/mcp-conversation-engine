import { encode } from "gpt-tokenizer";
import type { ChatMessage } from "./types.js";

/** Total token budget for the context window (excluding system prompt) */
export const HISTORY_BUDGET = 3000;

/** Count tokens in a plain string */
export function countTokens(text: string): number {
  return encode(text).length;
}

/** Count tokens in a ChatMessage (content + reasoning + tool_calls + metadata overhead) */
export function countMessageTokens(msg: ChatMessage): number {
  let tokens = countTokens(msg.content);
  if (msg.reasoning_content) {
    tokens += countTokens(msg.reasoning_content);
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      tokens += countTokens(tc.name);
      tokens += countTokens(tc.arguments);
    }
  }
  // overhead for role, formatting, etc.
  tokens += 4;
  return tokens;
}

/** Count total tokens for an array of messages */
export function countMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + countMessageTokens(m), 0);
}

/**
 * Compress messages to fit within budget.
 * Strategy: keep the most recent messages, drop the oldest ones.
 * Returns which messages were kept and which were removed (oldest first).
 */
export function compressMessages(
  messages: ChatMessage[],
  budget: number = HISTORY_BUDGET
): { kept: ChatMessage[]; removed: ChatMessage[] } {
  let total = 0;
  const kept: ChatMessage[] = [];

  // Walk backwards from newest message
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = countMessageTokens(messages[i]);
    if (total + tokens <= budget) {
      kept.unshift(messages[i]);
      total += tokens;
    } else {
      break;
    }
  }

  const removed = messages.slice(0, messages.length - kept.length);

  // Fix orphaned tool messages: a tool message must have its matching
  // assistant(tool_calls) in kept. If not, demote it to removed.
  const fixedKept: ChatMessage[] = [];
  const fixedRemoved = [...removed];
  for (const msg of kept) {
    if (msg.role === "tool" && msg.tool_call_id) {
      const hasParent = fixedKept.some(
        (m) =>
          m.role === "assistant" &&
          m.tool_calls?.some((tc) => tc.id === msg.tool_call_id)
      );
      if (!hasParent) {
        fixedRemoved.push(msg);
        continue;
      }
    }
    fixedKept.push(msg);
  }

  return { kept: fixedKept, removed: fixedRemoved };
}

/**
 * Build the full API message list with budget awareness.
 * If messages exceed budget, oldest messages are replaced with a summary.
 */
export async function buildApiMessages(
  systemPrompt: string,
  messages: ChatMessage[],
  options: {
    budget?: number;
    summarize?: (texts: string[]) => Promise<string>;
  } = {}
): Promise<{ role: string; content: string }[]> {
  const budget = options.budget ?? HISTORY_BUDGET;
  const { kept, removed } = compressMessages(messages, budget);

  const result: { role: string; content: string }[] = [
    { role: "system", content: systemPrompt },
  ];

  // If we had to drop old messages, insert a summary
  if (removed.length > 0 && options.summarize) {
    const texts = removed.map((m) => `${m.role}: ${m.content}`);
    const summary = await options.summarize(texts);
    result.push({ role: "assistant", content: `[此前对话摘要] ${summary}` });
  }

  // Append kept messages
  for (const m of kept) {
    const base: any = { role: m.role, content: m.content };
    if (m.reasoning_content) {
      base.reasoning_content = m.reasoning_content;
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
    result.push(base);
  }

  return result;
}

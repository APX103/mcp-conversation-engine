import { encode } from "gpt-tokenizer";
import type { ChatMessage } from "./types.js";

/** Total token budget for the context window (excluding system prompt) */
export const HISTORY_BUDGET = 8000;

/** Count tokens in a plain string */
export function countTokens(text: string): number {
  return encode(text).length;
}

/** Count tokens in a ChatMessage (content + tool_calls + metadata overhead).
 *  NOTE: reasoning_content is NOT counted because it must never be sent back to the LLM.
 */
export function countMessageTokens(msg: ChatMessage): number {
  let tokens = countTokens(msg.content);
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
 * Find the start index of the conversation round that ends at `endIndex`.
 * A round starts at the most recent user message at or before `endIndex`.
 */
function findRoundStart(messages: ChatMessage[], endIndex: number): number {
  let i = endIndex;
  while (i >= 0 && messages[i].role !== "user") {
    i--;
  }
  return i;
}

/**
 * Compress messages to fit within budget.
 * Strategy: keep the most recent *complete conversation rounds*, drop the oldest ones.
 * A round starts at a user message and ends just before the next user message.
 * This ensures we never drop a user message while keeping later assistant/tool messages.
 */
export function compressMessages(
  messages: ChatMessage[],
  budget: number = HISTORY_BUDGET
): { kept: ChatMessage[]; removed: ChatMessage[] } {
  let total = 0;
  const kept: ChatMessage[] = [];

  let i = messages.length - 1;
  while (i >= 0) {
    const roundStart = findRoundStart(messages, i);
    if (roundStart < 0) {
      // No user message found — keep remaining messages as a fragment
      const fragment = messages.slice(0, i + 1);
      const fragmentTokens = fragment.reduce(
        (sum, m) => sum + countMessageTokens(m),
        0
      );
      if (total + fragmentTokens <= budget) {
        kept.unshift(...fragment);
      }
      break;
    }

    const round = messages.slice(roundStart, i + 1);
    const roundTokens = round.reduce(
      (sum, m) => sum + countMessageTokens(m),
      0
    );

    if (total + roundTokens <= budget) {
      kept.unshift(...round);
      total += roundTokens;
      i = roundStart - 1;
    } else {
      // Budget exhausted — drop this round and everything before it
      break;
    }
  }

  const removedCount = messages.length - kept.length;
  const removed = messages.slice(0, removedCount);

  // Safety: fix any orphaned tool messages (shouldn't happen with round-based
  // approach, but kept as a defensive guard).
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

  // Append kept messages.
  // DeepSeek requires reasoning_content to be echoed back ONLY for messages
  // that contain tool_calls. For plain text messages, omit it to prevent
  // previous thinking chains from polluting subsequent reasoning.
  for (const m of kept) {
    const base: any = { role: m.role, content: m.content };
    if (m.tool_calls) {
      // DeepSeek API requirement: tool_calls messages must include reasoning_content
      if (m.reasoning_content) {
        base.reasoning_content = m.reasoning_content;
      }
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

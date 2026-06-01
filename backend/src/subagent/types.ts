// ── Subagent Stream Events (SSE) ──

export type SubagentStreamEvent =
  | { type: "subagent_started"; subagentId: string; task: string }
  | { type: "reasoning"; content: string }
  | { type: "text"; content: string }
  | { type: "tool_call_start"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_call_delta"; id: string; name: string; arguments_delta: string }
  | { type: "tool_call_end"; id: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; result: string }
  | { type: "subagent_completed"; result: string }
  | { type: "error"; message: string };

// ── Subagent Session (MongoDB) ──

export type SubagentStatus = "running" | "completed" | "failed";

export interface SubagentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning_content?: string;
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
  tool_call_id?: string;
}

export interface SubagentSessionDoc {
  _id?: string;
  parentSessionId: string;
  parentToolCallId: string;
  task: string;
  context?: string;
  status: SubagentStatus;
  messages: SubagentMessage[];
  result: string;
  createdAt: Date;
  completedAt?: Date;
  error?: string;
}

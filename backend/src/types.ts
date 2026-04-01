// ── Tool Definitions ──

export interface ToolParam {
  name: string;
  type: "string" | "number" | "boolean" | "array";
  description: string;
  required?: boolean;
  items?: { type: string };
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: ToolParam[];
  execute: (args: Record<string, unknown>) => Promise<string>;
}

// ── Chat Messages ──

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

export interface ChatMessage {
  role: Role;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

// ── Stream Events (SSE) ──

export type StreamEvent =
  | { type: "reasoning"; content: string }
  | { type: "text"; content: string }
  | { type: "tool_call_start"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; result: string }
  | { type: "error"; content: string }
  | { type: "done" };

// ── Config ──

export interface McpServerConfig {
  command?: string;
  args?: string[];
  transport: "stdio" | "sse" | "http";
  url?: string; // for SSE / HTTP transport
  headers?: Record<string, string>; // for HTTP transport
}

export interface Config {
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  mcpServers?: Record<string, McpServerConfig>;
  server: {
    port: number;
  };
}

// ── Session ──

export interface Session {
  id: string;
  messages: ChatMessage[];
  createdAt: number;
}

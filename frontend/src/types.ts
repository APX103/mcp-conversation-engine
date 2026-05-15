// ── Stream Events ──

export interface StreamEvent {
  type: "reasoning" | "text" | "tool_call_start" | "tool_call_delta" | "tool_call_end" | "tool_result" | "error" | "done";
  content?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  arguments_delta?: string;
  result?: string;
}

export interface ToolCallItem {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: string;
  running: boolean;
  argumentsDelta?: string;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  toolCalls?: ToolCallItem[];
  loading?: boolean;
}

export interface Session {
  sessionId: string;
  userId: string;
  title: string;
  updatedAt: number;
}

// ── Research Types ──

export interface ResearchStreamEvent {
  type: "research_started" | "phase_changed" | "progress" | "search_query" | "source_found" | "page_read" | "finding" | "gap_detected" | "report_ready" | "error";
  taskId?: string;
  title?: string;
  phase?: string;
  detail?: string;
  current?: number;
  total?: number;
  message?: string;
  sectionId?: number;
  heading?: string;
  summary?: string;
  gaps?: string[];
  query?: string;
  round?: number;
  url?: string;
  snippet?: string;
  status?: "start" | "done" | "error";
}

export interface ResearchLog {
  type: "search_query" | "source_found" | "page_read";
  query?: string;
  round?: number;
  title?: string;
  url?: string;
  snippet?: string;
  status?: "start" | "done" | "error";
  timestamp: number;
}

export interface ResearchState {
  active: boolean;
  taskId: string;
  title: string;
  phase: string;
  detail: string;
  progress: number;
  findings: { sectionId: number; heading: string; summary: string }[];
  logs: ResearchLog[];
  completed: boolean;
  error: string;
}

// ── Subagent ──

export interface SubagentEvent {
  type: string;
  content?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  arguments_delta?: string;
  result?: string;
  message?: string;
}

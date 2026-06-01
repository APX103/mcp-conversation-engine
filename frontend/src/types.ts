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

// ── Team Types ──

export type TeammateStatus = "idle" | "busy" | "completed" | "error" | "shutdown";

export interface Teammate {
  agentId: string;
  name: string;
  displayName: string;
  color: string;
  status: TeammateStatus;
  currentTaskId?: string;
  spawnedAt: number;
  completedAt?: number;
  result?: string;
}

export type TeamStatus = "active" | "idle" | "shutdown";

export interface Team {
  teamId: string;
  name: string;
  leaderSessionId: string;
  status: TeamStatus;
  createdAt: number;
  updatedAt: number;
  members: Teammate[];
  metadata: {
    description?: string;
    maxTeammates: number;
  };
}

export type TeamMessageType =
  | "chat"
  | "task_assignment"
  | "task_result"
  | "shutdown_request"
  | "shutdown_response"
  | "idle_notification"
  | "tool_permission_request"
  | "tool_permission_response";

export interface TeamMessage {
  id: string;
  from: string;
  to: string;
  type: TeamMessageType;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";
export type TaskPriority = "low" | "medium" | "high";

export interface TeamTask {
  id: string;
  subject: string;
  description: string;
  owner?: string;
  status: TaskStatus;
  priority: TaskPriority;
  blocks: string[];
  blockedBy: string[];
  createdAt: number;
  completedAt?: number;
  result?: string;
}

export type TeamStreamEvent =
  | { type: "team_created"; teamId: string; name: string }
  | { type: "team_disbanded"; teamId: string; reason?: string }
  | { type: "teammate_spawned"; agentId: string; name: string; color: string }
  | { type: "teammate_status_changed"; agentId: string; status: TeammateStatus; currentTaskId?: string }
  | { type: "teammate_shutdown"; agentId: string; reason?: string }
  | { type: "message"; message: TeamMessage }
  | { type: "task_created"; task: TeamTask }
  | { type: "task_updated"; task: TeamTask }
  | { type: "task_completed"; taskId: string; result: string }
  | { type: "teammate_event"; agentId: string; event: SubagentEvent }
  | { type: "error"; agentId?: string; message: string };

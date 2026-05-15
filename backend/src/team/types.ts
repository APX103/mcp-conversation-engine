// ── Team Core Types ──
// 基于 Claude Code Agent Team 调研报告的 Web 应用适配版本

import type { SubagentStreamEvent } from "../subagent/types.js";

// ── Teammate ──

export type TeammateStatus = "idle" | "busy" | "completed" | "error" | "shutdown";

export interface Teammate {
  agentId: string; // teammate-{name}@{teamId}
  name: string; // 显示名称，如 "researcher", "coder"
  displayName: string; // 带颜色标识的显示名
  color: string; // Tailwind color class，如 "blue", "green", "purple"
  status: TeammateStatus;
  currentTaskId?: string;
  spawnedAt: number;
  completedAt?: number;
  result?: string; // 最终结果摘要
}

export interface TeammateConfig {
  name: string;
  color?: string;
  initialTask?: string;
  model?: string; // "inherit" 或具体模型名
}

// ── Team ──

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

export interface TeamCreateInput {
  name: string;
  description?: string;
  leaderSessionId: string;
  maxTeammates?: number;
}

// ── TeamMessage (Mailbox) ──

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
  from: string; // sender agentId 或 "team-lead" / "user"
  to: string; // recipient agentId 或 "*" (broadcast)
  type: TeamMessageType;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ── TeamTask ──

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";
export type TaskPriority = "low" | "medium" | "high";

export interface TeamTask {
  id: string;
  subject: string;
  description: string;
  owner?: string; // responsible teammate name
  status: TaskStatus;
  priority: TaskPriority;
  blocks: string[]; // task IDs this task blocks
  blockedBy: string[]; // task IDs blocking this task
  createdAt: number;
  completedAt?: number;
  result?: string;
}

export interface TaskCreateInput {
  subject: string;
  description: string;
  priority?: TaskPriority;
  owner?: string;
  blocks?: string[];
}

// ── Team Stream Events (SSE) ──

export type TeamStreamEvent =
  // Team lifecycle
  | { type: "team_created"; teamId: string; name: string }
  | { type: "team_disbanded"; teamId: string; reason?: string }

  // Member lifecycle
  | { type: "teammate_spawned"; agentId: string; name: string; color: string }
  | { type: "teammate_status_changed"; agentId: string; status: TeammateStatus; currentTaskId?: string }
  | { type: "teammate_shutdown"; agentId: string; reason?: string }

  // Messages
  | { type: "message"; message: TeamMessage }

  // Tasks
  | { type: "task_created"; task: TeamTask }
  | { type: "task_updated"; task: TeamTask }
  | { type: "task_completed"; taskId: string; result: string }

  // Teammate execution events (forwarded from subagent)
  | { type: "teammate_event"; agentId: string; event: SubagentStreamEvent }

  // Errors
  | { type: "error"; agentId?: string; message: string };

// ── Constants ──

export const DEFAULT_MAX_TEAMMATES = 5;
export const DEFAULT_TEAMMATE_COLORS = [
  "blue",
  "green",
  "purple",
  "orange",
  "pink",
  "cyan",
  "amber",
  "emerald",
];
export const INBOX_POLL_INTERVAL_MS = 500;
export const TEAM_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes auto-cleanup
export const TEAM_MESSAGE_HISTORY_LIMIT = 200; // per team inbox

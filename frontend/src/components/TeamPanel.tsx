// ── TeamPanel ──
// Collapsible side panel showing team members, tasks, and messages

import { useState } from "react";
import type { Team, Teammate, TeamTask, TeamMessage } from "../types";

interface TeamPanelProps {
  team: Team | null;
  teammates: Teammate[];
  tasks: TeamTask[];
  messages: TeamMessage[];
  connected: boolean;
  open: boolean;
  onToggle: () => void;
}

const COLOR_MAP: Record<string, { bg: string; text: string; border: string }> = {
  blue: { bg: "bg-blue-500/10", text: "text-blue-400", border: "border-blue-500/30" },
  green: { bg: "bg-green-500/10", text: "text-green-400", border: "border-green-500/30" },
  purple: { bg: "bg-purple-500/10", text: "text-purple-400", border: "border-purple-500/30" },
  orange: { bg: "bg-orange-500/10", text: "text-orange-400", border: "border-orange-500/30" },
  pink: { bg: "bg-pink-500/10", text: "text-pink-400", border: "border-pink-500/30" },
  cyan: { bg: "bg-cyan-500/10", text: "text-cyan-400", border: "border-cyan-500/30" },
  amber: { bg: "bg-amber-500/10", text: "text-amber-400", border: "border-amber-500/30" },
  emerald: { bg: "bg-emerald-500/10", text: "text-emerald-400", border: "border-emerald-500/30" },
};

function getColor(color: string) {
  return COLOR_MAP[color] || COLOR_MAP.blue;
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    idle: "bg-gray-400",
    busy: "bg-yellow-400 animate-pulse",
    completed: "bg-green-400",
    error: "bg-red-400",
    shutdown: "bg-gray-600",
  };
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${colors[status] || "bg-gray-400"}`}
      title={status}
    />
  );
}

function TaskBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: "bg-gray-500/20 text-gray-400",
    in_progress: "bg-yellow-500/20 text-yellow-400",
    completed: "bg-green-500/20 text-green-400",
    failed: "bg-red-500/20 text-red-400",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${styles[status] || ""}`}>
      {status === "in_progress" ? "in progress" : status}
    </span>
  );
}

export default function TeamPanel({
  team,
  teammates,
  tasks,
  messages,
  connected,
  open,
  onToggle,
}: TeamPanelProps) {
  const [activeTab, setActiveTab] = useState<"members" | "tasks" | "messages">("members");

  if (!team) {
    return (
      <button
        onClick={onToggle}
        className="fixed right-4 top-20 z-40 w-10 h-10 rounded-full bg-surface border border-border
                   flex items-center justify-center text-text-secondary hover:text-text transition-colors"
        title="Team Panel"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </button>
    );
  }

  const stats = {
    total: tasks.length,
    completed: tasks.filter((t) => t.status === "completed").length,
    inProgress: tasks.filter((t) => t.status === "in_progress").length,
  };

  return (
    <>
      {/* Toggle button */}
      <button
        onClick={onToggle}
        className={`fixed right-4 top-20 z-40 w-10 h-10 rounded-full border flex items-center justify-center
          transition-all duration-200 ${
            open
              ? "bg-accent text-white border-accent"
              : "bg-surface text-text-secondary border-border hover:text-text"
          }`}
        title="Team Panel"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        {!open && teammates.length > 0 && (
          <span className="absolute -top-1 -right-1 w-4 h-4 bg-accent text-white text-[10px] rounded-full flex items-center justify-center">
            {teammates.length}
          </span>
        )}
      </button>

      {/* Panel */}
      {open && (
        <div
          className="fixed right-0 top-16 bottom-0 w-80 bg-surface border-l border-border z-30
                     flex flex-col overflow-hidden shadow-xl"
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-border">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm text-text truncate" title={team.name}>
                {team.name}
              </h3>
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`}
                  title={connected ? "Connected" : "Disconnected"}
                />
                <span className="text-xs text-text-secondary">
                  {stats.completed}/{stats.total}
                </span>
              </div>
            </div>
            <p className="text-xs text-text-secondary mt-1 truncate">
              {team.metadata.description || "Agent Team"}
            </p>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-border">
            {(["members", "tasks", "messages"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 py-2 text-xs font-medium capitalize transition-colors
                  ${activeTab === tab ? "text-accent border-b-2 border-accent" : "text-text-secondary hover:text-text"}`}
              >
                {tab}
                {tab === "members" && teammates.length > 0 && (
                  <span className="ml-1 text-[10px] opacity-60">({teammates.length})</span>
                )}
                {tab === "tasks" && tasks.length > 0 && (
                  <span className="ml-1 text-[10px] opacity-60">({tasks.length})</span>
                )}
                {tab === "messages" && messages.length > 0 && (
                  <span className="ml-1 text-[10px] opacity-60">({messages.length})</span>
                )}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {activeTab === "members" && (
              <>
                {teammates.length === 0 && (
                  <p className="text-xs text-text-secondary text-center py-4">No teammates yet</p>
                )}
                {teammates.map((m) => {
                  const c = getColor(m.color);
                  return (
                    <div
                      key={m.agentId}
                      className={`rounded-lg border p-3 ${c.border} ${c.bg}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <StatusDot status={m.status} />
                          <span className={`text-sm font-medium ${c.text}`}>{m.name}</span>
                        </div>
                        <span className="text-[10px] text-text-secondary uppercase">
                          {m.status}
                        </span>
                      </div>
                      {m.currentTaskId && (
                        <p className="text-[10px] text-text-secondary mt-1 truncate">
                          Task: {m.currentTaskId.slice(0, 8)}...
                        </p>
                      )}
                      {m.result && (
                        <p className="text-[10px] text-text-secondary mt-1 line-clamp-2">
                          {m.result}
                        </p>
                      )}
                    </div>
                  );
                })}
              </>
            )}

            {activeTab === "tasks" && (
              <>
                {tasks.length === 0 && (
                  <p className="text-xs text-text-secondary text-center py-4">No tasks yet</p>
                )}
                {tasks.map((t) => (
                  <div
                    key={t.id}
                    className="rounded-lg border border-border bg-surface-hover p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-medium text-text flex-1">{t.subject}</p>
                      <TaskBadge status={t.status} />
                    </div>
                    <p className="text-[10px] text-text-secondary mt-1 line-clamp-2">
                      {t.description}
                    </p>
                    <div className="flex items-center justify-between mt-2">
                      {t.owner ? (
                        <span className="text-[10px] text-accent">@{t.owner}</span>
                      ) : (
                        <span className="text-[10px] text-text-secondary">Unassigned</span>
                      )}
                      <span
                        className={`text-[10px] ${
                          t.priority === "high"
                            ? "text-red-400"
                            : t.priority === "medium"
                            ? "text-yellow-400"
                            : "text-text-secondary"
                        }`}
                      >
                        {t.priority}
                      </span>
                    </div>
                    {t.blockedBy.length > 0 && (
                      <p className="text-[10px] text-red-400 mt-1">
                        Blocked by {t.blockedBy.length} task(s)
                      </p>
                    )}
                  </div>
                ))}
              </>
            )}

            {activeTab === "messages" && (
              <>
                {messages.length === 0 && (
                  <p className="text-xs text-text-secondary text-center py-4">No messages yet</p>
                )}
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className="rounded-lg border border-border bg-surface-hover p-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-medium text-accent truncate">
                        {msg.from}
                      </span>
                      <span className="text-[10px] text-text-secondary shrink-0">
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="text-xs text-text-secondary mt-1">{msg.content}</p>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

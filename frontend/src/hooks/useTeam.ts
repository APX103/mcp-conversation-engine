// ── useTeam Hook ──
// Manages SSE connection to team event stream and team state

import { useState, useEffect, useCallback, useRef } from "react";
import type {
  Team,
  Teammate,
  TeamMessage,
  TeamTask,
  TeamStreamEvent,
} from "../types";
import { API_BASE } from "../lib/utils";

export interface UseTeamReturn {
  team: Team | null;
  teammates: Teammate[];
  messages: TeamMessage[];
  tasks: TeamTask[];
  connected: boolean;
  error: string | null;
  loadTeam: (sessionId: string) => Promise<void>;
  sendMessage: (to: string, content: string, type?: string) => Promise<void>;
}

export function useTeam(): UseTeamReturn {
  const [team, setTeam] = useState<Team | null>(null);
  const [teammates, setTeammates] = useState<Teammate[]>([]);
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [tasks, setTasks] = useState<TeamTask[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);

  const handleEvent = useCallback((event: TeamStreamEvent) => {
    switch (event.type) {
      case "team_created":
        // Team state will be refreshed via loadTeam
        break;
      case "teammate_spawned":
        setTeammates((prev) => [
          ...prev,
          {
            agentId: event.agentId,
            name: event.name,
            displayName: event.name,
            color: event.color,
            status: "idle",
            spawnedAt: Date.now(),
          },
        ]);
        break;
      case "teammate_status_changed":
        setTeammates((prev) =>
          prev.map((m) =>
            m.agentId === event.agentId
              ? { ...m, status: event.status, currentTaskId: event.currentTaskId }
              : m
          )
        );
        break;
      case "teammate_shutdown":
        setTeammates((prev) =>
          prev.map((m) =>
            m.agentId === event.agentId
              ? { ...m, status: "shutdown", completedAt: Date.now() }
              : m
          )
        );
        break;
      case "message":
        setMessages((prev) => [...prev, event.message]);
        break;
      case "task_created":
        setTasks((prev) => [event.task, ...prev]);
        break;
      case "task_updated":
        setTasks((prev) =>
          prev.map((t) => (t.id === event.task.id ? event.task : t))
        );
        break;
      case "task_completed":
        setTasks((prev) =>
          prev.map((t) =>
            t.id === event.taskId
              ? { ...t, status: "completed", result: event.result }
              : t
          )
        );
        break;
      case "error":
        console.error("[Team] Error:", event.message);
        break;
    }
  }, []);

  const loadTeam = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`${API_BASE}/session/${sessionId}/team`);
      if (res.status === 404) {
        setTeam(null);
        setTeammates([]);
        setMessages([]);
        setTasks([]);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: Team = await res.json();
      setTeam(data);
      setTeammates(data.members || []);

      // Also fetch tasks
      const tasksRes = await fetch(`${API_BASE}/team/${data.teamId}/tasks`);
      if (tasksRes.ok) {
        const tasksData = await tasksRes.json();
        setTasks(tasksData.tasks || []);
      }
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  const sendMessage = useCallback(
    async (to: string, content: string, type = "chat") => {
      if (!team) return;
      try {
        await fetch(`${API_BASE}/team/${team.teamId}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "user",
            to,
            type,
            content,
          }),
        });
      } catch (err: any) {
        setError(err.message);
      }
    },
    [team]
  );

  // SSE connection
  useEffect(() => {
    if (!team?.teamId) {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      setConnected(false);
      return;
    }

    const es = new EventSource(`${API_BASE}/team/${team.teamId}/stream`);
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const event: TeamStreamEvent = JSON.parse(e.data);
        handleEvent(event);
      } catch {
        // ignore parse errors
      }
    };

    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [team?.teamId, handleEvent]);

  return {
    team,
    teammates,
    messages,
    tasks,
    connected,
    error,
    loadTeam,
    sendMessage,
  };
}

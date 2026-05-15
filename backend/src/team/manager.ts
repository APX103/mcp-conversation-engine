// ── TeamManager ──
// 单例模式，管理所有 Team 的生命周期、成员、通信和事件分发

import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import type {
  Team,
  TeamCreateInput,
  Teammate,
  TeammateConfig,
  TeamMessage,
  TeamStreamEvent,
  TaskCreateInput,
  TeamTask,
} from "./types.js";
import {
  DEFAULT_MAX_TEAMMATES,
  DEFAULT_TEAMMATE_COLORS,
  TEAM_MAX_AGE_MS,
} from "./types.js";
import { Mailbox } from "./mailbox.js";
import { TaskBoard } from "./taskboard.js";

export class TeamManager {
  private static instance: TeamManager | null = null;

  static getInstance(): TeamManager {
    if (!TeamManager.instance) {
      TeamManager.instance = new TeamManager();
    }
    return TeamManager.instance;
  }

  // Core storage
  private teams = new Map<string, Team>();
  private mailboxes = new Map<string, Mailbox>();
  private taskboards = new Map<string, TaskBoard>();

  // Running teammate engines: agentId -> engine instance
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private engines = new Map<string, any>();

  // Event bus for SSE streaming
  private eventBus = new EventEmitter();

  // Session -> active team mapping (one session can only have one active team)
  private sessionTeamMap = new Map<string, string>();

  // Color allocation tracker per team
  private usedColors = new Map<string, Set<string>>();

  // Auto-cleanup interval
  private cleanupInterval: NodeJS.Timeout | null = null;

  private constructor() {
    this.startCleanupInterval();
  }

  // ═══════════════════════════════════════════════════════════════
  //  Team Lifecycle
  // ═══════════════════════════════════════════════════════════════

  createTeam(input: TeamCreateInput): Team {
    // One session can only have one active team
    const existingTeamId = this.sessionTeamMap.get(input.leaderSessionId);
    if (existingTeamId) {
      const existing = this.teams.get(existingTeamId);
      if (existing && existing.status !== "shutdown") {
        throw new Error(
          `Session ${input.leaderSessionId} already has an active team: ${existingTeamId}`
        );
      }
    }

    const teamId = `team-${randomUUID()}`;
    const team: Team = {
      teamId,
      name: input.name,
      leaderSessionId: input.leaderSessionId,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      members: [],
      metadata: {
        description: input.description,
        maxTeammates: input.maxTeammates ?? DEFAULT_MAX_TEAMMATES,
      },
    };

    this.teams.set(teamId, team);
    this.mailboxes.set(teamId, new Mailbox());
    this.taskboards.set(teamId, new TaskBoard());
    this.usedColors.set(teamId, new Set());
    this.sessionTeamMap.set(input.leaderSessionId, teamId);

    this.emit(teamId, { type: "team_created", teamId, name: team.name });
    return team;
  }

  async disbandTeam(teamId: string, reason?: string): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) return;

    // Shutdown all teammates
    await Promise.all(
      team.members.map((m) => this.shutdownTeammate(teamId, m.agentId).catch(() => {}))
    );

    team.status = "shutdown";
    team.updatedAt = Date.now();

    this.emit(teamId, { type: "team_disbanded", teamId, reason });

    // Cleanup after a delay to allow final events to be streamed
    setTimeout(() => {
      this.mailboxes.get(teamId)?.clearAll();
      this.taskboards.get(teamId)?.clear();
      this.mailboxes.delete(teamId);
      this.taskboards.delete(teamId);
      this.usedColors.delete(teamId);
      this.teams.delete(teamId);
      this.sessionTeamMap.delete(team.leaderSessionId);
    }, 5000);
  }

  getTeam(teamId: string): Team | undefined {
    return this.teams.get(teamId);
  }

  getTeamBySession(sessionId: string): Team | undefined {
    const teamId = this.sessionTeamMap.get(sessionId);
    if (!teamId) return undefined;
    return this.teams.get(teamId);
  }

  getAllTeams(): Team[] {
    return Array.from(this.teams.values());
  }

  // ═══════════════════════════════════════════════════════════════
  //  Teammate Lifecycle
  // ═══════════════════════════════════════════════════════════════

  spawnTeammate(teamId: string, config: TeammateConfig): Teammate {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team ${teamId} not found`);
    if (team.status !== "active") throw new Error(`Team ${teamId} is not active`);

    // Check max teammates limit
    const activeMembers = team.members.filter((m) => m.status !== "shutdown");
    if (activeMembers.length >= team.metadata.maxTeammates) {
      throw new Error(
        `Team ${teamId} has reached max teammates limit (${team.metadata.maxTeammates})`
      );
    }

    // Assign color
    const color = this.assignColor(teamId, config.color);

    const agentId = `teammate-${config.name}@${teamId}`;

    // Check duplicate name
    if (team.members.some((m) => m.name === config.name)) {
      throw new Error(`Teammate name "${config.name}" already exists in team ${teamId}`);
    }

    const teammate: Teammate = {
      agentId,
      name: config.name,
      displayName: `${config.name}`,
      color,
      status: "idle",
      spawnedAt: Date.now(),
    };

    team.members.push(teammate);
    team.updatedAt = Date.now();

    // Ensure mailbox inbox exists
    const mailbox = this.mailboxes.get(teamId)!;
    mailbox.send(agentId, {
      from: "team-lead",
      to: agentId,
      type: "chat",
      content: config.initialTask
        ? `你已被创建为 team 成员。初始任务：${config.initialTask}`
        : `你已被创建为 team 成员。等待任务分配。`,
    });

    this.emit(teamId, {
      type: "teammate_spawned",
      agentId,
      name: config.name,
      color,
    });

    return teammate;
  }

  async shutdownTeammate(teamId: string, agentId: string, reason?: string): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) return;

    const member = team.members.find((m) => m.agentId === agentId);
    if (!member) return;

    // Send shutdown request via mailbox
    const mailbox = this.mailboxes.get(teamId);
    if (mailbox) {
      mailbox.send(agentId, {
        from: "team-lead",
        to: agentId,
        type: "shutdown_request",
        content: reason || "Team is being disbanded.",
      });
    }

    // Also directly abort the engine if it exists
    const engine = this.engines.get(agentId);
    if (engine && typeof engine.abort === "function") {
      engine.abort(reason);
    }

    member.status = "shutdown";
    member.completedAt = Date.now();
    team.updatedAt = Date.now();

    this.emit(teamId, { type: "teammate_shutdown", agentId, reason });

    // Clean up after delay
    setTimeout(() => {
      this.engines.delete(agentId);
      mailbox?.clearInbox(agentId);
    }, 1000);
  }

  updateTeammateStatus(
    teamId: string,
    agentId: string,
    status: Teammate["status"],
    currentTaskId?: string
  ): void {
    const team = this.teams.get(teamId);
    if (!team) return;

    const member = team.members.find((m) => m.agentId === agentId);
    if (!member) return;

    member.status = status;
    if (currentTaskId !== undefined) {
      member.currentTaskId = currentTaskId;
    }
    team.updatedAt = Date.now();

    this.emit(teamId, {
      type: "teammate_status_changed",
      agentId,
      status,
      currentTaskId: member.currentTaskId,
    });
  }

  setTeammateResult(teamId: string, agentId: string, result: string): void {
    const team = this.teams.get(teamId);
    if (!team) return;

    const member = team.members.find((m) => m.agentId === agentId);
    if (!member) return;

    member.result = result;
    team.updatedAt = Date.now();
  }

  registerEngine(agentId: string, engine: unknown): void {
    this.engines.set(agentId, engine);
  }

  getEngine(agentId: string): unknown | undefined {
    return this.engines.get(agentId);
  }

  /**
   * Wait for all teammates to finish (completed / error / shutdown).
   * Polls every second. Returns results summary.
   */
  async waitForAllTeammates(
    teamId: string,
    timeoutMs = 300_000
  ): Promise<{
    allDone: boolean;
    timedOut: boolean;
    members: Array<{
      name: string;
      status: string;
      result: string;
    }>;
  }> {
    const start = Date.now();
    const pollInterval = 1000;

    while (Date.now() - start < timeoutMs) {
      const team = this.teams.get(teamId);
      if (!team) {
        throw new Error(`Team ${teamId} not found`);
      }

      const activeMembers = team.members.filter(
        (m) => m.status === "idle" || m.status === "busy"
      );
      if (activeMembers.length === 0) {
        // All done
        return {
          allDone: true,
          timedOut: false,
          members: team.members.map((m) => ({
            name: m.name,
            status: m.status,
            result: m.result || "",
          })),
        };
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    // Timeout
    const team = this.teams.get(teamId);
    return {
      allDone: false,
      timedOut: true,
      members:
        team?.members.map((m) => ({
          name: m.name,
          status: m.status,
          result: m.result || "",
        })) ?? [],
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  Mailbox Operations
  // ═══════════════════════════════════════════════════════════════

  sendMessage(teamId: string, message: Omit<TeamMessage, "id" | "timestamp">): TeamMessage {
    const mailbox = this.mailboxes.get(teamId);
    if (!mailbox) throw new Error(`Team ${teamId} mailbox not found`);

    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team ${teamId} not found`);

    let sent: TeamMessage;
    if (message.to === "*") {
      // Broadcast to all members + team-lead
      const memberIds = team.members.map((m) => m.agentId);
      sent = mailbox.broadcast(memberIds, message, [message.from]);
    } else {
      sent = mailbox.send(message.to, message);
    }

    this.emit(teamId, { type: "message", message: sent });
    return sent;
  }

  getMessages(teamId: string, agentId: string): TeamMessage[] {
    return this.mailboxes.get(teamId)?.read(agentId) ?? [];
  }

  getUnreadMessages(teamId: string, agentId: string): TeamMessage[] {
    return this.mailboxes.get(teamId)?.readUnread(agentId) ?? [];
  }

  markMessagesRead(teamId: string, agentId: string, messageIds: string[]): void {
    this.mailboxes.get(teamId)?.markRead(agentId, messageIds);
  }

  // ═══════════════════════════════════════════════════════════════
  //  Task Board Operations
  // ═══════════════════════════════════════════════════════════════

  createTask(teamId: string, input: TaskCreateInput): TeamTask {
    const board = this.taskboards.get(teamId);
    if (!board) throw new Error(`Team ${teamId} taskboard not found`);

    const task = board.create(input);
    this.emit(teamId, { type: "task_created", task });
    return task;
  }

  getTasks(teamId: string): TeamTask[] {
    return this.taskboards.get(teamId)?.getAll() ?? [];
  }

  getTask(teamId: string, taskId: string): TeamTask | undefined {
    return this.taskboards.get(teamId)?.get(taskId);
  }

  updateTask(
    teamId: string,
    taskId: string,
    updates: Partial<Pick<TeamTask, "subject" | "description" | "owner" | "status" | "priority" | "result">>
  ): TeamTask | undefined {
    const board = this.taskboards.get(teamId);
    if (!board) return undefined;

    const task = board.update(taskId, updates);
    if (!task) return undefined;

    this.emit(teamId, { type: "task_updated", task });

    if (updates.status === "completed") {
      this.emit(teamId, { type: "task_completed", taskId, result: task.result || "" });
    }

    return task;
  }

  assignTask(teamId: string, taskId: string, owner: string): TeamTask | undefined {
    const board = this.taskboards.get(teamId);
    if (!board) return undefined;

    const task = board.assign(taskId, owner);
    if (!task) return undefined;

    this.emit(teamId, { type: "task_updated", task });
    return task;
  }

  getAvailableTasks(teamId: string): TeamTask[] {
    return this.taskboards.get(teamId)?.getAvailableTasks() ?? [];
  }

  deleteTask(teamId: string, taskId: string): boolean {
    return this.taskboards.get(teamId)?.remove(taskId) ?? false;
  }

  getTaskStats(teamId: string) {
    return this.taskboards.get(teamId)?.getStats();
  }

  // ═══════════════════════════════════════════════════════════════
  //  Event Bus (for SSE streaming)
  // ═══════════════════════════════════════════════════════════════

  on(teamId: string, listener: (event: TeamStreamEvent) => void): void {
    this.eventBus.on(teamId, listener);
  }

  off(teamId: string, listener: (event: TeamStreamEvent) => void): void {
    this.eventBus.off(teamId, listener);
  }

  emit(teamId: string, event: TeamStreamEvent): void {
    this.eventBus.emit(teamId, event);
  }

  // ═══════════════════════════════════════════════════════════════
  //  Helpers
  // ═══════════════════════════════════════════════════════════════

  private assignColor(teamId: string, preferred?: string): string {
    const used = this.usedColors.get(teamId) ?? new Set();

    if (preferred && !used.has(preferred)) {
      used.add(preferred);
      return preferred;
    }

    for (const color of DEFAULT_TEAMMATE_COLORS) {
      if (!used.has(color)) {
        used.add(color);
        return color;
      }
    }

    // Fallback: all colors used, pick randomly
    const randomColor =
      DEFAULT_TEAMMATE_COLORS[Math.floor(Math.random() * DEFAULT_TEAMMATE_COLORS.length)];
    used.add(randomColor);
    return randomColor;
  }

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [teamId, team] of this.teams) {
        if (team.status === "shutdown") continue;
        if (now - team.createdAt > TEAM_MAX_AGE_MS) {
          console.log(`[TeamManager] Auto-disbanding team ${teamId} (exceeded max age)`);
          this.disbandTeam(teamId, "Auto-disbanded: exceeded max age").catch(() => {});
        }
      }
    }, 60_000); // Check every minute
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    // Disband all active teams
    for (const [teamId, team] of this.teams) {
      if (team.status !== "shutdown") {
        this.disbandTeam(teamId, "Server shutting down").catch(() => {});
      }
    }
    this.eventBus.removeAllListeners();
  }
}

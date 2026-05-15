// ── TeammateEngine ──
// 复用 SubagentEngine 的 teammate 执行引擎
// 包装层负责：team 上下文注入、inbox 轮询、事件转发、生命周期管理

import type { Config, ToolDef } from "../types.js";
import type { SubagentStreamEvent } from "../subagent/types.js";
import { SubagentEngine } from "../subagent/engine.js";
import type { SubagentDB } from "../subagent/db.js";
import { TeamManager } from "./manager.js";
import { INBOX_POLL_INTERVAL_MS } from "./types.js";
import type { TeamMessage, TeamStreamEvent } from "./types.js";

const MAX_IDLE_POLLS = 120; // 60 seconds of idle before auto-shutdown (120 * 500ms)

export type TeammateStreamEvent = SubagentStreamEvent;

export class TeammateEngine {
  private subagentEngine: SubagentEngine;
  private teamId: string;
  private agentId: string;
  private name: string;
  private abortController = new AbortController();
  private db: SubagentDB;
  private running = false;
  private idlePollCount = 0;

  constructor(
    config: Config,
    db: SubagentDB,
    teamId: string,
    agentId: string,
    name: string
  ) {
    this.subagentEngine = new SubagentEngine(config, db);
    this.db = db;
    this.teamId = teamId;
    this.agentId = agentId;
    this.name = name;
  }

  /**
   * Run the teammate with an initial task.
   * This spawns the subagent engine and starts the inbox poller in parallel.
   */
  async *run(initialTask: string, tools: ToolDef[]): AsyncGenerator<TeammateStreamEvent> {
    if (this.running) {
      throw new Error(`Teammate ${this.agentId} is already running`);
    }
    this.running = true;

    const teamManager = TeamManager.getInstance();

    // Build team-aware system prompt
    const teamSystemPrompt = this.buildTeamSystemPrompt();

    // Start inbox poller in background
    this.startInboxPoller();

    // Register with manager
    teamManager.registerEngine(this.agentId, this);
    teamManager.updateTeammateStatus(this.teamId, this.agentId, "busy");

    try {
      const gen = this.subagentEngine.run(
        this.agentId,
        initialTask,
        tools,
        teamSystemPrompt
      );

      for await (const event of gen) {
        if (this.abortController.signal.aborted) {
          yield { type: "error", message: "Teammate was shut down by leader" };
          return;
        }

        // Forward to team event bus
        teamManager.emit(this.teamId, {
          type: "teammate_event",
          agentId: this.agentId,
          event,
        } as TeamStreamEvent);

        yield event;
      }

      // Subagent completed naturally
      teamManager.updateTeammateStatus(this.teamId, this.agentId, "completed");

      // Send idle notification to leader
      const result = await this.getResultFromDb();
      teamManager.sendMessage(this.teamId, {
        from: this.agentId,
        to: "team-lead",
        type: "idle_notification",
        content: `任务已完成。结果摘要：${result.slice(0, 500)}`,
        metadata: { result },
      });
    } catch (err: any) {
      teamManager.updateTeammateStatus(this.teamId, this.agentId, "error");
      teamManager.sendMessage(this.teamId, {
        from: this.agentId,
        to: "team-lead",
        type: "chat",
        content: `执行出错：${err.message}`,
      });
      yield { type: "error", message: err.message };
    } finally {
      this.running = false;
    }
  }

  /**
   * Abort the teammate execution.
   */
  abort(reason?: string): void {
    this.abortController.abort();
    const teamManager = TeamManager.getInstance();
    teamManager.updateTeammateStatus(this.teamId, this.agentId, "shutdown");
    console.log(`[TeammateEngine] ${this.agentId} aborted: ${reason || "no reason"}`);
  }

  /**
   * Check if the teammate is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Inbox Poller
  // ═══════════════════════════════════════════════════════════════

  private async startInboxPoller(): Promise<void> {
    const teamManager = TeamManager.getInstance();

    while (!this.abortController.signal.aborted) {
      try {
        const unread = teamManager.getUnreadMessages(this.teamId, this.agentId);

        if (unread.length > 0) {
          this.idlePollCount = 0;
          await this.processMessages(unread, teamManager);
        } else {
          this.idlePollCount++;

          // Check for available tasks when idle
          if (this.idlePollCount % 4 === 0) {
            // Every 2 seconds
            await this.checkAndClaimTask(teamManager);
          }

          // Auto-shutdown after prolonged idle
          if (this.idlePollCount > MAX_IDLE_POLLS) {
            console.log(
              `[TeammateEngine] ${this.agentId} auto-shutting down due to idle timeout`
            );
            this.abort("Idle timeout");
            return;
          }
        }
      } catch (err) {
        console.error(`[TeammateEngine] Inbox poller error for ${this.agentId}:`, err);
      }

      await sleep(INBOX_POLL_INTERVAL_MS);
    }
  }

  private async processMessages(
    messages: TeamMessage[],
    teamManager: TeamManager
  ): Promise<void> {
    const messageIds: string[] = [];

    for (const msg of messages) {
      messageIds.push(msg.id);

      switch (msg.type) {
        case "shutdown_request":
          console.log(
            `[TeammateEngine] ${this.agentId} received shutdown request: ${msg.content}`
          );
          teamManager.sendMessage(this.teamId, {
            from: this.agentId,
            to: "team-lead",
            type: "shutdown_response",
            content: "同意关闭。",
          });
          this.abort("Leader requested shutdown");
          break;

        case "task_assignment":
          // Task assignment is informational; teammate will pick it up via task board
          console.log(`[TeammateEngine] ${this.agentId} received task assignment`);
          break;

        case "tool_permission_response":
          // Handled by the tool execution layer (if we implement async permission)
          break;

        case "chat":
        default:
          // Regular chat messages are just logged; the subagent doesn't re-prompt on them
          // because subagent runs autonomously. If we wanted true interactive mode,
          // we'd need to inject these as new user messages into the subagent conversation.
          console.log(`[TeammateEngine] ${this.agentId} chat from ${msg.from}: ${msg.content.slice(0, 100)}`);
          break;
      }
    }

    teamManager.markMessagesRead(this.teamId, this.agentId, messageIds);
  }

  private async checkAndClaimTask(teamManager: TeamManager): Promise<void> {
    // Only claim if currently idle/completed and not running a main task
    if (this.running) return;

    const available = teamManager.getAvailableTasks(this.teamId);
    if (available.length === 0) return;

    // Claim the highest priority task
    const task = available.sort(
      (a, b) =>
        priorityValue(b.priority) - priorityValue(a.priority) ||
        a.createdAt - b.createdAt
    )[0];

    console.log(`[TeammateEngine] ${this.agentId} auto-claiming task ${task.id}`);

    teamManager.assignTask(this.teamId, task.id, this.name);
    teamManager.updateTeammateStatus(this.teamId, this.agentId, "busy", task.id);

    // Note: Auto-claimed tasks would need to be executed.
    // For now, we just notify. Full auto-execution would require
    // restarting the subagent engine with the new task, which is complex
    // because subagent runs in a generator loop.
    // In practice, the leader should explicitly spawn teammates with tasks.
    teamManager.sendMessage(this.teamId, {
      from: this.agentId,
      to: "team-lead",
      type: "chat",
      content: `我已认领任务 "${task.subject}"。请通过工具调用分配给我执行。`,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  System Prompt
  // ═══════════════════════════════════════════════════════════════

  private buildTeamSystemPrompt(): string {
    const teamManager = TeamManager.getInstance();
    const team = teamManager.getTeam(this.teamId);
    if (!team) return "";

    const members = team.members.map((m) => `- ${m.name} (${m.color})`).join("\n");
    const tools = [
      "send_message: 向团队成员发送消息 (to: '<name>' 单播, to: '*' 广播)",
      "create_task: 创建新任务",
      "assign_task: 认领/分配任务",
      "update_task: 更新任务状态",
      "list_tasks: 查看任务板",
      "list_members: 查看团队成员",
    ].join("\n");

    return `
【Agent Team 通信纪律】
你正在作为 "${this.name}" 参与 Team "${team.name}" 的协作。
团队成员：
${members}

重要规则：
1. 直接在回复中写文本，团队其他成员是看不到的 —— 必须使用 send_message 工具通信
2. 使用 send_message to: "<name>" 发送给特定成员
3. 使用 send_message to: "*" 谨慎进行团队广播
4. 使用 update_task 报告你的任务进度
5. 任务完成后，发送 task_result 消息给 leader 并更新任务状态

团队可用工具：
${tools}
`;
  }

  private async getResultFromDb(): Promise<string> {
    try {
      const doc = await this.db.get(this.agentId);
      if (doc?.result) return doc.result;
      if (doc?.messages) {
        const lastAssistant = [...doc.messages]
          .reverse()
          .find((m) => m.role === "assistant");
        return lastAssistant?.content || lastAssistant?.reasoning_content || "";
      }
    } catch {
      // ignore
    }
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function priorityValue(p: string): number {
  switch (p) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

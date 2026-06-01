// ── Team Tool Definitions ──
// 这些工具被注入到 ConversationEngine (Leader) 的工具列表中
// 供 LLM 在 team 协作场景中调用

import type { ToolDef } from "../types.js";
import { TeamManager } from "./manager.js";
import type { TaskPriority } from "./types.js";

/**
 * Create the full set of team tools for the Leader agent.
 */
export function createTeamTools(): ToolDef[] {
  return [
    createTeamCreateTool(),
    createTeamDisbandTool(),
    createTeamSpawnTeammateTool(),
    createTeamSendMessageTool(),
    createTeamListMembersTool(),
    createTeamCreateTaskTool(),
    createTeamAssignTaskTool(),
    createTeamListTasksTool(),
    createTeamUpdateTaskTool(),
    createTeamShutdownTeammateTool(),
    createTeamWaitAllTool(),
  ];
}

// ── team_create ──

function createTeamCreateTool(): ToolDef {
  return {
    name: "team_create",
    description:
      "创建一个 Agent Team。当你面对一个复杂任务，需要多个专门的 agent 协作完成时，调用此工具创建 team。" +
      "创建后，你可以使用 team_spawn_teammate 创建不同角色的 teammate。",
    parameters: [
      {
        name: "name",
        type: "string",
        description: "Team 名称，如 'Research Squad', 'Code Review Team'",
        required: true,
      },
      {
        name: "description",
        type: "string",
        description: "Team 的目标和职责描述",
        required: false,
      },
      {
        name: "max_teammates",
        type: "number",
        description: "最大 teammate 数量（默认 5，最大 8）",
        required: false,
      },
    ],
    execute: async (args, _userId) => {
      const manager = TeamManager.getInstance();
      // Note: sessionId must be provided via context. In the engine, we'll pass it.
      return JSON.stringify({
        error: "This tool must be called with session context. Use the engine integration.",
      });
    },
  };
}

// ── team_disband ──

function createTeamDisbandTool(): ToolDef {
  return {
    name: "team_disband",
    description:
      "解散当前 team。关闭所有 teammate，清理资源。在所有任务完成后调用。",
    parameters: [
      {
        name: "reason",
        type: "string",
        description: "解散原因",
        required: false,
      },
    ],
    execute: async (args, _userId) => {
      return JSON.stringify({
        error: "This tool must be called with session context. Use the engine integration.",
      });
    },
  };
}

// ── team_spawn_teammate ──

function createTeamSpawnTeammateTool(): ToolDef {
  return {
    name: "team_spawn_teammate",
    description:
      "在 team 中创建并启动一个 teammate（子 agent）。每个 teammate 有独立的上下文和完整的工具访问权限。" +
      "适用于：1) 需要并行处理的子任务；2) 需要专门角色的任务（如 researcher, coder, reviewer）。" +
      "注意：teammate 不能创建其他 teammate（扁平结构）。",
    parameters: [
      {
        name: "name",
        type: "string",
        description: "Teammate 名称/角色，如 'researcher', 'coder', 'tester'。必须唯一。",
        required: true,
      },
      {
        name: "task",
        type: "string",
        description: "分配给 teammate 的具体任务描述，要尽可能详细明确",
        required: true,
      },
      {
        name: "color",
        type: "string",
        description:
          "UI 颜色标识：blue, green, purple, orange, pink, cyan, amber, emerald（可选，自动分配）",
        required: false,
      },
      {
        name: "model",
        type: "string",
        description: "模型名称，'inherit' 表示使用 leader 的模型（默认）",
        required: false,
      },
    ],
    execute: async (args, _userId) => {
      return JSON.stringify({
        error: "This tool must be called with session context. Use the engine integration.",
      });
    },
  };
}

// ── team_send_message ──

function createTeamSendMessageTool(): ToolDef {
  return {
    name: "team_send_message",
    description:
      "向 team 成员发送消息。这是 team 内唯一的通信方式 —— 直接在回复中写文本其他成员是看不到的。",
    parameters: [
      {
        name: "to",
        type: "string",
        description: "接收者名称（如 'researcher'）或 '*' 表示广播给所有人",
        required: true,
      },
      {
        name: "content",
        type: "string",
        description: "消息内容",
        required: true,
      },
      {
        name: "message_type",
        type: "string",
        description: "消息类型: chat(默认), task_assignment, task_result",
        required: false,
      },
    ],
    execute: async (args, _userId) => {
      return JSON.stringify({
        error: "This tool must be called with session context. Use the engine integration.",
      });
    },
  };
}

// ── team_list_members ──

function createTeamListMembersTool(): ToolDef {
  return {
    name: "team_list_members",
    description: "查看当前 team 的所有成员及其状态。",
    parameters: [],
    execute: async (args, _userId) => {
      return JSON.stringify({
        error: "This tool must be called with session context. Use the engine integration.",
      });
    },
  };
}

// ── team_create_task ──

function createTeamCreateTaskTool(): ToolDef {
  return {
    name: "team_create_task",
    description:
      "在 team 任务板上创建一个新任务。可以指定负责人，也可以留空让 teammate 自行认领。",
    parameters: [
      {
        name: "subject",
        type: "string",
        description: "任务标题",
        required: true,
      },
      {
        name: "description",
        type: "string",
        description: "任务详细描述，包括目标、输入、期望输出",
        required: true,
      },
      {
        name: "priority",
        type: "string",
        description: "优先级: low, medium(默认), high",
        required: false,
      },
      {
        name: "owner",
        type: "string",
        description: "负责人 teammate 名称（可选）",
        required: false,
      },
      {
        name: "blocks",
        type: "array",
        description: "阻塞的任务 ID 列表（此任务完成后才能开始的任务）",
        items: { type: "string" },
        required: false,
      },
    ],
    execute: async (args, _userId) => {
      return JSON.stringify({
        error: "This tool must be called with session context. Use the engine integration.",
      });
    },
  };
}

// ── team_assign_task ──

function createTeamAssignTaskTool(): ToolDef {
  return {
    name: "team_assign_task",
    description: "将任务分配给指定 teammate，或认领任务给自己（如果是 teammate 调用）。",
    parameters: [
      {
        name: "task_id",
        type: "string",
        description: "任务 ID",
        required: true,
      },
      {
        name: "owner",
        type: "string",
        description: "负责人 teammate 名称",
        required: true,
      },
    ],
    execute: async (args, _userId) => {
      return JSON.stringify({
        error: "This tool must be called with session context. Use the engine integration.",
      });
    },
  };
}

// ── team_list_tasks ──

function createTeamListTasksTool(): ToolDef {
  return {
    name: "team_list_tasks",
    description: "查看 team 任务板上的所有任务及其状态。",
    parameters: [
      {
        name: "filter",
        type: "string",
        description: "过滤条件: all(默认), pending, in_progress, completed",
        required: false,
      },
    ],
    execute: async (args, _userId) => {
      return JSON.stringify({
        error: "This tool must be called with session context. Use the engine integration.",
      });
    },
  };
}

// ── team_update_task ──

function createTeamUpdateTaskTool(): ToolDef {
  return {
    name: "team_update_task",
    description: "更新任务状态、结果或其他属性。teammate 完成任务后应调用此工具。",
    parameters: [
      {
        name: "task_id",
        type: "string",
        description: "任务 ID",
        required: true,
      },
      {
        name: "status",
        type: "string",
        description: "新状态: pending, in_progress, completed, failed",
        required: false,
      },
      {
        name: "result",
        type: "string",
        description: "任务结果/产出",
        required: false,
      },
    ],
    execute: async (args, _userId) => {
      return JSON.stringify({
        error: "This tool must be called with session context. Use the engine integration.",
      });
    },
  };
}

// ── team_shutdown_teammate ──

function createTeamShutdownTeammateTool(): ToolDef {
  return {
    name: "team_shutdown_teammate",
    description: "请求关闭指定 teammate。teammate 完成所有任务后应被关闭。",
    parameters: [
      {
        name: "name",
        type: "string",
        description: "要关闭的 teammate 名称",
        required: true,
      },
      {
        name: "reason",
        type: "string",
        description: "关闭原因",
        required: false,
      },
    ],
    execute: async (args, _userId) => {
      return JSON.stringify({
        error: "This tool must be called with session context. Use the engine integration.",
      });
    },
  };
}

function createTeamWaitAllTool(): ToolDef {
  return {
    name: "team_wait_all",
    description:
      "等待所有 teammate 完成各自的任务。在 spawn 完所有 teammate 后，必须调用此工具等待它们全部完成，然后收集结果返回给用户。" +
      "此工具会阻塞直到所有 teammate 都完成（completed / error / shutdown）。默认等待 30 分钟，足够覆盖绝大多数任务。",
    parameters: [
      {
        name: "timeout_seconds",
        type: "number",
        description: "最长等待时间（秒），默认 1800（30 分钟）。如果任务非常耗时，可适当延长。传 0 表示不限制（不推荐）。",
        required: false,
      },
    ],
    execute: async (args, _userId) => {
      return JSON.stringify({
        error: "This tool must be called with session context. Use the engine integration.",
      });
    },
  };
}

// ═══════════════════════════════════════════════════════════════
//  Engine Integration Helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Execute team tool with full context (sessionId + config).
 * This is called by ConversationEngine with proper context.
 */
export async function executeTeamTool(
  toolName: string,
  args: Record<string, unknown>,
  sessionId: string
): Promise<string> {
  const manager = TeamManager.getInstance();
  const team = manager.getTeamBySession(sessionId);

  switch (toolName) {
    case "team_create": {
      if (team) {
        return JSON.stringify({
          error: `Session already has active team: ${team.teamId}. Use team_disband first.`,
        });
      }
      const maxTeammates =
        typeof args.max_teammates === "number"
          ? Math.min(8, Math.max(1, args.max_teammates))
          : undefined;

      const newTeam = manager.createTeam({
        name: args.name as string,
        description: (args.description as string) || undefined,
        leaderSessionId: sessionId,
        maxTeammates,
      });

      return JSON.stringify({
        teamId: newTeam.teamId,
        name: newTeam.name,
        maxTeammates: newTeam.metadata.maxTeammates,
        message: `Team "${newTeam.name}" 已创建。现在可以使用 team_spawn_teammate 创建 teammate。`,
      });
    }

    case "team_disband": {
      if (!team) {
        return JSON.stringify({ error: "No active team for this session." });
      }
      await manager.disbandTeam(team.teamId, (args.reason as string) || undefined);
      return JSON.stringify({
        message: `Team "${team.name}" 已解散。`,
      });
    }

    case "team_spawn_teammate": {
      if (!team) {
        return JSON.stringify({ error: "No active team. Call team_create first." });
      }
      try {
        const teammate = manager.spawnTeammate(team.teamId, {
          name: args.name as string,
          color: (args.color as string) || undefined,
          initialTask: args.task as string,
          model: (args.model as string) || undefined,
        });

        // Note: The actual engine start is handled by the caller (ConversationEngine)
        // because it needs to pass the tools array.
        return JSON.stringify({
          agentId: teammate.agentId,
          name: teammate.name,
          color: teammate.color,
          status: teammate.status,
          message: `Teammate "${teammate.name}" (${teammate.color}) 已创建。任务: ${args.task}`,
        });
      } catch (err: any) {
        return JSON.stringify({ error: err.message });
      }
    }

    case "team_send_message": {
      if (!team) {
        return JSON.stringify({ error: "No active team." });
      }
      const msgType = (args.message_type as string) || "chat";
      const message = manager.sendMessage(team.teamId, {
        from: "team-lead",
        to: args.to as string,
        type: msgType as any,
        content: args.content as string,
      });
      return JSON.stringify({
        messageId: message.id,
        to: message.to,
        type: message.type,
        content: message.content,
      });
    }

    case "team_list_members": {
      if (!team) {
        return JSON.stringify({ error: "No active team." });
      }
      return JSON.stringify({
        teamId: team.teamId,
        members: team.members.map((m) => ({
          name: m.name,
          color: m.color,
          status: m.status,
          currentTaskId: m.currentTaskId,
        })),
      });
    }

    case "team_create_task": {
      if (!team) {
        return JSON.stringify({ error: "No active team." });
      }
      const priority = (args.priority as TaskPriority) || "medium";
      const blocks = Array.isArray(args.blocks) ? (args.blocks as string[]) : undefined;
      const task = manager.createTask(team.teamId, {
        subject: args.subject as string,
        description: args.description as string,
        priority,
        owner: (args.owner as string) || undefined,
        blocks,
      });
      return JSON.stringify({
        taskId: task.id,
        subject: task.subject,
        status: task.status,
        owner: task.owner,
        message: `任务 "${task.subject}" 已创建。`,
      });
    }

    case "team_assign_task": {
      if (!team) {
        return JSON.stringify({ error: "No active team." });
      }
      const assigned = manager.assignTask(team.teamId, args.task_id as string, args.owner as string);
      if (!assigned) {
        return JSON.stringify({ error: `Task ${args.task_id} not found.` });
      }
      return JSON.stringify({
        taskId: assigned.id,
        subject: assigned.subject,
        owner: assigned.owner,
        status: assigned.status,
        message: `任务 "${assigned.subject}" 已分配给 ${assigned.owner}。`,
      });
    }

    case "team_list_tasks": {
      if (!team) {
        return JSON.stringify({ error: "No active team." });
      }
      const filter = (args.filter as string) || "all";
      let tasks = manager.getTasks(team.teamId);
      if (filter !== "all") {
        tasks = tasks.filter((t) => t.status === filter);
      }
      const stats = manager.getTaskStats(team.teamId);
      return JSON.stringify({
        tasks: tasks.map((t) => ({
          id: t.id,
          subject: t.subject,
          status: t.status,
          owner: t.owner,
          priority: t.priority,
          blocked: t.blockedBy.length > 0,
        })),
        stats,
      });
    }

    case "team_update_task": {
      if (!team) {
        return JSON.stringify({ error: "No active team." });
      }
      const updates: Record<string, unknown> = {};
      if (args.status) updates.status = args.status;
      if (args.result) updates.result = args.result;
      const updated = manager.updateTask(team.teamId, args.task_id as string, updates);
      if (!updated) {
        return JSON.stringify({ error: `Task ${args.task_id} not found.` });
      }
      return JSON.stringify({
        taskId: updated.id,
        status: updated.status,
        message: `任务 "${updated.subject}" 已更新为 ${updated.status}。`,
      });
    }

    case "team_shutdown_teammate": {
      if (!team) {
        return JSON.stringify({ error: "No active team." });
      }
      const member = team.members.find((m) => m.name === args.name);
      if (!member) {
        return JSON.stringify({ error: `Teammate "${args.name}" not found.` });
      }
      await manager.shutdownTeammate(
        team.teamId,
        member.agentId,
        (args.reason as string) || undefined
      );
      return JSON.stringify({
        message: `Teammate "${args.name}" 已关闭。`,
      });
    }

    case "team_wait_all": {
      if (!team) {
        return JSON.stringify({ error: "No active team." });
      }
      const timeoutMs =
        typeof args.timeout_seconds === "number" && args.timeout_seconds > 0
          ? args.timeout_seconds * 1000
          : 1_800_000; // default 30 minutes

      const waitResult = await manager.waitForAllTeammates(team.teamId, timeoutMs);

      const completed = waitResult.members.filter((m) => m.status === "completed");
      const failed = waitResult.members.filter(
        (m) => m.status === "error" || m.status === "shutdown"
      );

      let summary = "";
      if (waitResult.timedOut) {
        summary = `等待超时。部分 teammate 可能仍在运行中。\n\n`;
      } else {
        summary = `所有 teammate 已完成。\n\n`;
      }

      for (const m of waitResult.members) {
        summary += `【${m.name}】状态: ${m.status}\n`;
        if (m.result) {
          summary += `结果: ${m.result}\n`;
        }
        summary += "\n";
      }

      return JSON.stringify({
        allDone: waitResult.allDone,
        timedOut: waitResult.timedOut,
        completed: completed.length,
        failed: failed.length,
        total: waitResult.members.length,
        summary,
        members: waitResult.members,
        message: summary,
      });
    }

    default:
      return JSON.stringify({ error: `Unknown team tool: ${toolName}` });
  }
}

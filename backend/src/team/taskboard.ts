// ── Task Board ──
// 共享任务列表，支持依赖检查和自动可用性计算

import { randomUUID } from "crypto";
import type { TeamTask, TaskStatus, TaskPriority, TaskCreateInput } from "./types.js";

export class TaskBoard {
  private tasks = new Map<string, TeamTask>();

  create(input: TaskCreateInput): TeamTask {
    const task: TeamTask = {
      id: randomUUID(),
      subject: input.subject,
      description: input.description,
      owner: input.owner,
      status: input.owner ? "in_progress" : "pending",
      priority: input.priority ?? "medium",
      blocks: input.blocks ?? [],
      blockedBy: [],
      createdAt: Date.now(),
    };

    // Auto-populate blockedBy from blocks references
    if (task.blocks.length > 0) {
      for (const blockedTaskId of task.blocks) {
        const blocked = this.tasks.get(blockedTaskId);
        if (blocked) {
          if (!blocked.blockedBy.includes(task.id)) {
            blocked.blockedBy.push(task.id);
          }
        }
      }
    }

    this.tasks.set(task.id, task);
    return task;
  }

  get(taskId: string): TeamTask | undefined {
    return this.tasks.get(taskId);
  }

  getAll(): TeamTask[] {
    return Array.from(this.tasks.values()).sort(
      (a, b) => b.createdAt - a.createdAt
    );
  }

  /**
   * Get tasks by status.
   */
  getByStatus(status: TaskStatus): TeamTask[] {
    return this.getAll().filter((t) => t.status === status);
  }

  /**
   * Get tasks assigned to a specific teammate.
   */
  getByOwner(owner: string): TeamTask[] {
    return this.getAll().filter((t) => t.owner === owner);
  }

  /**
   * Update a task. Returns the updated task or undefined if not found.
   */
  update(
    taskId: string,
    updates: Partial<
      Pick<TeamTask, "subject" | "description" | "owner" | "status" | "priority" | "result">
    >
  ): TeamTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    Object.assign(task, updates);

    // Auto-update timestamps
    if (updates.status === "completed" || updates.status === "failed") {
      task.completedAt = Date.now();
    }

    return task;
  }

  /**
   * Assign a task to a teammate.
   */
  assign(taskId: string, owner: string): TeamTask | undefined {
    return this.update(taskId, { owner, status: "in_progress" });
  }

  /**
   * Get all available tasks that a teammate can claim.
   * Criteria: pending, no owner, not blocked by incomplete tasks.
   */
  getAvailableTasks(): TeamTask[] {
    return this.getAll().filter((t) => {
      if (t.status !== "pending") return false;
      if (t.owner) return false;
      // Check if blocked by any incomplete task
      for (const blockerId of t.blockedBy) {
        const blocker = this.tasks.get(blockerId);
        if (blocker && blocker.status !== "completed") {
          return false;
        }
      }
      return true;
    });
  }

  /**
   * Remove a task.
   */
  remove(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    // Clean up blockedBy references from other tasks
    for (const other of this.tasks.values()) {
      other.blocks = other.blocks.filter((id) => id !== taskId);
      other.blockedBy = other.blockedBy.filter((id) => id !== taskId);
    }

    this.tasks.delete(taskId);
    return true;
  }

  /**
   * Clear all tasks (e.g., on team disband).
   */
  clear(): void {
    this.tasks.clear();
  }

  /**
   * Get summary stats.
   */
  getStats(): {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
  } {
    const all = this.getAll();
    return {
      total: all.length,
      pending: all.filter((t) => t.status === "pending").length,
      inProgress: all.filter((t) => t.status === "in_progress").length,
      completed: all.filter((t) => t.status === "completed").length,
      failed: all.filter((t) => t.status === "failed").length,
    };
  }
}

import { schedule, type ScheduledTask } from "node-cron";

interface TaskInfo {
  name: string;
  cron: string;
  task: ScheduledTask;
  handler: () => Promise<void>;
  running: boolean;
  lastRun?: Date;
  lastError?: string;
  runCount: number;
}

export interface TaskStatus {
  name: string;
  cron: string;
  running: boolean;
  lastRun?: Date;
  lastError?: string;
  runCount: number;
}

/**
 * Lightweight task scheduler built on node-cron.
 * Registers named cron jobs with run tracking and manual trigger support.
 */
export class Scheduler {
  private tasks = new Map<string, TaskInfo>();

  /**
   * Register a recurring task.
   * @param name   Unique task identifier
   * @param cron   Cron expression (e.g. "0 3 * * *")
   * @param fn     Async handler
   * @param opts   { timezone?: string }
   */
  register(
    name: string,
    cron: string,
    fn: () => Promise<void>,
    opts: { timezone?: string } = {}
  ): void {
    const handler = async () => {
      const info = this.tasks.get(name)!;
      if (info.running) {
        console.log(`[Scheduler] ${name} skipped: already running`);
        return;
      }
      info.running = true;
      const start = Date.now();
      try {
        await fn();
        info.lastRun = new Date();
        info.runCount++;
        info.lastError = undefined;
        console.log(`[Scheduler] ${name} completed in ${Date.now() - start}ms`);
      } catch (err: any) {
        info.lastError = err.message ?? String(err);
        console.error(`[Scheduler] ${name} failed:`, err);
      } finally {
        info.running = false;
      }
    };

    const task = schedule(cron, handler, { timezone: opts.timezone });

    this.tasks.set(name, {
      name,
      cron,
      task,
      handler,
      running: false,
      runCount: 0,
    });

    console.log(`[Scheduler] registered "${name}" (${cron})`);
  }

  /** List all registered tasks with runtime status. */
  list(): TaskStatus[] {
    return Array.from(this.tasks.values()).map((t) => ({
      name: t.name,
      cron: t.cron,
      running: t.running,
      lastRun: t.lastRun,
      lastError: t.lastError,
      runCount: t.runCount,
    }));
  }

  /** Manually trigger a task by name. */
  async runNow(name: string): Promise<void> {
    const info = this.tasks.get(name);
    if (!info) throw new Error(`Task "${name}" not found`);
    if (info.running) throw new Error(`Task "${name}" is already running`);

    info.running = true;
    const start = Date.now();
    try {
      await info.handler();
      info.lastRun = new Date();
      info.runCount++;
      info.lastError = undefined;
      console.log(`[Scheduler] ${name} (manual) completed in ${Date.now() - start}ms`);
    } catch (err: any) {
      info.lastError = err.message ?? String(err);
      console.error(`[Scheduler] ${name} (manual) failed:`, err);
      throw err;
    } finally {
      info.running = false;
    }
  }

  /** Stop a single task (prevents future executions). */
  stop(name: string): void {
    this.tasks.get(name)?.task.stop();
  }

  /** Resume a stopped task. */
  start(name: string): void {
    this.tasks.get(name)?.task.start();
  }

  /** Stop all tasks. Call on shutdown. */
  stopAll(): void {
    for (const t of this.tasks.values()) {
      t.task.stop();
    }
  }
}

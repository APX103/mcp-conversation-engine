import type { DbManager } from "../db.js";
import type { ResearchTaskDoc, ResearchReportDoc, ResearchStatus } from "./types.js";

export class ResearchDB {
  constructor(private db: DbManager) {}

  private tasks() {
    return this.db.collection("researchTasks");
  }

  private reports() {
    return this.db.collection("researchReports");
  }

  async createTask(doc: Omit<ResearchTaskDoc, "_id" | "createdAt">): Promise<string> {
    const result = await this.tasks().insertOne({
      ...doc,
      createdAt: new Date(),
    } as any);
    return result.insertedId.toString();
  }

  async updateTaskStatus(taskId: string, status: ResearchStatus, extra?: Partial<ResearchTaskDoc>): Promise<void> {
    const update: any = { status };
    if (status === "completed" || status === "failed") {
      update.completedAt = new Date();
    }
    if (extra) Object.assign(update, extra);
    await this.tasks().updateOne(
      { _id: taskId } as any,
      { $set: update }
    );
  }

  async updateTaskPlan(taskId: string, plan: ResearchTaskDoc["plan"]): Promise<void> {
    await this.tasks().updateOne(
      { _id: taskId } as any,
      { $set: { plan } }
    );
  }

  async addFinding(taskId: string, finding: ResearchTaskDoc["findings"][0]): Promise<void> {
    await this.tasks().updateOne(
      { _id: taskId } as any,
      { $push: { findings: finding } } as any
    );
  }

  async setFindings(taskId: string, findings: ResearchTaskDoc["findings"]): Promise<void> {
    await this.tasks().updateOne(
      { _id: taskId } as any,
      { $set: { findings } }
    );
  }

  async incrementRound(taskId: string): Promise<void> {
    await this.tasks().updateOne(
      { _id: taskId } as any,
      { $inc: { currentRound: 1 } }
    );
  }

  async getTask(taskId: string): Promise<ResearchTaskDoc | null> {
    return this.tasks().findOne({ _id: taskId } as any) as Promise<ResearchTaskDoc | null>;
  }

  async saveReport(taskId: string, filePath: string): Promise<void> {
    await this.reports().insertOne({
      taskId,
      filePath,
      createdAt: new Date(),
    } as any);
  }

  async getReport(taskId: string): Promise<string | null> {
    const doc = await this.reports().findOne({ taskId } as any) as any;
    return doc?.filePath ?? null;
  }

  async getLatestTaskBySession(sessionId?: string): Promise<ResearchTaskDoc | null> {
    const query: any = {};
    if (sessionId) query.sessionId = sessionId;
    return this.tasks().findOne(query, { sort: { createdAt: -1 } }) as Promise<ResearchTaskDoc | null>;
  }
}

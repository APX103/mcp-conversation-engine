import type { DbManager } from "../db.js";
import type { SubagentSessionDoc, SubagentStatus } from "./types.js";

export class SubagentDB {
  constructor(private db: DbManager) {}

  private collection() {
    return this.db.collection("subagentSessions");
  }

  async create(doc: Omit<SubagentSessionDoc, "_id" | "createdAt">): Promise<string> {
    const result = await this.collection().insertOne({
      ...doc,
      createdAt: new Date(),
    } as any);
    return result.insertedId.toString();
  }

  async get(subagentId: string): Promise<SubagentSessionDoc | null> {
    return this.collection().findOne({ _id: subagentId } as any) as Promise<SubagentSessionDoc | null>;
  }

  async updateMessages(subagentId: string, messages: SubagentSessionDoc["messages"]): Promise<void> {
    await this.collection().updateOne(
      { _id: subagentId } as any,
      { $set: { messages } }
    );
  }

  async complete(subagentId: string, result: string): Promise<void> {
    await this.collection().updateOne(
      { _id: subagentId } as any,
      { $set: { status: "completed" as SubagentStatus, result, completedAt: new Date() } }
    );
  }

  async fail(subagentId: string, error: string): Promise<void> {
    await this.collection().updateOne(
      { _id: subagentId } as any,
      { $set: { status: "failed" as SubagentStatus, error, completedAt: new Date() } }
    );
  }

  async listByParent(parentSessionId: string): Promise<SubagentSessionDoc[]> {
    const docs = await this.collection()
      .find({ parentSessionId })
      .sort({ createdAt: -1 })
      .toArray();
    return docs as unknown as SubagentSessionDoc[];
  }
}

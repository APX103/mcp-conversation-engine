import { MongoClient, type WithId, type Document } from "mongodb";
import type { ChatMessage } from "./types.js";

export interface SessionDoc {
  sessionId: string;
  userId: string;
  title: string;
  messages: ChatMessage[];
  createdAt: Date;
  updatedAt: Date;
}

export interface LongTermMemoryDoc {
  userId: string;
  markdown: string;
  updatedAt: Date;
}

export interface DailyLogDoc {
  userId: string;
  date: string; // YYYY-MM-DD
  content: string;
  updatedAt: Date;
}

export interface CommitmentDoc {
  _id?: string;
  userId: string;
  content: string;
  dueAt?: Date;
  sourceSessionId?: string;
  fulfilled: boolean;
  createdAt: Date;
}

export class DbManager {
  private client: MongoClient;
  private dbName: string;

  constructor(uri: string, dbName: string) {
    this.client = new MongoClient(uri);
    this.dbName = dbName;
  }

  async connect() {
    await this.client.connect();
    console.log(`MongoDB connected to ${this.dbName}`);
  }

  // ── Sessions ──

  async createSession(userId: string, title = "New Chat"): Promise<string> {
    const sessionId = crypto.randomUUID();
    await this.client.db(this.dbName).collection("sessions").insertOne({
      sessionId,
      userId,
      title,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return sessionId;
  }

  async listSessions(userId: string): Promise<SessionDoc[]> {
    const docs = await this.client
      .db(this.dbName)
      .collection("sessions")
      .find({ userId })
      .sort({ updatedAt: -1 })
      .toArray();
    return docs.map((d) => this.toSessionDoc(d));
  }

  async loadSession(sessionId: string): Promise<ChatMessage[]> {
    const doc = await this.client
      .db(this.dbName)
      .collection("sessions")
      .findOne({ sessionId });
    return (doc?.messages as ChatMessage[]) ?? [];
  }

  async saveSession(sessionId: string, messages: ChatMessage[]) {
    await this.client
      .db(this.dbName)
      .collection("sessions")
      .updateOne(
        { sessionId },
        { $set: { messages, updatedAt: new Date() } },
        { upsert: true }
      );
  }

  async getSession(sessionId: string): Promise<SessionDoc | null> {
    const doc = await this.client
      .db(this.dbName)
      .collection("sessions")
      .findOne({ sessionId });
    if (!doc) return null;
    return this.toSessionDoc(doc);
  }

  async updateSessionTitle(sessionId: string, title: string) {
    await this.client
      .db(this.dbName)
      .collection("sessions")
      .updateOne({ sessionId }, { $set: { title, updatedAt: new Date() } });
  }

  async deleteSession(sessionId: string) {
    await this.client
      .db(this.dbName)
      .collection("sessions")
      .deleteOne({ sessionId });
  }

  // ── Long-term Memory (MEMORY.md) ──

  async getLongTermMemory(userId: string): Promise<LongTermMemoryDoc | null> {
    const doc = await this.client
      .db(this.dbName)
      .collection("memories")
      .findOne({ userId });
    if (!doc) return null;
    return {
      userId: doc.userId as string,
      markdown: doc.markdown as string,
      updatedAt: doc.updatedAt as Date,
    };
  }

  async updateLongTermMemory(userId: string, markdown: string): Promise<void> {
    await this.client
      .db(this.dbName)
      .collection("memories")
      .updateOne(
        { userId },
        { $set: { markdown, updatedAt: new Date() } },
        { upsert: true }
      );
  }

  // ── Daily Logs (memory/YYYY-MM-DD.md) ──

  async appendDailyLog(userId: string, date: string, entry: string): Promise<void> {
    await this.client
      .db(this.dbName)
      .collection("dailyLogs")
      .updateOne(
        { userId, date },
        {
          $set: { userId, date, updatedAt: new Date() },
          $inc: { entryCount: 1 },
          $setOnInsert: { content: "" },
        },
        { upsert: true }
      );
    // Append entry to content
    await this.client
      .db(this.dbName)
      .collection("dailyLogs")
      .updateOne(
        { userId, date },
        { $set: { updatedAt: new Date() }, $inc: { entryCount: 1 } }
      );
    // Use $concat for content (not available in MongoDB, so we fetch and update)
    const doc = await this.client
      .db(this.dbName)
      .collection("dailyLogs")
      .findOne({ userId, date });
    const currentContent = (doc?.content as string) ?? "";
    await this.client
      .db(this.dbName)
      .collection("dailyLogs")
      .updateOne(
        { userId, date },
        { $set: { content: currentContent + entry, updatedAt: new Date() } }
      );
  }

  async getDailyLogs(userId: string, limitDays = 2): Promise<DailyLogDoc[]> {
    const today = new Date();
    const dates: string[] = [];
    for (let i = 0; i < limitDays; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split("T")[0]);
    }
    const docs = await this.client
      .db(this.dbName)
      .collection("dailyLogs")
      .find({ userId, date: { $in: dates } })
      .sort({ date: -1 })
      .toArray();
    return docs.map((d) => ({
      userId: d.userId as string,
      date: d.date as string,
      content: d.content as string,
      updatedAt: d.updatedAt as Date,
    }));
  }

  async getAllDailyLogs(userId: string): Promise<DailyLogDoc[]> {
    const docs = await this.client
      .db(this.dbName)
      .collection("dailyLogs")
      .find({ userId })
      .sort({ date: -1 })
      .toArray();
    return docs.map((d) => ({
      userId: d.userId as string,
      date: d.date as string,
      content: d.content as string,
      updatedAt: d.updatedAt as Date,
    }));
  }

  async deleteDailyLogs(userId: string, olderThanDays?: number): Promise<void> {
    const filter: any = { userId };
    if (olderThanDays) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - olderThanDays);
      filter.date = { $lt: cutoff.toISOString().split("T")[0] };
    }
    await this.client.db(this.dbName).collection("dailyLogs").deleteMany(filter);
  }

  // ── Commitments (Inferred short-term follow-ups) ──

  async addCommitments(userId: string, items: Omit<CommitmentDoc, "_id" | "userId" | "createdAt">[]): Promise<void> {
    if (items.length === 0) return;
    const now = new Date();
    const docs = items.map((item) => ({
      ...item,
      userId,
      createdAt: now,
    }));
    await this.client.db(this.dbName).collection("commitments").insertMany(docs as any);
  }

  async getCommitments(userId: string, includeFulfilled = false): Promise<CommitmentDoc[]> {
    const filter: any = { userId };
    if (!includeFulfilled) filter.fulfilled = false;
    const docs = await this.client
      .db(this.dbName)
      .collection("commitments")
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();
    return docs.map((d) => this.toCommitmentDoc(d));
  }

  async fulfillCommitment(id: string): Promise<void> {
    const { ObjectId } = await import("mongodb");
    await this.client
      .db(this.dbName)
      .collection("commitments")
      .updateOne({ _id: new ObjectId(id) }, { $set: { fulfilled: true } });
  }

  async deleteCommitment(id: string): Promise<void> {
    const { ObjectId } = await import("mongodb");
    await this.client
      .db(this.dbName)
      .collection("commitments")
      .deleteOne({ _id: new ObjectId(id) });
  }

  async clearCommitments(userId: string): Promise<void> {
    await this.client.db(this.dbName).collection("commitments").deleteMany({ userId });
  }

  // ── Flush log (compaction drop record) ──

  async appendFlushLog(userId: string, droppedSummary: string): Promise<void> {
    const today = new Date().toISOString().split("T")[0];
    const entry = `\n[FLUSH] 上下文压缩时抢救:\n${droppedSummary}\n`;
    const doc = await this.client
      .db(this.dbName)
      .collection("dailyLogs")
      .findOne({ userId, date: today });
    const currentContent = (doc?.content as string) ?? "";
    await this.client
      .db(this.dbName)
      .collection("dailyLogs")
      .updateOne(
        { userId, date: today },
        { $set: { content: currentContent + entry, updatedAt: new Date() }, $inc: { entryCount: 1 } },
        { upsert: true }
      );
  }

  // ── Clear all memory ──

  async clearAllMemory(userId: string): Promise<void> {
    await this.client.db(this.dbName).collection("memories").deleteOne({ userId });
    await this.client.db(this.dbName).collection("dailyLogs").deleteMany({ userId });
    await this.client.db(this.dbName).collection("commitments").deleteMany({ userId });
  }

  private toCommitmentDoc(doc: WithId<Document>): CommitmentDoc {
    return {
      _id: (doc._id as any).toString(),
      userId: doc.userId as string,
      content: doc.content as string,
      dueAt: doc.dueAt as Date | undefined,
      sourceSessionId: doc.sourceSessionId as string | undefined,
      fulfilled: doc.fulfilled as boolean,
      createdAt: doc.createdAt as Date,
    };
  }

  private toSessionDoc(doc: WithId<Document>): SessionDoc {
    return {
      sessionId: doc.sessionId as string,
      userId: doc.userId as string,
      title: doc.title as string,
      messages: (doc.messages as ChatMessage[]) ?? [],
      createdAt: doc.createdAt as Date,
      updatedAt: doc.updatedAt as Date,
    };
  }
}

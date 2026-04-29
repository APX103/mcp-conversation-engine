import { MongoClient, ObjectId, type WithId, type Document } from "mongodb";
import type { ChatMessage, KnowledgeItem, KnowledgeType } from "./types.js";

export interface SessionDoc {
  sessionId: string;
  userId: string;
  title: string;
  messages: ChatMessage[];
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeDoc {
  _id: string;
  userId: string;
  type: KnowledgeType;
  content: string;
  sourceSessionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Helper to safely convert string id to ObjectId
function toObjectId(id: string): ObjectId {
  return new ObjectId(id);
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

  // ── Knowledge (Long-term Memory) ──

  async addKnowledge(
    userId: string,
    items: Omit<KnowledgeItem, "id" | "userId" | "createdAt" | "updatedAt">[]
  ): Promise<void> {
    const now = new Date();
    const docs = items.map((item) => ({
      userId,
      type: item.type,
      content: item.content,
      sourceSessionId: item.sourceSessionId,
      createdAt: now,
      updatedAt: now,
    }));
    if (docs.length > 0) {
      await this.client.db(this.dbName).collection("knowledge").insertMany(docs as any);
    }
  }

  async getKnowledge(
    userId: string,
    type?: KnowledgeType
  ): Promise<KnowledgeDoc[]> {
    const filter: any = { userId };
    if (type) filter.type = type;
    const docs = await this.client
      .db(this.dbName)
      .collection("knowledge")
      .find(filter)
      .sort({ updatedAt: -1 })
      .limit(50)
      .toArray();
    return docs.map((d) => this.toKnowledgeDoc(d));
  }

  async deleteKnowledge(id: string): Promise<void> {
    await this.client
      .db(this.dbName)
      .collection("knowledge")
      .deleteOne({ _id: toObjectId(id) });
  }

  async clearKnowledge(userId: string): Promise<void> {
    await this.client
      .db(this.dbName)
      .collection("knowledge")
      .deleteMany({ userId });
  }

  async findSimilarKnowledge(
    userId: string,
    content: string
  ): Promise<KnowledgeDoc[]> {
    // Simple keyword matching using text search or regex
    const keywords = content
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2);
    if (keywords.length === 0) return [];

    const regex = new RegExp(keywords.join("|"), "i");
    const docs = await this.client
      .db(this.dbName)
      .collection("knowledge")
      .find({ userId, content: { $regex: regex } })
      .limit(10)
      .toArray();
    return docs.map((d) => this.toKnowledgeDoc(d));
  }

  private toKnowledgeDoc(doc: WithId<Document>): KnowledgeDoc {
    return {
      _id: (doc._id as ObjectId).toString(),
      userId: doc.userId as string,
      type: doc.type as KnowledgeType,
      content: doc.content as string,
      sourceSessionId: doc.sourceSessionId as string | undefined,
      createdAt: doc.createdAt as Date,
      updatedAt: doc.updatedAt as Date,
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

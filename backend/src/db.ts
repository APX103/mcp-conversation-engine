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

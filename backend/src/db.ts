import { MongoClient } from "mongodb";
import type { ChatMessage } from "./types.js";

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
        { $set: { sessionId, messages, updatedAt: new Date() } },
        { upsert: true }
      );
  }
}

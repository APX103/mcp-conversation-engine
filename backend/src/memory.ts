import OpenAI from "openai";
import type { DbManager } from "./db.js";
import type { ChatMessage, KnowledgeItem, KnowledgeType } from "./types.js";

export class MemoryEngine {
  private openai: OpenAI;
  private model: string;
  private db: DbManager;

  constructor(openai: OpenAI, model: string, db: DbManager) {
    this.openai = openai;
    this.model = model;
    this.db = db;
  }

  /**
   * Extract new knowledge from a conversation and store it.
   * Called asynchronously after a session ends — errors are non-fatal.
   */
  async learn(userId: string, messages: ChatMessage[], sourceSessionId?: string): Promise<void> {
    if (messages.length < 2) return;

    // Only learn from the most recent user+assistant pair
    const recentMessages = this.extractRecentPair(messages);
    if (!recentMessages) return;

    // Fetch existing knowledge for deduplication context
    const existing = await this.db.getKnowledge(userId);
    const existingContext = existing
      .slice(0, 20)
      .map((k) => `- [${k.type}] ${k.content}`)
      .join("\n") || "（暂无）";

    const prompt = `你是一位信息整理专家。你的任务是从对话中提取关于用户的关键信息。

已有知识（请勿重复输出以下内容）：
${existingContext}

请从以下对话中提取用户的关键信息（偏好、习惯、背景、目标、重要事实）。
规则：
1. 只提取跨对话仍有价值的信息，忽略临时性、无价值内容
2. 如果信息已在"已有知识"中，不要重复输出
3. 每条信息用一句话描述，简洁明确
4. type 分类：profile（用户画像/身份）、fact（事实/偏好）、lesson（经验教训/禁忌）

输出严格的 JSON 数组，不要有任何额外文字：
[
  {"type": "profile", "content": "..."},
  {"type": "fact", "content": "..."}
]

如果没有新信息，输出空数组 []。

对话记录：
${recentMessages.map((m) => `${m.role}: ${m.content}`).join("\n")}`;

    try {
      const res = await this.openai.chat.completions.create({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 500,
        temperature: 0.2,
      });

      const raw = res.choices[0]?.message?.content?.trim() || "[]";
      const items = this.parseKnowledge(raw, sourceSessionId);
      if (items.length > 0) {
        await this.db.addKnowledge(userId, items);
      }
    } catch (err) {
      // Silent fail — memory learning should never break the chat flow
      console.error("[Memory] learn failed:", err);
    }
  }

  /**
   * Get formatted memory context for injection into system prompt.
   */
  async getMemoryContext(userId: string): Promise<string> {
    const knowledge = await this.db.getKnowledge(userId);
    if (knowledge.length === 0) return "";

    const profiles = knowledge.filter((k) => k.type === "profile");
    const facts = knowledge.filter((k) => k.type === "fact");
    const lessons = knowledge.filter((k) => k.type === "lesson");

    const lines: string[] = [];
    if (profiles.length > 0) {
      lines.push("用户画像：");
      profiles.forEach((k) => lines.push(`- ${k.content}`));
    }
    if (facts.length > 0) {
      lines.push("已知事实/偏好：");
      facts.forEach((k) => lines.push(`- ${k.content}`));
    }
    if (lessons.length > 0) {
      lines.push("经验教训/注意事项：");
      lessons.forEach((k) => lines.push(`- ${k.content}`));
    }

    return lines.join("\n");
  }

  /**
   * Extract the most recent user→assistant pair from messages.
   */
  private extractRecentPair(messages: ChatMessage[]): ChatMessage[] | null {
    // Find the last user message
    let userIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        userIdx = i;
        break;
      }
    }
    if (userIdx < 0) return null;

    // Include that user message and everything after it (assistant reply + tools)
    return messages.slice(userIdx);
  }

  private parseKnowledge(
    raw: string,
    sourceSessionId?: string
  ): Omit<KnowledgeItem, "id" | "userId" | "createdAt" | "updatedAt">[] {
    try {
      // Handle markdown code blocks
      const jsonStr = raw.replace(/^```json\s*/, "").replace(/\s*```$/, "");
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter(
          (item: any) =>
            item &&
            typeof item.content === "string" &&
            item.content.trim().length > 0 &&
            ["profile", "fact", "lesson"].includes(item.type)
        )
        .map((item: any) => ({
          type: item.type as KnowledgeType,
          content: item.content.trim(),
          sourceSessionId,
        }));
    } catch {
      console.error("[Memory] failed to parse knowledge JSON:", raw);
      return [];
    }
  }
}

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
   * This is the core of Adaptive Knowledge Extraction in the Neural Memory Network.
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

    const prompt = `你是一位认知科学专家，负责执行自适应知识提取 (Adaptive Knowledge Extraction)。

任务：从人机对话中提取持久性知识，构建用户的语义记忆网络 (Semantic Memory Network)。

已有知识图谱（用于去重，请勿重复提取）：
${existingContext}

请从以下对话中提取用户的持久性信息：
- **profile**: 用户画像、身份特征、角色定位
- **fact**: 客观事实、技术偏好、习惯模式  
- **lesson**: 经验教训、禁忌事项、失败案例

提取规则：
1. 只提取跨会话仍有价值的持久信息，忽略临时性内容
2. 若信息已存在于"已有知识图谱"中，严禁重复输出
3. 每条知识用一句话描述，简洁明确，符合知识图谱节点规范
4. 输出严格的 JSON 数组格式，禁止任何额外文字

输出格式示例：
[
  {"type": "profile", "content": "用户是高级技术经理，关注 AI 架构创新"},
  {"type": "fact", "content": "偏好 TypeScript 而非 Java"},
  {"type": "lesson", "content": "在演示中需要强调技术名词和架构图"}
]

如无新信息，输出空数组 []。

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
   * Retrieves from the Semantic Memory Network for cognitive augmentation.
   */
  async getMemoryContext(userId: string): Promise<string> {
    const knowledge = await this.db.getKnowledge(userId);
    if (knowledge.length === 0) return "";

    const profiles = knowledge.filter((k) => k.type === "profile");
    const facts = knowledge.filter((k) => k.type === "fact");
    const lessons = knowledge.filter((k) => k.type === "lesson");

    const lines: string[] = [];
    if (profiles.length > 0) {
      lines.push("【用户画像节点 | Profile Nodes】");
      profiles.forEach((k) => lines.push(`• ${k.content}`));
    }
    if (facts.length > 0) {
      lines.push("【事实网络 | Fact Network】");
      facts.forEach((k) => lines.push(`• ${k.content}`));
    }
    if (lessons.length > 0) {
      lines.push("【经验图谱 | Lesson Graph】");
      lessons.forEach((k) => lines.push(`• ${k.content}`));
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

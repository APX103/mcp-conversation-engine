import OpenAI from "openai";
import type { DbManager } from "./db.js";
import type { ChatMessage } from "./types.js";

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
   * Build memory context for system prompt injection.
   * Returns MEMORY.md + recent daily logs (today + yesterday).
   */
  async getMemoryContext(userId: string): Promise<string> {
    const parts: string[] = [];

    const longTerm = await this.db.getLongTermMemory(userId);
    if (longTerm?.markdown) {
      parts.push(`【长期记忆 | MEMORY.md】\n${longTerm.markdown}`);
    }

    const recentLogs = await this.db.getDailyLogs(userId, 2);
    if (recentLogs.length > 0) {
      const logsText = recentLogs
        .map((log) => `--- ${log.date} ---\n${log.content.slice(0, 800)}`)
        .join("\n\n");
      parts.push(`【近日日志 | Daily Logs】\n${logsText}`);
    }

    return parts.join("\n\n");
  }

  /**
   * Called after each conversation. Handles:
   * 1. Append to daily log
   * 2. Detect inferred commitments
   * 3. Trigger consolidate if enough unconsolidated entries
   */
  async afterConversation(userId: string, messages: ChatMessage[]): Promise<void> {
    await this.appendDailyLog(userId, messages);
    await this.detectCommitments(userId, messages);

    // Check if we should consolidate
    const allLogs = await this.db.getAllDailyLogs(userId);
    const totalEntries = allLogs.reduce((sum, log) => {
      // Rough estimate: count conversation turns by looking for "用户:" lines
      const matches = (log.content.match(/用户:/g) || []).length;
      return sum + matches;
    }, 0);

    // Consolidate when we have >= 3 new conversation turns since last consolidation
    if (totalEntries >= 3) {
      await this.consolidate(userId);
    }
  }

  /**
   * Append the latest conversation turn to today's daily log.
   */
  async appendDailyLog(userId: string, messages: ChatMessage[]): Promise<void> {
    if (messages.length < 2) return;

    const recent = this.extractRecentPair(messages);
    if (!recent) return;

    const today = new Date().toISOString().split("T")[0];

    // Build a concise entry
    const lines = recent
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => {
        const prefix = m.role === "user" ? "用户" : "AI";
        const text = m.content.slice(0, 300);
        return `${prefix}: ${text}`;
      });

    if (lines.length === 0) return;

    const entry = `\n${lines.join("\n")}\n`;

    try {
      await this.db.appendDailyLog(userId, today, entry);
    } catch (err) {
      console.error("[Memory] appendDailyLog failed:", err);
    }
  }

  /**
   * Consolidate daily logs into long-term memory (MEMORY.md).
   * Triggered when unconsolidated entries accumulate or manually.
   */
  async consolidate(userId: string): Promise<void> {
    const longTerm = await this.db.getLongTermMemory(userId);
    const currentMarkdown = longTerm?.markdown ?? "";

    // Fetch all daily logs for consolidation context
    const allLogs = await this.db.getAllDailyLogs(userId);
    if (allLogs.length === 0) return;

    // Only consolidate if there's meaningful new content
    const recentLogs = allLogs.slice(0, 7); // last 7 days
    const logsText = recentLogs
      .map((log) => `## ${log.date}\n${log.content.slice(0, 600)}`)
      .join("\n\n");

    const prompt = `你是一位记忆整理专家。请阅读用户的每日日志，更新长期记忆 (MEMORY.md)。

## 规则
1. 只保留跨会话仍有价值的信息（偏好、习惯、身份、重要决策、禁忌）
2. 去除临时性内容（天气、一次性查询、闲聊）
3. 保持 Markdown 格式，按主题分节（如：用户偏好、技术背景、项目信息、禁忌）
4. 总长度控制在 40 行以内，简洁精炼
5. 如果日志中没有新信息值得长期记住，直接返回现有记忆原文
6. 不要编造日志中没有的信息

## 现有长期记忆
${currentMarkdown || "（暂无）"}

## 最近日志
${logsText}

## 输出
请直接输出更新后的完整长期记忆 Markdown。如无变化，输出原文。不要加任何解释。`;

    try {
      const res = await this.openai.chat.completions.create({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1000,
        temperature: 0.2,
      });

      const text = res.choices[0]?.message?.content?.trim() ?? "";
      if (!text || text === currentMarkdown) return;

      const cleaned = text
        .replace(/^```markdown\s*/, "")
        .replace(/^```\s*/, "")
        .replace(/\s*```$/, "");

      if (cleaned && cleaned !== currentMarkdown) {
        await this.db.updateLongTermMemory(userId, cleaned);
        console.log(`[Memory] consolidated for ${userId}`);
      }
    } catch (err) {
      console.error("[Memory] consolidate failed:", err);
    }
  }

  /**
   * Simple keyword search across all memory (long-term + daily logs).
   */
  async search(userId: string, query: string): Promise<string> {
    const keywords = query
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2);

    if (keywords.length === 0) return "";

    const results: string[] = [];

    // Search long-term memory
    const longTerm = await this.db.getLongTermMemory(userId);
    if (longTerm?.markdown) {
      const lines = longTerm.markdown.split("\n");
      const matched = lines.filter((line) =>
        keywords.some((k) => line.toLowerCase().includes(k.toLowerCase()))
      );
      if (matched.length > 0) {
        results.push(`【长期记忆】\n${matched.join("\n")}`);
      }
    }

    // Search daily logs
    const logs = await this.db.getAllDailyLogs(userId);
    for (const log of logs) {
      const lines = log.content.split("\n");
      const matched = lines.filter((line) =>
        keywords.some((k) => line.toLowerCase().includes(k.toLowerCase()))
      );
      if (matched.length > 0) {
        results.push(`【${log.date}】\n${matched.slice(0, 5).join("\n")}`);
      }
    }

    return results.join("\n\n");
  }

  /**
   * Detect inferred commitments (short-term follow-ups) from conversation.
   * These are things the user explicitly wants to be reminded about later.
   */
  async detectCommitments(userId: string, messages: ChatMessage[]): Promise<void> {
    const recent = this.extractRecentPair(messages);
    if (!recent) return;

    const prompt = `从以下对话中识别用户的短期承诺、待办事项或需要后续跟进的事情。

规则：
1. 只提取用户明确表示"未来要做"或"希望被提醒"的事项
2. 不包括长期偏好（如"我喜欢火锅"），那些属于长期记忆
3. 不包括已经完成的动作
4. 输出 JSON 数组，每条包含 content（内容）和可选的 dueHint（时间提示）

输出格式：
[
  {"content": "面试后提醒用户反馈结果", "dueHint": "面试结束后"},
  {"content": "明天 9 点提醒开会"}
]

如果没有，输出空数组 []。

对话：
${recent.map((m) => `${m.role}: ${m.content.slice(0, 400)}`).join("\n")}`;

    try {
      const res = await this.openai.chat.completions.create({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 300,
        temperature: 0.1,
      });

      const raw = res.choices[0]?.message?.content?.trim() ?? "[]";
      const items = this.parseCommitments(raw);
      if (items.length > 0) {
        await this.db.addCommitments(userId, items);
        console.log(`[Memory] detected ${items.length} commitments for ${userId}`);
      }
    } catch (err) {
      console.error("[Memory] detectCommitments failed:", err);
    }
  }

  /**
   * Get pending commitments for injection into system prompt.
   */
  async getCommitmentsContext(userId: string): Promise<string> {
    const commitments = await this.db.getCommitments(userId, false);
    if (commitments.length === 0) return "";
    const lines = commitments.map((c) => `- ${c.content}`);
    return `【待办提醒】\n${lines.join("\n")}\n请留意以上待办事项。`;
  }

  /**
   * Flush dropped messages to daily log during compaction.
   * This prevents information loss when old messages are compressed away.
   */
  async flushDroppedMessages(userId: string, droppedMessages: ChatMessage[]): Promise<void> {
    if (droppedMessages.length === 0) return;

    // Only keep user messages for the flush log
    const userMessages = droppedMessages
      .filter((m) => m.role === "user")
      .map((m) => m.content.slice(0, 200));

    if (userMessages.length === 0) return;

    const summary = userMessages.map((text) => `- ${text}`).join("\n");
    try {
      await this.db.appendFlushLog(userId, summary);
      console.log(`[Memory] flushed ${userMessages.length} dropped messages for ${userId}`);
    } catch (err) {
      console.error("[Memory] flushDroppedMessages failed:", err);
    }
  }

  private parseCommitments(raw: string): Array<{ content: string; dueAt?: Date; sourceSessionId?: string; fulfilled: boolean }> {
    try {
      let jsonStr = raw.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }
      if (!jsonStr.startsWith("[")) {
        const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          jsonStr = arrayMatch[0];
        }
      }
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((item: any) => item && typeof item.content === "string" && item.content.trim().length > 0)
        .map((item: any) => ({
          content: item.content.trim(),
          dueAt: item.dueHint ? undefined : undefined,
          sourceSessionId: undefined,
          fulfilled: false,
        }));
    } catch {
      console.error("[Memory] failed to parse commitments JSON:", raw);
      return [];
    }
  }

  /**
   * Extract the most recent user→assistant pair from messages.
   */
  private extractRecentPair(messages: ChatMessage[]): ChatMessage[] | null {
    let userIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        userIdx = i;
        break;
      }
    }
    if (userIdx < 0) return null;
    return messages.slice(userIdx);
  }
}

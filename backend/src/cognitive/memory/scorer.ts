import type OpenAI from 'openai';
import type { ChatMessage } from '../../types.js';
import type { CognitiveCandidateDoc } from '../../types.js';

const SCORING_PROMPT = `从以下对话中提取值得长期记住的信息。
对每条信息评分（1-5）：
- 重要性（对用户工作/生活的影响程度）
- 持久性（是否会持续相关）
- 可复用性（未来是否会再次需要）
只返回评分 >= 3 的条目，格式：| 分数 | 类型 | 内容 |
类型限：preference / fact / method / emotion
如果没有值得记住的信息，返回空。

对话：
`;

export class MemoryScorer {
  constructor(private openai: OpenAI, private model: string) {}

  async score(messages: ChatMessage[]): Promise<Omit<CognitiveCandidateDoc, '_id' | 'createdAt' | 'expiresAt' | 'source' | 'stage'>[]> {
    try {
      const conversationText = messages
        .map(m => `[${m.role}] ${m.content}`)
        .join('\n');

      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a memory extraction assistant. Respond only in the specified table format. No explanations.' },
          { role: 'user', content: SCORING_PROMPT + conversationText },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      });

      const text = response.choices[0]?.message?.content || '';
      return this.parseScoring(text);
    } catch (err) {
      console.error('[MemoryScorer] scoring failed:', err);
      return [];
    }
  }

  private parseScoring(text: string): Omit<CognitiveCandidateDoc, '_id' | 'createdAt' | 'expiresAt' | 'source' | 'stage'>[] {
    const candidates: Omit<CognitiveCandidateDoc, '_id' | 'createdAt' | 'expiresAt' | 'source' | 'stage'>[] = [];
    const lines = text.split('\n').filter(l => l.trim().startsWith('|'));

    for (const line of lines) {
      const match = line.match(/\|\s*(\d+)\s*\|\s*(preference|fact|method|emotion)\s*\|\s*(.+?)\s*\|/i);
      if (!match) continue;

      const score = parseInt(match[1], 10);
      if (score < 3) continue;

      const type = match[2].toLowerCase() as CognitiveCandidateDoc['type'];
      const validTypes = ['preference', 'fact', 'method', 'emotion'];
      if (!validTypes.includes(type)) continue;

      const content = match[3].trim();
      if (!content) continue;

      candidates.push({ content, score, type, confidence: score / 5 });
    }

    return candidates;
  }
}

import type OpenAI from 'openai';
import type { DbManager } from '../../db.js';
import type { CognitiveBus } from '../bus.js';
import type { CognitiveCandidateDoc } from '../../types.js';

export interface ReflectionResult {
  toPromote: CognitiveCandidateDoc[];
  discarded: CognitiveCandidateDoc[];
  contradictions: CognitiveCandidateDoc[];
}

const REFLECTION_PROMPT = `你是一个记忆反思助手。对比以下候选记忆和已有长期记忆，判断每条候选记忆该如何处理。

已有记忆：
{existingMemory}

候选记忆：
{candidates}

对每条候选记忆，返回 JSON 对象（key 是候选记忆的 id）：
{{
  "摘要": { "action": "new|boost|contradict|discard", "reason": "简短原因" }
}}

action 含义：
- new: 全新信息，应晋升到长期记忆
- boost: 与已有记忆一致，强化已有记忆
- contradict: 与已有记忆矛盾，标记冲突
- discard: 低价值或重复，应丢弃

只返回 JSON，不要其他内容。`;

export class DreamReflector {
  constructor(
    private bus: CognitiveBus,
    private db: DbManager,
    private openai: OpenAI,
    private model: string,
  ) {}

  async reflect(userId: string): Promise<ReflectionResult> {
    const candidates = await this.db.getCognitiveCandidates(userId, 'candidate');
    if (candidates.length === 0) {
      return { toPromote: [], discarded: [], contradictions: [] };
    }

    try {
      const existing = await this.db.getLongTermMemory(userId);
      const existingMarkdown = existing?.markdown || '(无已有记忆)';
      const candidatesText = candidates.map(c => `- [${c.type}] (id: ${c._id}) ${c.content}`).join('\n');

      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a memory reflection assistant. Output only valid JSON.' },
          { role: 'user', content: REFLECTION_PROMPT
            .replace('{existingMemory}', existingMarkdown)
            .replace('{candidates}', candidatesText) },
        ],
        temperature: 0.1,
        max_tokens: 3000,
      });

      const text = response.choices[0]?.message?.content?.trim() || '';
      return this.parseReflection(candidates, text);
    } catch (err) {
      console.error('[DreamReflector] reflection failed, falling back to promote all:', err);
      return { toPromote: candidates, discarded: [], contradictions: [] };
    }
  }

  private parseReflection(candidates: CognitiveCandidateDoc[], text: string): ReflectionResult {
    const result: ReflectionResult = { toPromote: [], discarded: [], contradictions: [] };

    try {
      const parsed = JSON.parse(text);
      const actionMap = new Map<string, string>();

      for (const [key, value] of Object.entries(parsed)) {
        const entry = value as any;
        if (entry?.action) actionMap.set(key, entry.action);
      }

      for (const candidate of candidates) {
        const candidateId = candidate._id?.toString() || '';
        let matched = false;
        for (const [key, action] of actionMap) {
          if (candidateId === key || candidateId.includes(key) || key.includes(candidateId)) {
            switch (action) {
              case 'boost':
                // Boost existing memory - don't add candidate, but mark as promoted
                this.db.updateCandidateStage(candidateId, 'promoted');
                break;
              case 'contradict':
                result.contradictions.push(candidate);
                break;
              case 'discard':
                result.discarded.push(candidate);
                break;
              default:
                result.toPromote.push(candidate);
            }
            matched = true;
            break;
          }
        }
        if (!matched) {
          // No match found — default to promote
          result.toPromote.push(candidate);
        }
      }
    } catch (err) {
      console.error('[DreamReflector] parse failed, promoting all candidates');
      return { toPromote: candidates, discarded: [], contradictions: [] };
    }

    return result;
  }
}

import type OpenAI from 'openai';
import type { DbManager } from '../../db.js';
import type { CognitiveBus, DreamPromotePayload } from '../bus.js';
import type { CognitiveCandidateDoc } from '../../types.js';
import { DreamReflector } from './reflector.js';

const PROMOTE_PROMPT = `你是一个记忆整合助手。将以下已有长期记忆和新候选记忆合并为一份更新的长期记忆文档。
规则：
- 保留已有记忆中有价值的部分
- 加入新的候选记忆（去重，合并相似项）
- 只保留跨会话有价值的持久信息
- 删除临时性、过时、琐碎的内容
- 输出格式为 Markdown

已有记忆：
{existingMemory}

新候选记忆：
{candidates}
`;

export class DreamPromoter {
  private reflector: DreamReflector;

  constructor(
    private bus: CognitiveBus,
    private db: DbManager,
    private openai: OpenAI,
    private model: string,
  ) {
    this.reflector = new DreamReflector(bus, db, openai, model);
    this.bus.on('dream.promote.start', this.handlePromote.bind(this));
  }

  private async handlePromote(payload: DreamPromotePayload): Promise<void> {
    const { userId } = payload;

    // Step 1: Run reflector to cross-validate candidates
    const { toPromote, discarded, contradictions } = await this.reflector.reflect(userId);

    // Step 2: Mark discarded candidates
    for (const candidate of discarded) {
      const id = candidate._id?.toString();
      if (id) {
        await this.db.updateCandidateStage(id, 'discarded');
      }
    }

    // Step 3: Log contradictions for review
    if (contradictions.length > 0) {
      console.log('[DreamPromoter] found contradictions:', contradictions.map(c => ({
        id: c._id?.toString(),
        content: c.content,
      })));
    }

    // Step 4: Only promote validated candidates
    if (toPromote.length === 0) {
      // Clean up all candidates regardless
      await this.db.deleteCandidates(userId, 'candidate');
      return;
    }

    const existing = await this.db.getLongTermMemory(userId);
    const existingMarkdown = existing?.markdown || '(无已有记忆)';
    const candidatesText = toPromote.map(c => `- [${c.type}] (score: ${c.score}) ${c.content}`).join('\n');

    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a memory consolidation assistant. Output only the merged memory document in Markdown.' },
          { role: 'user', content: PROMOTE_PROMPT
            .replace('{existingMemory}', existingMarkdown)
            .replace('{candidates}', candidatesText) },
        ],
        temperature: 0.1,
        max_tokens: 4000,
      });

      const newMemory = response.choices[0]?.message?.content || existingMarkdown;
      await this.db.updateLongTermMemory(userId, newMemory);
      await this.db.deleteCandidates(userId, 'candidate');
    } catch (err) {
      console.error('[DreamPromoter] promotion failed for', userId, err);
    }
  }
}

import type { DbManager } from '../../db.js';
import type { CognitiveConfig } from '../config.js';
import type { CognitiveBus, ConversationEndPayload } from '../bus.js';
import type { MemoryScorer } from '../memory/scorer.js';

export class DreamCollector {
  constructor(
    private bus: CognitiveBus,
    private scorer: MemoryScorer,
    private db: DbManager,
    private config: CognitiveConfig,
  ) {
    this.bus.on('conversation.end', this.handleConversationEnd.bind(this));
  }

  private async handleConversationEnd(payload: ConversationEndPayload): Promise<void> {
    if (payload.messages.length < 2) return;

    const candidates = await this.scorer.score(payload.messages);
    for (const cand of candidates) {
      await this.db.addCognitiveCandidate({
        ...cand,
        userId: payload.userId,
        source: `conversation-${Date.now()}`,
        stage: 'candidate',
      });
    }

    if (candidates.length > 0) {
      const count = await this.db.countCandidates(payload.userId, 'candidate');
      if (count >= this.config.dream.threshold) {
        await this.bus.emit('dream.promote.start', {
          userId: payload.userId,
          candidates: await this.db.getCognitiveCandidates(payload.userId, 'candidate'),
        });
      }
    }
  }
}

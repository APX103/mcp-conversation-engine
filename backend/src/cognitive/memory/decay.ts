import type { DbManager } from '../../db.js';
import type { CognitiveConfig } from '../config.js';

export class DecayEngine {
  constructor(
    private db: DbManager,
    private config: CognitiveConfig,
  ) {}

  async applyDailyDecay(userId: string): Promise<number> {
    const candidates = await this.db.getCognitiveCandidates(userId, 'candidate');
    let cleanedCount = 0;

    for (const candidate of candidates) {
      const currentDecay = candidate.decay ?? 1.0;
      const newDecay = Math.max(0, currentDecay - this.config.dream.decay.rate);

      if (newDecay < this.config.dream.decay.min) {
        await this.db.deleteCandidates(userId, 'candidate');
        cleanedCount++;
      } else {
        await this.db.updateCandidateDecay(candidate._id!.toString(), newDecay);
      }
    }

    return cleanedCount;
  }

  async boostOnRetrieval(candidateId: string): Promise<void> {
    // Placeholder for retrieval engine integration.
    // The retrieval engine will call this when a candidate memory is hit.
    // Future implementation will fetch the candidate, compute boosted decay,
    // and persist it via updateCandidateDecay.
  }

  getDecayedScore(originalScore: number, decay: number): number {
    return originalScore * decay;
  }
}

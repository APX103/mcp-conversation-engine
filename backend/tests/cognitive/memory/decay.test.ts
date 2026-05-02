import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DecayEngine } from '../../../src/cognitive/memory/decay.js';

describe('DecayEngine', () => {
  let mockDb: Partial<any>;

  beforeEach(() => {
    mockDb = {
      getCognitiveCandidates: vi.fn(),
      updateCandidateDecay: vi.fn().mockResolvedValue(undefined),
      deleteCandidates: vi.fn().mockResolvedValue(1),
    };
  });

  it('should decay candidates and cleanup low-decay ones', async () => {
    mockDb.getCognitiveCandidates = vi.fn().mockResolvedValue([
      { _id: 'c1', decay: 0.11, content: 'Old memory' },
      { _id: 'c2', decay: 0.5, content: 'Recent memory' },
    ]);

    const engine = new DecayEngine(mockDb as any, {
      dream: { decay: { rate: 0.02, boost: 0.1, min: 0.1 } },
    } as any);

    const cleaned = await engine.applyDailyDecay('u1');
    expect(cleaned).toBe(1); // c1 drops below 0.1
    expect(mockDb.deleteCandidates).toHaveBeenCalledWith('u1', 'candidate');
    expect(mockDb.updateCandidateDecay).toHaveBeenCalledWith('c2', 0.48);
  });

  it('should calculate decayed score', () => {
    const engine = new DecayEngine({} as any, {
      dream: { decay: { rate: 0.02, boost: 0.1, min: 0.1 } },
    } as any);

    expect(engine.getDecayedScore(5, 1.0)).toBe(5);
    expect(engine.getDecayedScore(5, 0.5)).toBe(2.5);
    expect(engine.getDecayedScore(5, 0.0)).toBe(0);
  });
});

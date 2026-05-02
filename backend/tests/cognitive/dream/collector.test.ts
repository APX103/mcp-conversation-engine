import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DreamCollector } from '../../../src/cognitive/dream/collector.js';
import { CognitiveBus } from '../../../src/cognitive/bus.js';
import type { DbManager } from '../../../src/db.js';
import type { MemoryScorer } from '../../../src/cognitive/memory/scorer.js';
import type { CognitiveConfig } from '../../../src/cognitive/config.js';

describe('DreamCollector', () => {
  let bus: CognitiveBus;
  let mockDb: Partial<DbManager>;
  let mockScorer: Partial<MemoryScorer>;
  let collector: DreamCollector;

  beforeEach(() => {
    bus = new CognitiveBus();
    mockDb = {
      addCognitiveCandidate: vi.fn().mockResolvedValue('cand-1'),
      countCandidates: vi.fn().mockResolvedValue(3),
      getCognitiveCandidates: vi.fn().mockResolvedValue([]),
    };
    mockScorer = {
      score: vi.fn().mockResolvedValue([
        { content: 'User prefers dark mode', score: 4, type: 'preference', confidence: 0.8 },
      ]),
    };
    collector = new DreamCollector(
      bus, mockScorer as MemoryScorer, mockDb as DbManager,
      { dream: { minScore: 3, threshold: 5 } } as CognitiveConfig
    );
  });

  it('should subscribe to conversation.end and score messages', async () => {
    await bus.emit('conversation.end', {
      userId: 'u1',
      messages: [
        { role: 'user' as const, content: 'I like dark mode' },
        { role: 'assistant' as const, content: 'Noted' },
      ],
      toolCallCount: 0,
    });

    expect(mockScorer.score).toHaveBeenCalledTimes(1);
    expect(mockDb.addCognitiveCandidate).toHaveBeenCalledTimes(1);
    expect(mockDb.addCognitiveCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'User prefers dark mode', score: 4 })
    );
  });

  it('should emit dream.promote.start when threshold reached', async () => {
    mockDb.countCandidates = vi.fn().mockResolvedValue(5);
    const promoteHandler = vi.fn();
    bus.on('dream.promote.start', promoteHandler);

    await bus.emit('conversation.end', {
      userId: 'u1',
      messages: [
        { role: 'user' as const, content: 'I like dark mode' },
        { role: 'assistant' as const, content: 'Noted' },
      ],
      toolCallCount: 0,
    });

    expect(promoteHandler).toHaveBeenCalledTimes(1);
    expect(promoteHandler).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' })
    );
  });
});

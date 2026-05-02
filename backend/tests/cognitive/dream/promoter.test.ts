import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DreamPromoter } from '../../../src/cognitive/dream/promoter.js';
import { CognitiveBus } from '../../../src/cognitive/bus.js';
import type { DbManager } from '../../../src/db.js';

describe('DreamPromoter', () => {
  let bus: CognitiveBus;
  let mockDb: Partial<DbManager>;

  beforeEach(() => {
    bus = new CognitiveBus();
    mockDb = {
      getLongTermMemory: vi.fn().mockResolvedValue({ markdown: '# Existing\n\nKnown facts.', updatedAt: Date.now() }),
      updateLongTermMemory: vi.fn().mockResolvedValue(undefined),
      deleteCandidates: vi.fn().mockResolvedValue(2),
      getCognitiveCandidates: vi.fn().mockResolvedValue([
        { _id: 'c1', content: 'User prefers dark mode', score: 4, type: 'preference', confidence: 0.8 },
        { _id: 'c2', content: 'User uses Beijing timezone', score: 3, type: 'fact', confidence: 0.6 },
      ]),
    };
  });

  it('should promote candidates to long-term memory and clean up', async () => {
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '# Updated Memory\n\n- User prefers dark mode\n- User uses Beijing timezone' } }],
          }),
        },
      },
    };

    const promoter = new DreamPromoter(bus, mockDb as any, mockOpenai as any, 'test-model');
    await bus.emit('dream.promote.start', {
      userId: 'u1',
      candidates: [],
    });

    expect(mockDb.updateLongTermMemory).toHaveBeenCalledWith('u1', expect.stringContaining('dark mode'));
    expect(mockDb.deleteCandidates).toHaveBeenCalledWith('u1', 'candidate');
  });
});

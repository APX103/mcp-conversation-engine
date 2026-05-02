import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DreamPromoter } from '../../../src/cognitive/dream/promoter.js';
import { DreamReflector } from '../../../src/cognitive/dream/reflector.js';
import { CognitiveBus } from '../../../src/cognitive/bus.js';
import type { DbManager } from '../../../src/db.js';
import type { CognitiveCandidateDoc } from '../../../src/types.js';

// Spy on DreamReflector prototype
const reflectSpy = vi.spyOn(DreamReflector.prototype, 'reflect');

describe('DreamPromoter', () => {
  let bus: CognitiveBus;
  let mockDb: Partial<DbManager>;

  const candidates: CognitiveCandidateDoc[] = [
    { _id: 'c1', userId: 'u1', content: 'User prefers dark mode', score: 4, type: 'preference', confidence: 0.8, source: 'conv-1', stage: 'candidate' },
    { _id: 'c2', userId: 'u1', content: 'User uses Beijing timezone', score: 3, type: 'fact', confidence: 0.6, source: 'conv-2', stage: 'candidate' },
    { _id: 'c3', userId: 'u1', content: 'Low value info', score: 1, type: 'fact', confidence: 0.2, source: 'conv-3', stage: 'candidate' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    bus = new CognitiveBus();
    mockDb = {
      getLongTermMemory: vi.fn().mockResolvedValue({ markdown: '# Existing\n\nKnown facts.', updatedAt: Date.now() }),
      updateLongTermMemory: vi.fn().mockResolvedValue(undefined),
      deleteCandidates: vi.fn().mockResolvedValue(2),
      getCognitiveCandidates: vi.fn().mockResolvedValue(candidates),
      updateCandidateStage: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('should run reflector first and only promote validated candidates', async () => {
    // Reflector returns: c1 to promote, c2 contradicted, c3 discarded
    reflectSpy.mockResolvedValue({
      toPromote: [candidates[0]],
      discarded: [candidates[2]],
      contradictions: [candidates[1]],
    });

    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '# Updated Memory\n\n- User prefers dark mode' } }],
          }),
        },
      },
    };

    const promoter = new DreamPromoter(bus, mockDb as any, mockOpenai as any, 'test-model');
    await bus.emit('dream.promote.start', {
      userId: 'u1',
      candidates: [],
    });

    // Reflector should have been called
    expect(reflectSpy).toHaveBeenCalledWith('u1');

    // Only validated candidates should be in the merge prompt
    const mergeCall = mockOpenai.chat.completions.create;
    expect(mergeCall).toHaveBeenCalled();
    const callArgs = mergeCall.mock.calls[0][0];
    const userContent = (callArgs.messages as any[])[1].content as string;
    expect(userContent).toContain('dark mode');
    expect(userContent).not.toContain('Beijing timezone');
    expect(userContent).not.toContain('Low value info');

    // Memory should be updated
    expect(mockDb.updateLongTermMemory).toHaveBeenCalledWith('u1', expect.stringContaining('dark mode'));

    // Discarded candidate should be marked
    expect(mockDb.updateCandidateStage).toHaveBeenCalledWith('c3', 'discarded');

    // Contradictions logged (no specific DB call, just verify promoter didn't crash)
    // deleteCandidates should have been called
    expect(mockDb.deleteCandidates).toHaveBeenCalledWith('u1', 'candidate');
  });

  it('should skip promotion when reflector returns no candidates to promote', async () => {
    reflectSpy.mockResolvedValue({
      toPromote: [],
      discarded: [candidates[0], candidates[1], candidates[2]],
      contradictions: [],
    });

    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '# Updated Memory\n\nKnown facts.' } }],
          }),
        },
      },
    };

    const promoter = new DreamPromoter(bus, mockDb as any, mockOpenai as any, 'test-model');
    await bus.emit('dream.promote.start', {
      userId: 'u1',
      candidates: [],
    });

    // All candidates should be marked as discarded
    expect(mockDb.updateCandidateStage).toHaveBeenCalledWith('c1', 'discarded');
    expect(mockDb.updateCandidateStage).toHaveBeenCalledWith('c2', 'discarded');
    expect(mockDb.updateCandidateStage).toHaveBeenCalledWith('c3', 'discarded');

    // deleteCandidates should still be called to clean up
    expect(mockDb.deleteCandidates).toHaveBeenCalledWith('u1', 'candidate');
  });

  it('should mark contradictions and log them', async () => {
    reflectSpy.mockResolvedValue({
      toPromote: [candidates[0]],
      discarded: [],
      contradictions: [candidates[1], candidates[2]],
    });

    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '# Updated Memory\n\n- User prefers dark mode' } }],
          }),
        },
      },
    };

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const promoter = new DreamPromoter(bus, mockDb as any, mockOpenai as any, 'test-model');
    await bus.emit('dream.promote.start', {
      userId: 'u1',
      candidates: [],
    });

    // Contradictions should be logged
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[DreamPromoter]'),
      expect.any(Array),
    );

    consoleSpy.mockRestore();
  });
});

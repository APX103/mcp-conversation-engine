import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DreamReflector } from '../../../src/cognitive/dream/reflector.js';
import { CognitiveBus } from '../../../src/cognitive/bus.js';
import type { DbManager } from '../../../src/db.js';
import type { CognitiveCandidateDoc } from '../../../src/types.js';

describe('DreamReflector', () => {
  let bus: CognitiveBus;
  let mockDb: Partial<DbManager>;

  const candidates: CognitiveCandidateDoc[] = [
    { _id: 'c1', userId: 'u1', content: 'User prefers dark mode', score: 4, type: 'preference', confidence: 0.8, source: 'conv-1', stage: 'candidate' },
    { _id: 'c2', userId: 'u1', content: 'User works in Beijing', score: 3, type: 'fact', confidence: 0.6, source: 'conv-2', stage: 'candidate' },
    { _id: 'c3', userId: 'u1', content: 'The weather is nice today', score: 3, type: 'fact', confidence: 0.6, source: 'conv-3', stage: 'candidate' },
  ];

  beforeEach(() => {
    bus = new CognitiveBus();
    mockDb = {
      getLongTermMemory: vi.fn().mockResolvedValue({
        markdown: '# Memory\n\n- User prefers light mode\n- User works in Shanghai',
      }),
      getCognitiveCandidates: vi.fn().mockResolvedValue(candidates),
      updateCandidateStage: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('should reflect on candidates and categorize them', async () => {
    // Mock LLM: c1 contradicts existing (light mode vs dark mode), c2 is new (Beijing), c3 is low value
    const mockOpenai = {
      chat: { completions: { create: vi.fn().mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({
          c1: { action: 'contradict', reason: 'Existing says light mode, candidate says dark mode' },
          c2: { action: 'new', reason: 'Different city than existing Shanghai' },
          c3: { action: 'discard', reason: 'Ephemeral weather info, not worth keeping' },
        }) } }],
      }) } },
    };

    const reflector = new DreamReflector(bus, mockDb as any, mockOpenai as any, 'test-model');

    const results = await reflector.reflect('u1');

    expect(results).toBeDefined();
    expect(results.toPromote).toHaveLength(1);
    expect(results.toPromote[0].content).toContain('Beijing');
    expect(results.discarded).toHaveLength(1);
    expect(results.contradictions).toHaveLength(1);
    expect(results.contradictions[0].content).toContain('dark mode');
  });

  it('should handle LLM failure gracefully', async () => {
    const mockOpenai = {
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error('timeout')) } },
    };
    const reflector = new DreamReflector(bus, mockDb as any, mockOpenai as any, 'test-model');
    const results = await reflector.reflect('u1');
    expect(results.toPromote.length).toBeGreaterThan(0); // fallback: promote all
  });

  it('should handle malformed LLM response', async () => {
    const mockOpenai = {
      chat: { completions: { create: vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'not json' } }],
      }) } },
    };
    const reflector = new DreamReflector(bus, mockDb as any, mockOpenai as any, 'test-model');
    const results = await reflector.reflect('u1');
    expect(results.toPromote.length).toBeGreaterThan(0); // fallback
  });
});

import { describe, it, expect, vi } from 'vitest';
import { MemoryScorer } from '../../../src/cognitive/memory/scorer.js';
import type { ChatMessage } from '../../../src/types.js';

const createMockOpenai = (response: string) => ({
  chat: {
    completions: {
      create: vi.fn().mockResolvedValue({
        choices: [{ message: { content: response } }],
      }),
    },
  },
});

const sampleMessages: ChatMessage[] = [
  { role: 'user', content: 'I prefer using TypeScript for all my projects' },
  { role: 'assistant', content: "Noted! I'll remember your preference for TypeScript." },
  { role: 'user', content: 'Also, I work in the Beijing timezone' },
  { role: 'assistant', content: 'Got it, Beijing time (UTC+8) noted.' },
];

describe('MemoryScorer', () => {
  it('should extract and score candidate memories from conversation', async () => {
    const mockResponse = `| 4 | preference | User strongly prefers TypeScript for all projects |
| 3 | fact | User works in Beijing timezone (UTC+8) |
| 1 | fact | User sent a greeting message`;
    const mockOpenai = createMockOpenai(mockResponse) as any;
    const scorer = new MemoryScorer(mockOpenai, 'test-model');

    const candidates = await scorer.score(sampleMessages);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      content: expect.stringContaining('TypeScript'),
      score: 4,
      type: 'preference',
    });
    expect(candidates[1]).toMatchObject({
      content: expect.stringContaining('Beijing'),
      score: 3,
      type: 'fact',
    });
  });

  it('should return empty array when no high-score items', async () => {
    const mockOpenai = createMockOpenai('| 2 | fact | User mentioned the weather |') as any;
    const scorer = new MemoryScorer(mockOpenai, 'test-model');
    const candidates = await scorer.score(sampleMessages);
    expect(candidates).toHaveLength(0);
  });

  it('should return empty array on malformed LLM response', async () => {
    const mockOpenai = createMockOpenai('Sorry, I cannot process this.') as any;
    const scorer = new MemoryScorer(mockOpenai, 'test-model');
    const candidates = await scorer.score(sampleMessages);
    expect(candidates).toHaveLength(0);
  });

  it('should return empty array on LLM failure', async () => {
    const mockOpenai = {
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error('API timeout')) } },
    };
    const scorer = new MemoryScorer(mockOpenai as any, 'test-model');
    const candidates = await scorer.score(sampleMessages);
    expect(candidates).toHaveLength(0);
  });
});

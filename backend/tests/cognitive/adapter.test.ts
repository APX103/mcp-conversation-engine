import { describe, it, expect, vi } from 'vitest';
import { CognitiveAdapter } from '../../src/cognitive/adapter.js';
import { CognitiveBus } from '../../src/cognitive/bus.js';
import type { DbManager } from '../../src/db.js';

const mockDb = {
  getLongTermMemory: vi.fn().mockResolvedValue({ markdown: '# Memory\n\nTypeScript fan' }),
  getDailyLogs: vi.fn().mockResolvedValue([{ date: '2026-05-02', content: 'Some log' }]),
  getActiveCognitiveSkills: vi.fn().mockResolvedValue([]),
  getCommitments: vi.fn().mockResolvedValue([]),
  getEnabledSkills: vi.fn().mockResolvedValue([]),
};

describe('CognitiveAdapter', () => {
  it('should emit conversation.end with correct payload', async () => {
    const bus = new CognitiveBus();
    const spy = vi.fn();
    bus.on('conversation.end', spy);

    const adapter = new CognitiveAdapter(bus, mockDb as any, {
      retrieval: { topK: 3, bm25: { enabled: true }, vector: { enabled: false }, fusion: { method: 'rrf' as const, k: 60 } },
    } as any);

    await adapter.afterConversation('u1', [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 't1', name: 'fetch_url', arguments: '{}' }] },
      { role: 'tool' as const, content: 'result', tool_call_id: 't1' },
    ]);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', toolCallCount: 1 })
    );
  });

  it('should get memory context via retrieval', async () => {
    const adapter = new CognitiveAdapter(new CognitiveBus(), mockDb as any, {
      retrieval: { topK: 3, bm25: { enabled: true }, vector: { enabled: false }, fusion: { method: 'rrf' as const, k: 60 } },
    } as any);

    const context = await adapter.getMemoryContext('u1', 'TypeScript');
    expect(typeof context).toBe('string');
  });

  it('should fallback to full memory when no query', async () => {
    const adapter = new CognitiveAdapter(new CognitiveBus(), mockDb as any, {
      retrieval: { topK: 3, bm25: { enabled: true }, vector: { enabled: false }, fusion: { method: 'rrf' as const, k: 60 } },
    } as any);

    const context = await adapter.getMemoryContext('u1');
    expect(context).toContain('TypeScript');
  });

  it('should get skills context including cognitive skills', async () => {
    mockDb.getEnabledSkills = vi.fn().mockResolvedValue([
      { name: 'emoji-translator', content: 'Translate to emoji' },
    ]);
    mockDb.getActiveCognitiveSkills = vi.fn().mockResolvedValue([
      { name: 'debug-workflow', content: 'Debug steps', confidence: 0.9 },
    ]);

    const adapter = new CognitiveAdapter(new CognitiveBus(), mockDb as any, {
      retrieval: { topK: 3, bm25: { enabled: true }, vector: { enabled: false }, fusion: { method: 'rrf' as const, k: 60 } },
    } as any);

    const ctx = await adapter.getSkillsContext('u1');
    expect(ctx).toContain('emoji-translator');
    expect(ctx).toContain('debug-workflow');
  });
});

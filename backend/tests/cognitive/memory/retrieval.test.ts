import { describe, it, expect, vi } from 'vitest';
import { RetrievalEngine } from '../../../src/cognitive/memory/retrieval.js';
import type { DbManager } from '../../../src/db.js';

const mockDb = {
  getLongTermMemory: vi.fn().mockResolvedValue({
    markdown: '# User Profile\n\n- Prefers TypeScript\n- Works in Beijing timezone\n- Uses VS Code editor\n- Likes dark mode theme',
  }),
  getDailyLogs: vi.fn().mockResolvedValue([
    { date: '2026-05-01', content: 'Discussed React vs Vue, user chose React for new project' },
    { date: '2026-05-02', content: 'User asked about Python deployment options' },
  ]),
  getActiveCognitiveSkills: vi.fn().mockResolvedValue([
    { name: 'debug-workflow', description: 'Systematic debugging approach', content: 'Step 1: Reproduce. Step 2: Isolate.', confidence: 0.9 },
  ]),
};

describe('RetrievalEngine', () => {
  let engine: RetrievalEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new RetrievalEngine(mockDb as any, {
      retrieval: { topK: 5, bm25: { enabled: true }, vector: { enabled: false }, fusion: { method: 'rrf' as const, k: 60 } },
    } as any);
  });

  it('should build index and return relevant results for TypeScript query', async () => {
    await engine.rebuildIndex('u1');
    const results = await engine.query('u1', 'TypeScript preference');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text.toLowerCase()).toContain('typescript');
  });

  it('should return relevant results for Beijing timezone query', async () => {
    await engine.rebuildIndex('u1');
    const results = await engine.query('u1', 'timezone');
    expect(results.length).toBeGreaterThan(0);
  });

  it('should return empty or few results for no match', async () => {
    await engine.rebuildIndex('u1');
    const results = await engine.query('u1', 'quantum physics research');
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('should respect topK limit', async () => {
    await engine.rebuildIndex('u1');
    const results = await engine.query('u1', 'user preferences');
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it('should auto-rebuild index if missing', async () => {
    // Don't call rebuildIndex manually
    const results = await engine.query('u1', 'TypeScript');
    expect(results.length).toBeGreaterThan(0);
  });

  it('should format context as markdown sections', async () => {
    await engine.rebuildIndex('u1');
    const results = await engine.query('u1', 'TypeScript');
    const context = engine.formatAsContext(results);
    expect(typeof context).toBe('string');
    expect(context.length).toBeGreaterThan(0);
  });
});

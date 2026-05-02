import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  getCandidatesWithEmbeddings: vi.fn().mockResolvedValue([]),
  getCognitiveSkillsWithEmbeddings: vi.fn().mockResolvedValue([]),
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

describe('RetrievalEngine - Hybrid Query', () => {
  it('should fallback to BM25 when no vector engine is available', async () => {
    const engine = new RetrievalEngine(mockDb as any, {
      retrieval: { topK: 5, bm25: { enabled: true }, vector: { enabled: false }, fusion: { method: 'rrf' as const, k: 60 } },
    } as any);

    await engine.rebuildIndex('u1');
    const results = await engine.queryHybrid('u1', 'TypeScript');
    expect(results.length).toBeGreaterThan(0);
    // Without vector engine, BM25 results are fused via RRF (with empty vector set), labeled 'hybrid'
    expect(results[0].source).toBe('hybrid');
  });

  it('should return hybrid results when vector engine is available', async () => {
    const mockVectorEngine = {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      search: vi.fn().mockResolvedValue([
        { id: 'vec-1', text: 'User loves TypeScript', type: 'memory', score: 0.95 },
        { id: 'vec-2', text: 'Expert in React', type: 'memory', score: 0.85 },
      ]),
    };

    mockDb.getCandidatesWithEmbeddings.mockResolvedValue([
      { _id: { toString: () => 'vec-1' }, content: 'User loves TypeScript', embedding: [0.1, 0.2, 0.3] },
      { _id: { toString: () => 'vec-2' }, content: 'Expert in React', embedding: [0.4, 0.5, 0.6] },
    ]);
    mockDb.getCognitiveSkillsWithEmbeddings.mockResolvedValue([]);

    const engine = new RetrievalEngine(mockDb as any, {
      retrieval: { topK: 5, bm25: { enabled: true }, vector: { enabled: true }, fusion: { method: 'rrf' as const, k: 60 } },
    } as any, mockVectorEngine as any);

    await engine.rebuildIndex('u1');
    const results = await engine.queryHybrid('u1', 'TypeScript');

    expect(results.length).toBeGreaterThan(0);
    // Some results should come from hybrid fusion
    const hybridResults = results.filter(r => r.source === 'hybrid');
    expect(hybridResults.length).toBeGreaterThan(0);
  });

  it('should gracefully handle vector search failure', async () => {
    const mockVectorEngine = {
      embed: vi.fn().mockRejectedValue(new Error('API rate limited')),
      search: vi.fn(),
    };

    const engine = new RetrievalEngine(mockDb as any, {
      retrieval: { topK: 5, bm25: { enabled: true }, vector: { enabled: true }, fusion: { method: 'rrf' as const, k: 60 } },
    } as any, mockVectorEngine as any);

    await engine.rebuildIndex('u1');
    const results = await engine.queryHybrid('u1', 'TypeScript');
    // Should fall back to BM25
    expect(results.length).toBeGreaterThan(0);
  });

  it('should combine BM25 and vector results via RRF fusion', async () => {
    const mockVectorEngine = {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      search: vi.fn().mockResolvedValue([
        { id: 'vec-1', text: 'Typescript developer', type: 'memory', score: 0.99 },
      ]),
    };

    mockDb.getCandidatesWithEmbeddings.mockResolvedValue([
      { _id: { toString: () => 'vec-1' }, content: 'Typescript developer', embedding: [0.1, 0.2, 0.3] },
    ]);
    mockDb.getCognitiveSkillsWithEmbeddings.mockResolvedValue([]);

    const engine = new RetrievalEngine(mockDb as any, {
      retrieval: { topK: 5, bm25: { enabled: true }, vector: { enabled: true }, fusion: { method: 'rrf' as const, k: 60 } },
    } as any, mockVectorEngine as any);

    await engine.rebuildIndex('u1');
    const results = await engine.queryHybrid('u1', 'TypeScript');

    // There should be results from both BM25 and vector search
    expect(results.length).toBeGreaterThan(0);
    // Vector engine should have been called
    expect(mockVectorEngine.embed).toHaveBeenCalledWith('TypeScript');
    expect(mockVectorEngine.search).toHaveBeenCalledTimes(1);
  });
});

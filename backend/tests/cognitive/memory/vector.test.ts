import { describe, it, expect, vi } from 'vitest';
import { VectorEngine } from '../../../src/cognitive/memory/vector.js';

describe('VectorEngine', () => {
  it('should calculate cosine similarity correctly', () => {
    const engine = new VectorEngine({} as any, {} as any);
    // Identical vectors
    expect(engine.cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
    // Orthogonal vectors
    expect(engine.cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0);
    // 45 degree angle
    expect(engine.cosineSimilarity([1, 1, 0], [1, 0, 0])).toBeCloseTo(0.707, 2);
  });

  it('should return 0 for mismatched lengths', () => {
    const engine = new VectorEngine({} as any, {} as any);
    expect(engine.cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it('should return 0 for empty vectors', () => {
    const engine = new VectorEngine({} as any, {} as any);
    expect(engine.cosineSimilarity([], [])).toBe(0);
  });

  it('should search and rank by similarity', async () => {
    const engine = new VectorEngine({} as any, {} as any);
    const docs = [
      { id: 'd1', embedding: [1, 0, 0], text: 'cats', type: 'memory' },
      { id: 'd2', embedding: [0, 1, 0], text: 'dogs', type: 'memory' },
      { id: 'd3', embedding: [0.9, 0.1, 0], text: 'kittens', type: 'memory' },
    ];
    const results = await engine.search([1, 0, 0], docs, 2);
    expect(results.length).toBe(2);
    expect(results[0].text).toBe('cats');
    expect(results[1].text).toBe('kittens');
  });

  it('should return empty for empty documents', async () => {
    const engine = new VectorEngine({} as any, {} as any);
    const results = await engine.search([1, 0, 0], [], 5);
    expect(results).toHaveLength(0);
  });

  it('should respect topK limit', async () => {
    const engine = new VectorEngine({} as any, {} as any);
    const docs = [
      { id: 'd1', embedding: [1, 0, 0], text: 'a', type: 'memory' },
      { id: 'd2', embedding: [0.9, 0.1, 0], text: 'b', type: 'memory' },
      { id: 'd3', embedding: [0.8, 0.2, 0], text: 'c', type: 'memory' },
    ];
    const results = await engine.search([1, 0, 0], docs, 2);
    expect(results.length).toBe(2);
  });

  it('should call OpenAI embeddings API for embed', async () => {
    const mockOpenai = {
      embeddings: {
        create: vi.fn().mockResolvedValue({
          data: [{ embedding: [0.1, 0.2, 0.3] }],
        }),
      },
    } as any;
    const engine = new VectorEngine(mockOpenai, {} as any);
    const result = await engine.embed('hello world');
    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(mockOpenai.embeddings.create).toHaveBeenCalledWith({
      model: 'text-embedding-3-small',
      input: 'hello world',
    });
  });

  it('should embed batch of texts', async () => {
    const mockOpenai = {
      embeddings: {
        create: vi.fn().mockResolvedValue({
          data: [
            { embedding: [0.1, 0.2] },
            { embedding: [0.3, 0.4] },
          ],
        }),
      },
    } as any;
    const engine = new VectorEngine(mockOpenai, {} as any);
    const result = await engine.embedBatch(['hello', 'world']);
    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(mockOpenai.embeddings.create).toHaveBeenCalledWith({
      model: 'text-embedding-3-small',
      input: ['hello', 'world'],
    });
  });

  it('should return empty array for empty batch', async () => {
    const mockOpenai = {
      embeddings: {
        create: vi.fn(),
      },
    } as any;
    const engine = new VectorEngine(mockOpenai, {} as any);
    const result = await engine.embedBatch([]);
    expect(result).toEqual([]);
    expect(mockOpenai.embeddings.create).not.toHaveBeenCalled();
  });

  it('should use custom embedding model', async () => {
    const mockOpenai = {
      embeddings: {
        create: vi.fn().mockResolvedValue({
          data: [{ embedding: [0.1] }],
        }),
      },
    } as any;
    const engine = new VectorEngine(mockOpenai, {} as any, 'text-embedding-3-large');
    await engine.embed('test');
    expect(mockOpenai.embeddings.create).toHaveBeenCalledWith({
      model: 'text-embedding-3-large',
      input: 'test',
    });
  });
});

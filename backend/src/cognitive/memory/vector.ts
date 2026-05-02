import type OpenAI from 'openai';
import type { DbManager } from '../../db.js';

export class VectorEngine {
  constructor(
    private openai: OpenAI,
    private db: DbManager,
    private embeddingModel: string = 'text-embedding-3-small',
  ) {}

  async embed(text: string): Promise<number[]> {
    const response = await this.openai.embeddings.create({
      model: this.embeddingModel,
      input: text,
    });
    return response.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.openai.embeddings.create({
      model: this.embeddingModel,
      input: texts,
    });
    return response.data.map(d => d.embedding);
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  async search(
    queryEmbedding: number[],
    documents: Array<{ id: string; embedding: number[]; text: string; type: string }>,
    topK: number = 8,
  ): Promise<Array<{ id: string; text: string; type: string; score: number }>> {
    const scored = documents.map(doc => ({
      id: doc.id,
      text: doc.text,
      type: doc.type,
      score: this.cosineSimilarity(queryEmbedding, doc.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}

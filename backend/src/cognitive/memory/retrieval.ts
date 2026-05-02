import { createHash } from 'crypto';
import MiniSearch from 'minisearch';
import type { DbManager } from '../../db.js';
import type { CognitiveConfig } from '../config.js';
import type { VectorEngine } from './vector.js';
import type { CognitiveCache } from '../cache.js';

interface SearchDoc {
  id: string;
  text: string;
  type: 'memory' | 'log' | 'skill';
}

export interface RetrievalResult {
  text: string;
  score: number;
  type: SearchDoc['type'];
  source: string;
}

export class RetrievalEngine {
  private indexes = new Map<string, MiniSearch<SearchDoc>>();
  private vectorEngine?: VectorEngine;
  private cache?: CognitiveCache;

  constructor(
    private db: DbManager,
    private config: CognitiveConfig,
    vectorEngine?: VectorEngine,
    cache?: CognitiveCache,
  ) {
    this.vectorEngine = vectorEngine;
    this.cache = cache;
  }

  async rebuildIndex(userId: string): Promise<void> {
    const docs: SearchDoc[] = [];
    let docCounter = 0;

    // 1. Long-term memory
    const memory = await this.db.getLongTermMemory(userId);
    if (memory?.markdown) {
      const lines = memory.markdown.split('\n').filter(l => l.trim());
      for (const line of lines) {
        if (line.startsWith('#')) continue;
        docs.push({ id: `mem-${docCounter++}`, text: line, type: 'memory' });
      }
    }

    // 2. Daily logs (last 7 days)
    const logs = await this.db.getDailyLogs(userId, 7);
    for (const log of logs) {
      const logLines = log.content.split('\n').filter(l => l.trim());
      for (const line of logLines) {
        docs.push({ id: `log-${log.date}-${docCounter++}`, text: line, type: 'log' });
      }
    }

    // 3. Active cognitive skills
    const skills = await this.db.getActiveCognitiveSkills(userId);
    for (const skill of skills) {
      docs.push({ id: `skill-${skill.name}`, text: `${skill.description}\n${skill.content}`, type: 'skill' });
    }

    const index = new MiniSearch<SearchDoc>({
      fields: ['text'],
      storeFields: ['text', 'type'],
      idField: 'id',
    });
    if (docs.length > 0) {
      index.addAll(docs);
    }
    this.indexes.set(userId, index);
  }

  async query(userId: string, queryStr: string): Promise<RetrievalResult[]> {
    let index = this.indexes.get(userId);
    if (!index) {
      await this.rebuildIndex(userId);
      index = this.indexes.get(userId);
    }
    if (!index) return [];

    const results = index.search(queryStr, {
      prefix: true,
      fuzzy: 0.2,
    });

    return results.slice(0, this.config.retrieval.topK).map(r => ({
      text: (r as any).text || '',
      score: r.score,
      type: (r as any).type || 'memory',
      source: r.id,
    }));
  }

  async queryHybrid(userId: string, queryStr: string): Promise<RetrievalResult[]> {
    // Check cache first
    const queryHash = createHash('md5').update(`${userId}:${queryStr}`).digest('hex');
    const cacheKey = `retrieval:${userId}:${queryHash}`;
    if (this.cache) {
      const cached = await this.cache.getJSON<RetrievalResult[]>(cacheKey);
      if (cached) return cached;
    }

    // Get BM25 results
    let index = this.indexes.get(userId);
    if (!index) await this.rebuildIndex(userId);
    index = this.indexes.get(userId);

    const bm25Results = index
      ? index.search(queryStr, { prefix: true, fuzzy: 0.2 }).slice(0, 20)
      : [];

    // Get vector results if vector engine available
    let vectorResults: Array<{ id: string; text: string; type: string; score: number }> = [];
    if (this.vectorEngine) {
      try {
        const queryEmbedding = await this.vectorEngine.embed(queryStr);
        const candidates = await this.db.getCandidatesWithEmbeddings(userId);
        const skills = await this.db.getCognitiveSkillsWithEmbeddings(userId);

        const docs: Array<{ id: string; embedding: number[]; text: string; type: string }> = candidates.map(c => ({
          id: c._id!.toString(),
          embedding: c.embedding,
          text: c.content,
          type: 'memory',
        }))
          .concat(skills.map(s => ({
            id: s._id!.toString(),
            embedding: s.embedding,
            text: `${s.description} ${s.content}`,
            type: 'skill',
          })));

        vectorResults = await this.vectorEngine.search(queryEmbedding, docs, 20);
      } catch (err) {
        console.error('[RetrievalEngine] vector search failed, falling back to BM25:', err);
      }
    }

    // RRF fusion
    const k = this.config.retrieval.fusion.k;
    const rrfScores = new Map<string, { text: string; type: string; score: number; source: string }>();

    bm25Results.forEach((r, idx) => {
      const id = r.id;
      const existing = rrfScores.get(id) || {
        text: (r as any).text || '',
        type: (r as any).type || 'memory',
        score: 0,
        source: r.id,
      };
      existing.score += 1 / (k + idx + 1);
      rrfScores.set(id, existing);
    });

    vectorResults.forEach((r, idx) => {
      const id = r.id;
      const existing = rrfScores.get(id) || { text: r.text, type: r.type, score: 0, source: r.id };
      existing.score += 1 / (k + idx + 1);
      // Use vector score as a tiebreaker by adding a small boost
      existing.score += r.score * 0.1;
      rrfScores.set(id, existing);
    });

    const fused = [...rrfScores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.retrieval.topK)
      .map(r => ({ text: r.text, score: r.score, type: r.type as any, source: 'hybrid' }));

    // Fallback to BM25 if no results
    if (fused.length === 0 && bm25Results.length > 0) {
      const fallback = bm25Results.slice(0, this.config.retrieval.topK).map(r => ({
        text: (r as any).text || '',
        score: r.score,
        type: (r as any).type || 'memory',
        source: r.id,
      }));
      if (this.cache) await this.cache.setJSON(cacheKey, fallback, 3600);
      return fallback;
    }

    if (this.cache) await this.cache.setJSON(cacheKey, fused, 3600);
    return fused;
  }

  formatAsContext(results: RetrievalResult[]): string {
    if (results.length === 0) return '';
    const byType = new Map<string, RetrievalResult[]>();
    for (const r of results) {
      if (!byType.has(r.type)) byType.set(r.type, []);
      byType.get(r.type)!.push(r);
    }

    const sections: string[] = [];
    if (byType.has('memory')) {
      sections.push('## 相关记忆\n' + byType.get('memory')!.map(r => `- ${r.text}`).join('\n'));
    }
    if (byType.has('log')) {
      sections.push('## 最近记录\n' + byType.get('log')!.map(r => `- ${r.text}`).join('\n'));
    }
    if (byType.has('skill')) {
      sections.push('## 相关技能\n' + byType.get('skill')!.map(r => `- ${r.text}`).join('\n'));
    }

    return sections.join('\n\n');
  }
}

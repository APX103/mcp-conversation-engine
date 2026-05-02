import MiniSearch from 'minisearch';
import type { DbManager } from '../../db.js';
import type { CognitiveConfig } from '../config.js';

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

  constructor(
    private db: DbManager,
    private config: CognitiveConfig,
  ) {}

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

import type { ChatMessage } from '../types.js';
import type { DbManager } from '../db.js';
import type { CognitiveConfig } from './config.js';
import type { CognitiveBus } from './bus.js';
import { RetrievalEngine } from './memory/retrieval.js';

export class CognitiveAdapter {
  private retrieval: RetrievalEngine;

  constructor(
    private bus: CognitiveBus,
    private db: DbManager,
    private config: CognitiveConfig,
  ) {
    this.retrieval = new RetrievalEngine(db, config);
  }

  async getMemoryContext(userId: string, query?: string): Promise<string> {
    if (!query) {
      const memory = await this.db.getLongTermMemory(userId);
      return memory?.markdown || '';
    }

    await this.retrieval.rebuildIndex(userId);
    const results = await this.retrieval.query(userId, query);
    const context = this.retrieval.formatAsContext(results);

    if (!context) {
      const memory = await this.db.getLongTermMemory(userId);
      return memory?.markdown || '';
    }

    return context;
  }

  async afterConversation(userId: string, messages: ChatMessage[]): Promise<void> {
    const toolCallCount = messages.reduce((sum, m) => sum + (m.tool_calls?.length || 0), 0);
    await this.bus.emit('conversation.end', { userId, messages, toolCallCount });
  }

  async getSkillsContext(userId: string): Promise<string> {
    const parts: string[] = [];

    const enabledSkills = await this.db.getEnabledSkills(userId);
    for (const skill of enabledSkills) {
      parts.push(`### Skill: ${skill.name}\n${skill.content}`);
    }

    const cognitiveSkills = await this.db.getActiveCognitiveSkills(userId);
    for (const skill of cognitiveSkills) {
      parts.push(`### Auto-Skill: ${skill.name} (confidence: ${skill.confidence})\n${skill.content}`);
    }

    return parts.length > 0 ? `## Skills & Methods\n\n${parts.join('\n\n')}` : '';
  }
}

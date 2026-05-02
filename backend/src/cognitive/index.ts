import type OpenAI from 'openai';
import type { DbManager } from '../db.js';
import { CognitiveBus } from './bus.js';
import { validateCognitiveConfig, type CognitiveConfig } from './config.js';
import { MemoryScorer } from './memory/scorer.js';
import { RetrievalEngine } from './memory/retrieval.js';
import { DreamCollector } from './dream/collector.js';
import { DreamPromoter } from './dream/promoter.js';
import { LearnExtractor } from './learn/extractor.js';
import { LearnGenerator } from './learn/generator.js';
import { CognitiveAdapter } from './adapter.js';

export class CognitiveCore {
  readonly bus: CognitiveBus;
  readonly adapter: CognitiveAdapter;
  readonly config: CognitiveConfig;
  readonly retrieval: RetrievalEngine;

  private constructor(
    config: CognitiveConfig,
    bus: CognitiveBus,
    adapter: CognitiveAdapter,
    retrieval: RetrievalEngine,
  ) {
    this.config = config;
    this.bus = bus;
    this.adapter = adapter;
    this.retrieval = retrieval;
  }

  static create(
    db: DbManager,
    openai: OpenAI,
    model: string,
    partialConfig?: Partial<CognitiveConfig>,
  ): CognitiveCore {
    const config = validateCognitiveConfig(partialConfig || {});
    const bus = new CognitiveBus();
    const scorer = new MemoryScorer(openai, model);
    const retrieval = new RetrievalEngine(db, config);
    const adapter = new CognitiveAdapter(bus, db, config);

    // Wire up dream engine
    new DreamCollector(bus, scorer, db, config);
    new DreamPromoter(bus, db, openai, model);

    // Wire up learn engine
    const extractor = new LearnExtractor(openai, model, {
      minToolCalls: config.learn.minToolCalls,
    });
    new LearnGenerator(bus, db, config);

    // Wire extractor to conversation.end
    bus.on('conversation.end', async (payload) => {
      const result = await extractor.extract(payload.messages, payload.userId);
      if (result.shouldGenerate && result.skill) {
        // Find sessionId from source — use userId as fallback
        const sessionId = `auto-${Date.now()}`;
        const generator = new LearnGenerator(bus, db, config);
        await generator.generate(payload.userId, result.skill, sessionId);
      }
    });

    return new CognitiveCore(config, bus, adapter, retrieval);
  }
}

export type { CognitiveConfig };

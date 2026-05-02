import type OpenAI from 'openai';
import type { DbManager } from '../db.js';
import { CognitiveBus } from './bus.js';
import { validateCognitiveConfig, type CognitiveConfig } from './config.js';
import { CognitiveCache } from './cache.js';
import { MemoryScorer } from './memory/scorer.js';
import { RetrievalEngine } from './memory/retrieval.js';
import { VectorEngine } from './memory/vector.js';
import { DecayEngine } from './memory/decay.js';
import { DreamCollector } from './dream/collector.js';
import { DreamPromoter } from './dream/promoter.js';
import { DreamReflector } from './dream/reflector.js';
import { LearnExtractor } from './learn/extractor.js';
import { LearnGenerator } from './learn/generator.js';
import { LearnIterater } from './learn/iterater.js';
import { CognitiveAdapter } from './adapter.js';

export class CognitiveCore {
  readonly bus: CognitiveBus;
  readonly adapter: CognitiveAdapter;
  readonly config: CognitiveConfig;
  readonly retrieval: RetrievalEngine;
  readonly vectorEngine?: VectorEngine;
  readonly cache: CognitiveCache;
  readonly decayEngine: DecayEngine;

  private constructor(
    config: CognitiveConfig,
    bus: CognitiveBus,
    adapter: CognitiveAdapter,
    retrieval: RetrievalEngine,
    vectorEngine: VectorEngine | undefined,
    cache: CognitiveCache,
    decayEngine: DecayEngine,
  ) {
    this.config = config;
    this.bus = bus;
    this.adapter = adapter;
    this.retrieval = retrieval;
    this.vectorEngine = vectorEngine;
    this.cache = cache;
    this.decayEngine = decayEngine;
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

    // Create cache from config
    const cache = new CognitiveCache(config.redis?.url);

    // Create decay engine
    const decayEngine = new DecayEngine(db, config);

    // Create vector engine if enabled
    let vectorEngine: VectorEngine | undefined;
    if (config.retrieval.vector.enabled) {
      vectorEngine = new VectorEngine(openai, db);
    }

    const retrieval = new RetrievalEngine(db, config, vectorEngine, cache);
    const adapter = new CognitiveAdapter(bus, db, config, vectorEngine);

    // Wire up dream engine
    new DreamCollector(bus, scorer, db, config);
    const reflector = new DreamReflector(bus, db, openai, model);
    new DreamPromoter(bus, db, openai, model, reflector);

    // Wire up learn engine
    const extractor = new LearnExtractor(openai, model, {
      minToolCalls: config.learn.minToolCalls,
    });
    new LearnGenerator(bus, db, config);
    new LearnIterater(bus, db, config, openai, model);

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

    return new CognitiveCore(config, bus, adapter, retrieval, vectorEngine, cache, decayEngine);
  }
}

export type { CognitiveConfig };

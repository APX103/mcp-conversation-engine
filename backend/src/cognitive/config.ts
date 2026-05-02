export interface DreamConfig {
  threshold: number;
  schedule: string;
  minScore: number;
  decay: { rate: number; boost: number; min: number };
  stages: { light: boolean; rem: boolean; deep: boolean };
}

export interface LearnConfig {
  minToolCalls: number;
  skillConfirmRequired: boolean;
  confidence: { boost: number; decay: number; minForRevision: number };
  maxSkillVersion: number;
}

export interface RetrievalConfig {
  topK: number;
  bm25: { enabled: boolean };
  vector: { enabled: boolean };
  fusion: { method: 'rrf'; k: number };
}

export interface CognitiveConfig {
  autoLevel: 'manual' | 'semi-auto' | 'full-auto';
  dream: DreamConfig;
  learn: LearnConfig;
  retrieval: RetrievalConfig;
  redis?: { url?: string };
}

export const DEFAULT_COGNITIVE_CONFIG: CognitiveConfig = {
  autoLevel: 'semi-auto',
  dream: {
    threshold: 5,
    schedule: '0 3 * * *',
    minScore: 3,
    decay: { rate: 0.02, boost: 0.1, min: 0.1 },
    stages: { light: true, rem: false, deep: true },
  },
  learn: {
    minToolCalls: 3,
    skillConfirmRequired: true,
    confidence: { boost: 0.1, decay: 0.05, minForRevision: 0.3 },
    maxSkillVersion: 10,
  },
  retrieval: {
    topK: 8,
    bm25: { enabled: true },
    vector: { enabled: false },
    fusion: { method: 'rrf', k: 60 },
  },
  redis: { url: 'redis://localhost:6379' },
};

const VALID_AUTO_LEVELS = new Set(['manual', 'semi-auto', 'full-auto']);

export function validateCognitiveConfig(partial: Partial<CognitiveConfig>): CognitiveConfig {
  if (partial.autoLevel && !VALID_AUTO_LEVELS.has(partial.autoLevel)) {
    throw new Error(`invalid autoLevel: ${partial.autoLevel}`);
  }
  return {
    ...DEFAULT_COGNITIVE_CONFIG,
    ...partial,
    dream: { ...DEFAULT_COGNITIVE_CONFIG.dream, ...partial.dream },
    learn: { ...DEFAULT_COGNITIVE_CONFIG.learn, ...partial.learn },
    retrieval: { ...DEFAULT_COGNITIVE_CONFIG.retrieval, ...partial.retrieval },
  };
}

import { describe, it, expect } from 'vitest';
import { CognitiveConfig, validateCognitiveConfig, DEFAULT_COGNITIVE_CONFIG } from '../../src/cognitive/config.js';

describe('CognitiveConfig', () => {
  it('should export default config with correct shape', () => {
    expect(DEFAULT_COGNITIVE_CONFIG.autoLevel).toBe('semi-auto');
    expect(DEFAULT_COGNITIVE_CONFIG.dream.threshold).toBe(5);
    expect(DEFAULT_COGNITIVE_CONFIG.dream.minScore).toBe(3);
    expect(DEFAULT_COGNITIVE_CONFIG.learn.minToolCalls).toBe(3);
    expect(DEFAULT_COGNITIVE_CONFIG.learn.skillConfirmRequired).toBe(true);
    expect(DEFAULT_COGNITIVE_CONFIG.retrieval.topK).toBe(8);
  });

  it('should validate and return default for empty input', () => {
    const config = validateCognitiveConfig({});
    expect(config.autoLevel).toBe('semi-auto');
  });

  it('should override defaults with provided values', () => {
    const config = validateCognitiveConfig({
      autoLevel: 'full-auto',
      dream: { threshold: 10 },
    });
    expect(config.autoLevel).toBe('full-auto');
    expect(config.dream.threshold).toBe(10);
    expect(config.dream.minScore).toBe(3);
  });

  it('should reject invalid autoLevel', () => {
    expect(() => validateCognitiveConfig({ autoLevel: 'invalid' as any }))
      .toThrow(/invalid autoLevel/);
  });
});

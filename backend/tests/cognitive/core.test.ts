import { describe, it, expect } from 'vitest';
import { CognitiveCore } from '../../src/cognitive/index.js';

describe('CognitiveCore', () => {
  it('should initialize all sub-modules', () => {
    const core = CognitiveCore.create({} as any, {} as any, 'test-model', {});
    expect(core.bus).toBeDefined();
    expect(core.adapter).toBeDefined();
    expect(core.retrieval).toBeDefined();
  });

  it('should use default config when none provided', () => {
    const core = CognitiveCore.create({} as any, {} as any, 'model');
    expect(core.config.autoLevel).toBe('semi-auto');
  });

  it('should accept partial config overrides', () => {
    const core = CognitiveCore.create({} as any, {} as any, 'model', { autoLevel: 'full-auto' });
    expect(core.config.autoLevel).toBe('full-auto');
  });
});

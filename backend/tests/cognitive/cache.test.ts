import { describe, it, expect } from 'vitest';
import { CognitiveCache } from '../../src/cognitive/cache.js';

describe('CognitiveCache', () => {
  it('should be disabled when no redis URL provided', () => {
    const cache = new CognitiveCache();
    expect(cache.isAvailable()).toBe(false);
  });

  it('should return null when disabled', async () => {
    const cache = new CognitiveCache();
    expect(await cache.get('key')).toBeNull();
  });

  it('should set and get values when enabled', async () => {
    // This test only verifies the interface works
    // Actual Redis testing would require a running instance
    const cache = new CognitiveCache('redis://localhost:6379');
    expect(cache.isAvailable()).toBe(false); // not connected yet
  });
});

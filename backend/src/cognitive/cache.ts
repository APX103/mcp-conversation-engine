import { Redis } from 'ioredis';
import type { Redis as RedisType } from 'ioredis';

export class CognitiveCache {
  private redis: RedisType | null = null;
  private enabled: boolean;

  constructor(redisUrl?: string) {
    this.enabled = !!redisUrl;
    if (this.enabled && redisUrl) {
      this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
      this.redis.on('error', (err: Error) => {
        console.error('[CognitiveCache] Redis error:', err.message);
      });
    }
  }

  async connect(): Promise<void> {
    if (this.redis) await this.redis.connect();
  }

  async disconnect(): Promise<void> {
    if (this.redis) await this.redis.quit();
  }

  async get(key: string): Promise<string | null> {
    if (!this.redis) return null;
    try {
      return await this.redis.get(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number = 3600): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    } catch {
      // silent fail
    }
  }

  async del(key: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(key);
    } catch {
      // silent fail
    }
  }

  async getJSON<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJSON(key: string, value: unknown, ttlSeconds: number = 3600): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  isAvailable(): boolean {
    return this.enabled && !!this.redis?.status && this.redis.status === 'ready';
  }
}

# Cognitive Evolution Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a minimum viable cognitive loop — scored memory consolidation + experience-to-skill generation — with BM25 retrieval replacing full-stuff prompting.

**Architecture:** Plugin-based cognitive modules behind a `CognitiveBus` event system, bridged to the existing `ConversationEngine` via `CognitiveAdapter`. Phase 1 uses Redis for candidate caching, MongoDB for persistence, minisearch for BM25 retrieval. No ChromaDB yet.

**Tech Stack:** TypeScript (ESM), Redis (ioredis), MongoDB (existing), minisearch, vitest

---

## Task 1: Test Infrastructure + New Dependencies

**Files:**
- Create: `backend/vitest.config.ts`
- Create: `backend/tsconfig.test.json`
- Modify: `backend/package.json` (add deps + scripts)
- Create: `backend/tests/helpers/setup.ts`

**Step 1: Install dependencies**

Run:
```bash
cd /Users/lijialun/work/mcp-conversation-engine/backend
npm install --save ioredis minisearch
npm install --save-dev vitest @types/ioredis
```

**Step 2: Create vitest config**

Create `backend/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/helpers/setup.ts'],
    testTimeout: 30000,
  },
});
```

**Step 3: Create test tsconfig**

Create `backend/tsconfig.test.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["vitest/globals"],
    "noEmit": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

**Step 4: Create test setup helper**

Create `backend/tests/helpers/setup.ts`:
```typescript
// Test setup - runs before each test file
// Mock environment variables for tests
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/test-cognitive';
```

**Step 5: Add test script to package.json**

In `backend/package.json`, add to `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest"
```

**Step 6: Create a trivial passing test to verify setup**

Create `backend/tests/helpers/verify-setup.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';

describe('test infrastructure', () => {
  it('should work', () => {
    expect(1 + 1).toBe(2);
  });
});
```

**Step 7: Run tests to verify**

Run: `cd backend && npx vitest run tests/helpers/verify-setup.test.ts`
Expected: PASS

**Step 8: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/vitest.config.ts backend/tsconfig.test.json backend/tests/
git commit -m "chore: add vitest test infrastructure + ioredis + minisearch deps"
```

---

## Task 2: Cognitive Config Types

**Files:**
- Create: `backend/src/cognitive/config.ts`
- Create: `backend/tests/cognitive/config.test.ts`

**Step 1: Write the failing test**

Create `backend/tests/cognitive/config.test.ts`:
```typescript
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
    expect(config.dream.minScore).toBe(3); // inherited
  });

  it('should reject invalid autoLevel', () => {
    expect(() => validateCognitiveConfig({ autoLevel: 'invalid' as any }))
      .toThrow(/invalid autoLevel/);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run tests/cognitive/config.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `backend/src/cognitive/config.ts`:
```typescript
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

export type { CognitiveConfig as CognitiveConfigType };
```

**Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run tests/cognitive/config.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add backend/src/cognitive/config.ts backend/tests/cognitive/config.test.ts
git commit -m "feat(cognitive): add config types with validation and defaults"
```

---

## Task 3: CognitiveBus Event System

**Files:**
- Create: `backend/src/cognitive/bus.ts`
- Create: `backend/tests/cognitive/bus.test.ts`

**Step 1: Write the failing test**

Create `backend/tests/cognitive/bus.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { CognitiveBus, type CognitiveEventMap } from '../../src/cognitive/bus.js';

describe('CognitiveBus', () => {
  it('should emit and receive events', async () => {
    const bus = new CognitiveBus();
    const handler = vi.fn();
    bus.on('conversation.end', handler);
    await bus.emit('conversation.end', { userId: 'u1', messages: [], toolCallCount: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ userId: 'u1', messages: [], toolCallCount: 0 });
  });

  it('should support multiple handlers for same event', async () => {
    const bus = new CognitiveBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('conversation.end', h1);
    bus.on('conversation.end', h2);
    await bus.emit('conversation.end', { userId: 'u1', messages: [], toolCallCount: 0 });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('should remove handlers with off', async () => {
    const bus = new CognitiveBus();
    const handler = vi.fn();
    bus.on('conversation.end', handler);
    bus.off('conversation.end', handler);
    await bus.emit('conversation.end', { userId: 'u1', messages: [], toolCallCount: 0 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('should emit error events when handler throws', async () => {
    const bus = new CognitiveBus();
    const errorHandler = vi.fn();
    bus.on('error', errorHandler);
    bus.on('conversation.end', () => { throw new Error('boom'); });
    await bus.emit('conversation.end', { userId: 'u1', messages: [], toolCallCount: 0 });
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler.mock.calls[0][0].message).toBe('boom');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run tests/cognitive/bus.test.ts`
Expected: FAIL

**Step 3: Write implementation**

Create `backend/src/cognitive/bus.ts`:
```typescript
import type { ChatMessage } from '../types.js';

export interface ConversationEndPayload {
  userId: string;
  messages: ChatMessage[];
  toolCallCount: number;
}

export interface MemoryCandidateScoredPayload {
  userId: string;
  candidates: Array<{
    content: string;
    score: number;
    type: string;
  }>;
}

export interface DreamPromotePayload {
  userId: string;
  candidates: Array<{
    content: string;
    score: number;
    type: string;
  }>;
}

export interface LearningExtractPayload {
  userId: string;
  messages: ChatMessage[];
  toolCallCount: number;
}

export interface SkillGeneratedPayload {
  userId: string;
  skill: {
    name: string;
    description: string;
    content: string;
    triggers: string[];
    autoGenerated: boolean;
  };
  needsConfirmation: boolean;
}

export interface MemoryQueryPayload {
  userId: string;
  query: string;
}

export type CognitiveEventMap = {
  'conversation.end': ConversationEndPayload;
  'memory.candidate.scored': MemoryCandidateScoredPayload;
  'dream.promote.start': DreamPromotePayload;
  'learning.extract': LearningExtractPayload;
  'learning.skill.generated': SkillGeneratedPayload;
  'memory.query': MemoryQueryPayload;
  'error': Error;
};

type EventName = keyof CognitiveEventMap;
type Handler<E extends EventName> = (payload: CognitiveEventMap[E]) => void | Promise<void>;

export class CognitiveBus {
  private handlers = new Map<EventName, Set<Handler<any>>>();

  on<E extends EventName>(event: E, handler: Handler<E>): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  off<E extends EventName>(event: E, handler: Handler<E>): void {
    this.handlers.get(event)?.delete(handler);
  }

  async emit<E extends EventName>(event: E, payload: CognitiveEventMap[E]): Promise<void> {
    const eventHandlers = this.handlers.get(event);
    if (!eventHandlers) return;
    const promises = [...eventHandlers].map(async (handler) => {
      try {
        await handler(payload);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    });
    await Promise.allSettled(promises);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run tests/cognitive/bus.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add backend/src/cognitive/bus.ts backend/tests/cognitive/bus.test.ts
git commit -m "feat(cognitive): add CognitiveBus event system"
```

---

## Task 4: DB Extensions — Cognitive Collections

**Files:**
- Modify: `backend/src/db.ts` (add new interfaces + methods)
- Modify: `backend/src/types.ts` (add CognitiveCandidateDoc, CognitiveSkillDoc)
- Create: `backend/tests/cognitive/db-extensions.test.ts`

**Step 1: Write the failing test**

Create `backend/tests/cognitive/db-extensions.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { DbManager } from '../../src/db.js';

const TEST_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/test-cognitive';
let db: DbManager;
let client: MongoClient;

describe('DbManager cognitive extensions', () => {
  beforeAll(async () => {
    client = new MongoClient(TEST_URI);
    await client.connect();
    const testDb = client.db('test-cognitive');
    db = new DbManager(TEST_URI, 'test-cognitive');
    await db.connect();
    // cleanup
    await testDb.collection('cognitiveCandidates').deleteMany({});
    await testDb.collection('cognitiveSkills').deleteMany({});
  });

  afterAll(async () => {
    await client.close();
  });

  it('should add and get cognitive candidates', async () => {
    await db.addCognitiveCandidate({
      userId: 'u1',
      content: 'User prefers dark mode',
      score: 4,
      type: 'preference',
      confidence: 0.9,
      source: 'session-123',
      stage: 'candidate',
    });
    const candidates = await db.getCognitiveCandidates('u1', 'candidate');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].content).toBe('User prefers dark mode');
    expect(candidates[0].score).toBe(4);
  });

  it('should update candidate stage', async () => {
    const candidates = await db.getCognitiveCandidates('u1', 'candidate');
    const id = candidates[0]._id!;
    await db.updateCandidateStage(id, 'promoted');
    const promoted = await db.getCognitiveCandidates('u1', 'promoted');
    expect(promoted).toHaveLength(1);
  });

  it('should count candidates by stage', async () => {
    const count = await db.countCandidates('u1', 'candidate');
    expect(count).toBe(0); // already promoted
  });

  it('should add and get cognitive skills', async () => {
    await db.addCognitiveSkill({
      userId: 'u1',
      name: 'test-skill',
      description: 'A test skill',
      content: '# Test Skill\n\nDo something.',
      version: 1,
      confidence: 0.7,
      autoGenerated: true,
      sourceConversationIds: ['s1'],
      confirmedAt: null,
      active: true,
    });
    const skills = await db.getCognitiveSkills('u1');
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('test-skill');
    expect(skills[0].confirmedAt).toBeNull();
  });

  it('should confirm a cognitive skill', async () => {
    const skills = await db.getCognitiveSkills('u1');
    const id = skills[0]._id!;
    await db.confirmCognitiveSkill(id);
    const confirmed = await db.getCognitiveSkills('u1');
    expect(confirmed[0].confirmedAt).not.toBeNull();
  });

  it('should get only active confirmed skills', async () => {
    // add an unconfirmed one
    await db.addCognitiveSkill({
      userId: 'u1',
      name: 'unconfirmed-skill',
      description: 'Not confirmed',
      content: '...',
      version: 1,
      confidence: 0.5,
      autoGenerated: true,
      sourceConversationIds: ['s2'],
      confirmedAt: null,
      active: true,
    });
    const active = await db.getActiveCognitiveSkills('u1');
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe('test-skill');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run tests/cognitive/db-extensions.test.ts`
Expected: FAIL — methods not found on DbManager

**Step 3: Add types to types.ts**

Add to `backend/src/types.ts` (after line 114):
```typescript
export interface CognitiveCandidateDoc {
  _id?: any;
  userId: string;
  content: string;
  score: number;
  type: 'preference' | 'fact' | 'method' | 'emotion';
  confidence: number;
  source: string;
  stage: 'candidate' | 'rem' | 'promoted' | 'discarded';
  createdAt?: Date;
  expiresAt?: Date;
}

export interface CognitiveSkillDoc {
  _id?: any;
  userId: string;
  name: string;
  description: string;
  content: string;
  version: number;
  confidence: number;
  autoGenerated: boolean;
  sourceConversationIds: string[];
  confirmedAt: Date | null;
  active: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}
```

**Step 4: Add methods to db.ts**

Add to `backend/src/db.ts`. Import the new types at the top:
```typescript
import type { ChatMessage, CognitiveCandidateDoc, CognitiveSkillDoc } from './types.js';
```

Add these methods to the `DbManager` class (after the existing `initBuiltinSkill` method, around line 413):

```typescript
  // ── Cognitive Candidates ──

  async addCognitiveCandidate(doc: Omit<CognitiveCandidateDoc, '_id' | 'createdAt' | 'expiresAt'>): Promise<string> {
    const coll = this.db.collection('cognitiveCandidates');
    const result = await coll.insertOne({
      ...doc,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days TTL
    });
    return result.insertedId.toString();
  }

  async getCognitiveCandidates(userId: string, stage?: string): Promise<CognitiveCandidateDoc[]> {
    const coll = this.db.collection('cognitiveCandidates');
    const query: any = { userId };
    if (stage) query.stage = stage;
    return coll.find(query).sort({ createdAt: -1 }).toArray() as Promise<CognitiveCandidateDoc[]>;
  }

  async countCandidates(userId: string, stage: string): Promise<number> {
    const coll = this.db.collection('cognitiveCandidates');
    return coll.countDocuments({ userId, stage });
  }

  async updateCandidateStage(id: string, stage: string): Promise<void> {
    const coll = this.db.collection('cognitiveCandidates');
    await coll.updateOne({ _id: new ObjectId(id) }, { $set: { stage } });
  }

  async deleteCandidates(userId: string, stage: string): Promise<number> {
    const coll = this.db.collection('cognitiveCandidates');
    const result = await coll.deleteMany({ userId, stage });
    return result.deletedCount;
  }

  // ── Cognitive Skills ──

  async addCognitiveSkill(doc: Omit<CognitiveSkillDoc, '_id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    const coll = this.db.collection('cognitiveSkills');
    const result = await coll.insertOne({
      ...doc,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return result.insertedId.toString();
  }

  async getCognitiveSkills(userId: string): Promise<CognitiveSkillDoc[]> {
    const coll = this.db.collection('cognitiveSkills');
    return coll.find({ userId }).sort({ updatedAt: -1 }).toArray() as Promise<CognitiveSkillDoc[]>;
  }

  async getActiveCognitiveSkills(userId: string): Promise<CognitiveSkillDoc[]> {
    const coll = this.db.collection('cognitiveSkills');
    return coll.find({ userId, active: true, confirmedAt: { $ne: null } })
      .sort({ confidence: -1 })
      .toArray() as Promise<CognitiveSkillDoc[]>;
  }

  async confirmCognitiveSkill(id: string): Promise<void> {
    const coll = this.db.collection('cognitiveSkills');
    await coll.updateOne({ _id: new ObjectId(id) }, { $set: { confirmedAt: new Date(), updatedAt: new Date() } });
  }

  async updateCognitiveSkillContent(id: string, content: string, version: number): Promise<void> {
    const coll = this.db.collection('cognitiveSkills');
    await coll.updateOne({ _id: new ObjectId(id) }, { $set: { content, version, updatedAt: new Date() } });
  }

  async deactivateCognitiveSkill(id: string): Promise<void> {
    const coll = this.db.collection('cognitiveSkills');
    await coll.updateOne({ _id: new ObjectId(id) }, { $set: { active: false, updatedAt: new Date() } });
  }

  async getAllUserIdsWithCandidates(): Promise<string[]> {
    const coll = this.db.collection('cognitiveCandidates');
    return coll.distinct('userId');
  }
```

Also ensure `ObjectId` is imported at the top of db.ts — it should already be imported from mongodb, but verify:
```typescript
import { MongoClient, WithId, Document, ObjectId } from 'mongodb';
```

**Step 5: Run test to verify it passes**

Run: `cd backend && npx vitest run tests/cognitive/db-extensions.test.ts`
Expected: PASS (6 tests)

**Step 6: Commit**

```bash
git add backend/src/types.ts backend/src/db.ts backend/tests/cognitive/db-extensions.test.ts
git commit -m "feat(db): add cognitiveCandidates and cognitiveSkills collections"
```

---

## Task 5: MemoryScorer — LLM-based Memory Importance Scoring

**Files:**
- Create: `backend/src/cognitive/memory/scorer.ts`
- Create: `backend/tests/cognitive/memory/scorer.test.ts`

**Step 1: Write the failing test**

Create `backend/tests/cognitive/memory/scorer.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { MemoryScorer } from '../../../src/cognitive/memory/scorer.js';
import type { ChatMessage } from '../../../src/types.js';

// Mock OpenAI
const createMockOpenai = (response: string) => ({
  chat: {
    completions: {
      create: vi.fn().mockResolvedValue({
        choices: [{ message: { content: response } }],
      }),
    },
  },
});

const sampleMessages: ChatMessage[] = [
  { role: 'user', content: 'I prefer using TypeScript for all my projects' },
  { role: 'assistant', content: 'Noted! I\'ll remember your preference for TypeScript.' },
  { role: 'user', content: 'Also, I work in the Beijing timezone' },
  { role: 'assistant', content: 'Got it, Beijing time (UTC+8) noted.' },
];

describe('MemoryScorer', () => {
  it('should extract and score candidate memories from conversation', async () => {
    const mockResponse = `| 4 | preference | User strongly prefers TypeScript for all projects |
| 3 | fact | User works in Beijing timezone (UTC+8) |
| 1 | fact | User sent a greeting message`;
    const mockOpenai = createMockOpenai(mockResponse) as any;
    const scorer = new MemoryScorer(mockOpenai, 'test-model');

    const candidates = await scorer.score(sampleMessages);
    expect(candidates).toHaveLength(2); // score >= 3 only
    expect(candidates[0]).toMatchObject({
      content: expect.stringContaining('TypeScript'),
      score: 4,
      type: 'preference',
    });
    expect(candidates[1]).toMatchObject({
      content: expect.stringContaining('Beijing'),
      score: 3,
      type: 'fact',
    });
  });

  it('should return empty array when LLM returns no high-score items', async () => {
    const mockResponse = `| 2 | fact | User mentioned the weather |`;
    const mockOpenai = createMockOpenai(mockResponse) as any;
    const scorer = new MemoryScorer(mockOpenai, 'test-model');

    const candidates = await scorer.score(sampleMessages);
    expect(candidates).toHaveLength(0);
  });

  it('should return empty array on malformed LLM response', async () => {
    const mockOpenai = createMockOpenai('Sorry, I cannot process this.') as any;
    const scorer = new MemoryScorer(mockOpenai, 'test-model');

    const candidates = await scorer.score(sampleMessages);
    expect(candidates).toHaveLength(0);
  });

  it('should return empty array on LLM failure', async () => {
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error('API timeout')),
        },
      },
    };
    const scorer = new MemoryScorer(mockOpenai as any, 'test-model');

    const candidates = await scorer.score(sampleMessages);
    expect(candidates).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run tests/cognitive/memory/scorer.test.ts`
Expected: FAIL

**Step 3: Write implementation**

Create `backend/src/cognitive/memory/scorer.ts`:
```typescript
import type OpenAI from 'openai';
import type { ChatMessage } from '../../types.js';
import type { CognitiveCandidateDoc } from '../../types.js';

const SCORING_PROMPT = `从以下对话中提取值得长期记住的信息。
对每条信息评分（1-5）：
- 重要性（对用户工作/生活的影响程度）
- 持久性（是否会持续相关）
- 可复用性（未来是否会再次需要）
只返回评分 >= 3 的条目，格式：| 分数 | 类型 | 内容 |
类型限：preference / fact / method / emotion
如果没有值得记住的信息，返回空。

对话：
`;

export class MemoryScorer {
  constructor(private openai: OpenAI, private model: string) {}

  async score(messages: ChatMessage[]): Promise<Omit<CognitiveCandidateDoc, '_id' | 'createdAt' | 'expiresAt' | 'source' | 'stage'>[]> {
    try {
      const conversationText = messages
        .map(m => `[${m.role}] ${m.content}`)
        .join('\n');

      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a memory extraction assistant. Respond only in the specified table format. No explanations.' },
          { role: 'user', content: SCORING_PROMPT + conversationText },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      });

      const text = response.choices[0]?.message?.content || '';
      return this.parseScoring(text);
    } catch (err) {
      console.error('[MemoryScorer] scoring failed:', err);
      return [];
    }
  }

  private parseScoring(text: string): Omit<CognitiveCandidateDoc, '_id' | 'createdAt' | 'expiresAt' | 'source' | 'stage'>[] {
    const candidates: Omit<CognitiveCandidateDoc, '_id' | 'createdAt' | 'expiresAt' | 'source' | 'stage'>[] = [];
    const lines = text.split('\n').filter(l => l.trim().startsWith('|'));

    for (const line of lines) {
      const match = line.match(/\|\s*(\d+)\s*\|\s*(preference|fact|method|emotion)\s*\|\s*(.+?)\s*\|/i);
      if (!match) continue;

      const score = parseInt(match[1], 10);
      if (score < 3) continue;

      const type = match[2].toLowerCase() as CognitiveCandidateDoc['type'];
      const validTypes = ['preference', 'fact', 'method', 'emotion'];
      if (!validTypes.includes(type)) continue;

      const content = match[3].trim();
      if (!content) continue;

      candidates.push({ content, score, type, confidence: score / 5 });
    }

    return candidates;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run tests/cognitive/memory/scorer.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add backend/src/cognitive/memory/scorer.ts backend/tests/cognitive/memory/scorer.test.ts
git commit -m "feat(cognitive): add MemoryScorer - LLM-based importance scoring"
```

---

## Task 6: DreamCollector + DreamPromoter (Light Sleep + Deep Sleep)

**Files:**
- Create: `backend/src/cognitive/dream/collector.ts`
- Create: `backend/src/cognitive/dream/promoter.ts`
- Create: `backend/tests/cognitive/dream/collector.test.ts`
- Create: `backend/tests/cognitive/dream/promoter.test.ts`

### 6a: DreamCollector

**Step 1: Write failing test for collector**

Create `backend/tests/cognitive/dream/collector.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DreamCollector } from '../../../src/cognitive/dream/collector.js';
import { CognitiveBus } from '../../../src/cognitive/bus.js';
import type { DbManager } from '../../../src/db.js';
import type { MemoryScorer } from '../../../src/cognitive/memory/scorer.js';
import type { CognitiveConfig } from '../../../src/cognitive/config.js';

describe('DreamCollector', () => {
  let bus: CognitiveBus;
  let mockDb: Partial<DbManager>;
  let mockScorer: Partial<MemoryScorer>;
  let collector: DreamCollector;

  beforeEach(() => {
    bus = new CognitiveBus();
    mockDb = {
      addCognitiveCandidate: vi.fn().mockResolvedValue('cand-1'),
      countCandidates: vi.fn().mockResolvedValue(3),
    };
    mockScorer = {
      score: vi.fn().mockResolvedValue([
        { content: 'User prefers dark mode', score: 4, type: 'preference', confidence: 0.8 },
      ]),
    };
    collector = new DreamCollector(
      bus, mockScorer as MemoryScorer, mockDb as DbManager,
      { dream: { minScore: 3 } } as CognitiveConfig
    );
  });

  it('should subscribe to conversation.end and score messages', async () => {
    await bus.emit('conversation.end', {
      userId: 'u1',
      messages: [
        { role: 'user', content: 'I like dark mode' },
        { role: 'assistant', content: 'Noted' },
      ],
      toolCallCount: 0,
    });

    expect(mockScorer.score).toHaveBeenCalledTimes(1);
    expect(mockDb.addCognitiveCandidate).toHaveBeenCalledTimes(1);
    expect(mockDb.addCognitiveCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'User prefers dark mode', score: 4 })
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run tests/cognitive/dream/collector.test.ts`
Expected: FAIL

**Step 3: Write DreamCollector**

Create `backend/src/cognitive/dream/collector.ts`:
```typescript
import type { DbManager } from '../../db.js';
import type { CognitiveConfig } from '../config.js';
import type { CognitiveBus, ConversationEndPayload } from '../bus.js';
import type { MemoryScorer } from '../memory/scorer.js';

export class DreamCollector {
  constructor(
    private bus: CognitiveBus,
    private scorer: MemoryScorer,
    private db: DbManager,
    private config: CognitiveConfig,
  ) {
    this.bus.on('conversation.end', this.handleConversationEnd.bind(this));
  }

  private async handleConversationEnd(payload: ConversationEndPayload): Promise<void> {
    if (payload.messages.length < 2) return;

    const candidates = await this.scorer.score(payload.messages);
    for (const cand of candidates) {
      await this.db.addCognitiveCandidate({
        ...cand,
        userId: payload.userId,
        source: `conversation-${Date.now()}`,
        stage: 'candidate',
      });
    }

    if (candidates.length > 0) {
      const count = await this.db.countCandidates(payload.userId, 'candidate');
      if (count >= this.config.dream.threshold) {
        await this.bus.emit('dream.promote.start', {
          userId: payload.userId,
          candidates: await this.db.getCognitiveCandidates(payload.userId, 'candidate'),
        });
      }
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run tests/cognitive/dream/collector.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/src/cognitive/dream/collector.ts backend/tests/cognitive/dream/collector.test.ts
git commit -m "feat(cognitive): add DreamCollector - light sleep candidate gathering"
```

### 6b: DreamPromoter

**Step 1: Write failing test for promoter**

Create `backend/tests/cognitive/dream/promoter.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DreamPromoter } from '../../../src/cognitive/dream/promoter.js';
import { CognitiveBus } from '../../../src/cognitive/bus.js';
import type { DbManager } from '../../../src/db.js';

describe('DreamPromoter', () => {
  let bus: CognitiveBus;
  let mockDb: Partial<DbManager>;

  beforeEach(() => {
    bus = new CognitiveBus();
    mockDb = {
      getLongTermMemory: vi.fn().mockResolvedValue({ markdown: '# Existing\n\nKnown facts.', updatedAt: Date.now() }),
      updateLongTermMemory: vi.fn().mockResolvedValue(undefined),
      deleteCandidates: vi.fn().mockResolvedValue(2),
      getCognitiveCandidates: vi.fn().mockResolvedValue([
        { _id: 'c1', content: 'User prefers dark mode', score: 4, type: 'preference', confidence: 0.8 },
        { _id: 'c2', content: 'User uses Beijing timezone', score: 3, type: 'fact', confidence: 0.6 },
      ]),
    };
  });

  it('should promote candidates to long-term memory and clean up', async () => {
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '# Updated Memory\n\n- User prefers dark mode\n- User uses Beijing timezone' } }],
          }),
        },
      },
    };

    const promoter = new DreamPromoter(bus, mockDb as any, mockOpenai as any, 'test-model');
    await bus.emit('dream.promote.start', {
      userId: 'u1',
      candidates: [],
    });

    expect(mockDb.updateLongTermMemory).toHaveBeenCalledWith('u1', expect.stringContaining('dark mode'));
    expect(mockDb.deleteCandidates).toHaveBeenCalledWith('u1', 'candidate');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run tests/cognitive/dream/promoter.test.ts`
Expected: FAIL

**Step 3: Write DreamPromoter**

Create `backend/src/cognitive/dream/promoter.ts`:
```typescript
import type OpenAI from 'openai';
import type { DbManager } from '../../db.js';
import type { CognitiveBus, DreamPromotePayload } from '../bus.js';

const PROMOTE_PROMPT = `你是一个记忆整合助手。将以下已有长期记忆和新候选记忆合并为一份更新的长期记忆文档。
规则：
- 保留已有记忆中有价值的部分
- 加入新的候选记忆（去重，合并相似项）
- 只保留跨会话有价值的持久信息
- 删除临时性、过时、琐碎的内容
- 输出格式为 Markdown

已有记忆：
{existingMemory}

新候选记忆：
{candidates}
`;

export class DreamPromoter {
  constructor(
    private bus: CognitiveBus,
    private db: DbManager,
    private openai: OpenAI,
    private model: string,
  ) {
    this.bus.on('dream.promote.start', this.handlePromote.bind(this));
  }

  private async handlePromote(payload: DreamPromotePayload): Promise<void> {
    const { userId } = payload;
    const candidates = await this.db.getCognitiveCandidates(userId, 'candidate');
    if (candidates.length === 0) return;

    const existing = await this.db.getLongTermMemory(userId);
    const existingMarkdown = existing?.markdown || '(无已有记忆)';
    const candidatesText = candidates.map(c => `- [${c.type}] (score: ${c.score}) ${c.content}`).join('\n');

    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a memory consolidation assistant. Output only the merged memory document in Markdown.' },
          { role: 'user', content: PROMOTE_PROMPT
            .replace('{existingMemory}', existingMarkdown)
            .replace('{candidates}', candidatesText) },
        ],
        temperature: 0.1,
        max_tokens: 4000,
      });

      const newMemory = response.choices[0]?.message?.content || existingMarkdown;
      await this.db.updateLongTermMemory(userId, newMemory);
      await this.db.deleteCandidates(userId, 'candidate');
    } catch (err) {
      console.error('[DreamPromoter] promotion failed for', userId, err);
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run tests/cognitive/dream/promoter.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/src/cognitive/dream/promoter.ts backend/tests/cognitive/dream/promoter.test.ts
git commit -m "feat(cognitive): add DreamPromoter - deep sleep memory promotion"
```

---

## Task 7: RetrievalEngine — BM25 Search

**Files:**
- Create: `backend/src/cognitive/memory/retrieval.ts`
- Create: `backend/tests/cognitive/memory/retrieval.test.ts`

**Step 1: Write the failing test**

Create `backend/tests/cognitive/memory/retrieval.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { RetrievalEngine } from '../../../src/cognitive/memory/retrieval.js';
import type { DbManager } from '../../../src/db.js';

describe('RetrievalEngine', () => {
  let engine: RetrievalEngine;
  let mockDb: Partial<DbManager>;

  beforeEach(() => {
    mockDb = {
      getLongTermMemory: vi.fn().mockResolvedValue({
        markdown: '# User Profile\n\n- Prefers TypeScript\n- Works in Beijing timezone\n- Uses VS Code editor\n- Likes dark mode theme',
      }),
      getDailyLogs: vi.fn().mockResolvedValue([
        { date: '2026-05-01', content: 'Discussed React vs Vue, user chose React for new project' },
        { date: '2026-05-02', content: 'User asked about Python deployment options' },
      ]),
      getActiveCognitiveSkills: vi.fn().mockResolvedValue([
        { name: 'debug-workflow', description: 'Systematic debugging approach', content: 'Step 1: Reproduce. Step 2: Isolate.', confidence: 0.9 },
      ]),
    };
    engine = new RetrievalEngine(mockDb as any, { retrieval: { topK: 5, bm25: { enabled: true }, vector: { enabled: false }, fusion: { method: 'rrf', k: 60 } } } as any);
  });

  it('should build index and return relevant results for TypeScript query', async () => {
    await engine.rebuildIndex('u1');
    const results = await engine.query('u1', 'TypeScript preference');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain('TypeScript');
  });

  it('should return relevant results for Beijing timezone query', async () => {
    await engine.rebuildIndex('u1');
    const results = await engine.query('u1', 'timezone');
    expect(results.length).toBeGreaterThan(0);
  });

  it('should return empty for no match', async () => {
    await engine.rebuildIndex('u1');
    const results = await engine.query('u1', 'quantum physics research');
    expect(results.length).toBeLessThanOrEqual(2); // may have weak matches
  });

  it('should respect topK limit', async () => {
    await engine.rebuildIndex('u1');
    const results = await engine.query('u1', 'user preferences');
    expect(results.length).toBeLessThanOrEqual(5);
  });
});
```

Note: Add `import { vi } from 'vitest';` at the top.

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run tests/cognitive/memory/retrieval.test.ts`
Expected: FAIL

**Step 3: Write implementation**

Create `backend/src/cognitive/memory/retrieval.ts`:
```typescript
import MiniSearch from 'minisearch';
import type { DbManager } from '../../db.js';
import type { CognitiveConfig } from '../config.js';

interface SearchDoc {
  id: string;
  text: string;
  type: 'memory' | 'log' | 'skill';
  date?: string;
}

interface RetrievalResult {
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
        if (line.startsWith('#')) continue; // skip headers
        docs.push({ id: `mem-${docCounter++}`, text: line, type: 'memory' });
      }
    }

    // 2. Daily logs (last 7 days)
    const logs = await this.db.getDailyLogs(userId, 7);
    for (const log of logs) {
      const logLines = log.content.split('\n').filter(l => l.trim());
      for (const line of logLines) {
        docs.push({ id: `log-${log.date}-${docCounter++}`, text: line, type: 'log', date: log.date });
      }
    }

    // 3. Active cognitive skills
    const skills = await this.db.getActiveCognitiveSkills(userId);
    for (const skill of skills) {
      docs.push({ id: `skill-${skill.name}`, text: `${skill.description}\n${skill.content}`, type: 'skill' });
    }

    const index = new MiniSearch<SearchDoc>({
      fields: ['text'],
      storeFields: ['text', 'type', 'date'],
      idField: 'id',
    });
    index.addAll(docs);
    this.indexes.set(userId, index);
  }

  async query(userId: string, query: string): Promise<RetrievalResult[]> {
    let index = this.indexes.get(userId);
    if (!index) {
      await this.rebuildIndex(userId);
      index = this.indexes.get(userId);
    }
    if (!index) return [];

    const results = index.search(query, {
      prefix: true,
      fuzzy: 0.2,
      boost: { text: 1 },
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
    const sections: string[] = [];
    const byType = new Map<string, RetrievalResult[]>();
    for (const r of results) {
      if (!byType.has(r.type)) byType.set(r.type, []);
      byType.get(r.type)!.push(r);
    }

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
```

**Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run tests/cognitive/memory/retrieval.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add backend/src/cognitive/memory/retrieval.ts backend/tests/cognitive/memory/retrieval.test.ts
git commit -m "feat(cognitive): add RetrievalEngine with BM25 search (minisearch)"
```

---

## Task 8: LearnExtractor — Experience Extraction

**Files:**
- Create: `backend/src/cognitive/learn/extractor.ts`
- Create: `backend/tests/cognitive/learn/extractor.test.ts`

**Step 1: Write the failing test**

Create `backend/tests/cognitive/learn/extractor.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { LearnExtractor } from '../../../src/cognitive/learn/extractor.js';
import type { ChatMessage } from '../../../src/types.js';

const complexConversation: ChatMessage[] = [
  { role: 'user', content: 'Help me research React vs Vue for my new project' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', name: 'fetch_url', arguments: '{"url": "https://react.dev"}' }] },
  { role: 'tool', content: 'React is a UI library by Meta...', tool_call_id: 'tc1' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'tc2', name: 'fetch_url', arguments: '{"url": "https://vuejs.org"}' }] },
  { role: 'tool', content: 'Vue is a progressive framework...', tool_call_id: 'tc2' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'tc3', name: 'fetch_url', arguments: '{"url": "https://...comparison"}' }] },
  { role: 'tool', content: 'Comparison: React has larger ecosystem...', tool_call_id: 'tc3' },
  { role: 'assistant', content: 'Based on research, here is the comparison...' },
];

const mockOpenai = {
  chat: {
    completions: {
      create: vi.fn().mockResolvedValue({
        choices: [{
          message: {
            content: `---
name: framework-research-workflow
description: Systematic tech framework research and comparison
triggers: [research, compare, 对比, 调研]
---
# Framework Research Workflow
## 适用场景
Comparing technology frameworks for project decisions.
## 步骤
1. Fetch official documentation for each framework
2. Find comparison articles/benchmarks
3. Summarize pros/cons for user's context
## 注意事项
- Always fetch from official sources first
- Consider user's existing tech stack`,
          },
        }],
      }),
    },
  },
};

describe('LearnExtractor', () => {
  it('should extract experience from complex tool-call conversation', async () => {
    const extractor = new LearnExtractor(mockOpenai as any, 'test-model');
    const result = await extractor.extract(complexConversation, 'u1');

    expect(result.shouldGenerate).toBe(true);
    expect(result.skill).toBeDefined();
    expect(result.skill.name).toBe('framework-research-workflow');
    expect(result.skill.description).toContain('research');
    expect(result.skill.triggers.length).toBeGreaterThan(0);
  });

  it('should skip simple conversations with no tool calls', async () => {
    const extractor = new LearnExtractor(mockOpenai as any, 'test-model');
    const result = await extractor.extract([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ], 'u1');

    expect(result.shouldGenerate).toBe(false);
  });

  it('should skip when tool calls below threshold', async () => {
    const extractor = new LearnExtractor(mockOpenai as any, 'test-model', { minToolCalls: 3 });
    const result = await extractor.extract([
      { role: 'user', content: 'Search X' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', name: 'fetch_url', arguments: '{}' }] },
      { role: 'tool', content: 'result', tool_call_id: 'tc1' },
      { role: 'assistant', content: 'Here is what I found.' },
    ], 'u1');

    expect(result.shouldGenerate).toBe(false);
  });

  it('should handle LLM failure gracefully', async () => {
    const failingOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error('timeout')),
        },
      },
    };
    const extractor = new LearnExtractor(failingOpenai as any, 'test-model');
    const result = await extractor.extract(complexConversation, 'u1');
    expect(result.shouldGenerate).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run tests/cognitive/learn/extractor.test.ts`
Expected: FAIL

**Step 3: Write implementation**

Create `backend/src/cognitive/learn/extractor.ts`:
```typescript
import type OpenAI from 'openai';
import type { ChatMessage } from '../../types.js';

const EXTRACTION_PROMPT = `以下是一次涉及多次工具调用的复杂交互记录。分析这次交互，提取可复用的方法论。

如果这次交互值得总结为一个可复用的 Skill，按 agentskills.io 格式输出完整的 Skill 文档（YAML frontmatter + Markdown 内容）。
如果交互是常规操作不值得总结，返回空内容。

关键要求：
- name: 简短英文 slug
- description: 一句话描述
- triggers: 触发关键词数组（中英文）
- 内容包括：适用场景、步骤、注意事项

交互记录：
`;

export interface ExtractedSkill {
  name: string;
  description: string;
  content: string;
  triggers: string[];
}

export interface ExtractionResult {
  shouldGenerate: boolean;
  skill?: ExtractedSkill;
}

export class LearnExtractor {
  private minToolCalls: number;

  constructor(
    private openai: OpenAI,
    private model: string,
    opts?: { minToolCalls?: number },
  ) {
    this.minToolCalls = opts?.minToolCalls ?? 3;
  }

  async extract(messages: ChatMessage[], userId: string): Promise<ExtractionResult> {
    const toolCallCount = messages.filter(m => m.tool_calls).reduce((sum, m) => sum + (m.tool_calls?.length || 0), 0);
    if (toolCallCount < this.minToolCalls) {
      return { shouldGenerate: false };
    }

    try {
      const conversationText = this.formatConversation(messages);
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a skill extraction assistant. Output only the skill document in Markdown with YAML frontmatter, or empty if not worth extracting.' },
          { role: 'user', content: EXTRACTION_PROMPT + conversationText },
        ],
        temperature: 0.2,
        max_tokens: 3000,
      });

      const text = response.choices[0]?.message?.content?.trim() || '';
      if (!text || text.length < 50) {
        return { shouldGenerate: false };
      }

      const skill = this.parseSkillDocument(text);
      if (!skill) {
        return { shouldGenerate: false };
      }

      return { shouldGenerate: true, skill };
    } catch (err) {
      console.error('[LearnExtractor] extraction failed:', err);
      return { shouldGenerate: false };
    }
  }

  private formatConversation(messages: ChatMessage[]): string {
    return messages
      .map(m => {
        if (m.role === 'tool') return `[tool result] ${m.content}`;
        if (m.tool_calls) return `[assistant] called tools: ${m.tool_calls.map(tc => `${tc.name}(${tc.arguments})`).join(', ')}`;
        return `[${m.role}] ${m.content}`;
      })
      .join('\n');
  }

  private parseSkillDocument(text: string): ExtractedSkill | null {
    const frontmatterMatch = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!frontmatterMatch) return null;

    const fm = frontmatterMatch[1];
    const content = frontmatterMatch[2].trim();

    const nameMatch = fm.match(/name:\s*(.+)/);
    const descMatch = fm.match(/description:\s*(.+)/);
    const triggersMatch = fm.match(/triggers:\s*\[([^\]]+)\]/);

    if (!nameMatch || !descMatch) return null;

    const name = nameMatch[1].trim();
    const description = descMatch[1].trim();
    const triggers = triggersMatch
      ? triggersMatch[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, ''))
      : [];

    if (!name || !content) return null;

    return { name, description, content, triggers };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run tests/cognitive/learn/extractor.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add backend/src/cognitive/learn/extractor.ts backend/tests/cognitive/learn/extractor.test.ts
git commit -m "feat(cognitive): add LearnExtractor - experience extraction from tool calls"
```

---

## Task 9: LearnGenerator — Skill Generation + Dedup

**Files:**
- Create: `backend/src/cognitive/learn/generator.ts`
- Create: `backend/tests/cognitive/learn/generator.test.ts`

**Step 1: Write the failing test**

Create `backend/tests/cognitive/learn/generator.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LearnGenerator } from '../../../src/cognitive/learn/generator.js';
import { CognitiveBus } from '../../../src/cognitive/bus.js';
import type { DbManager } from '../../../src/db.js';

describe('LearnGenerator', () => {
  let bus: CognitiveBus;
  let mockDb: Partial<DbManager>;

  beforeEach(() => {
    bus = new CognitiveBus();
    mockDb = {
      getCognitiveSkills: vi.fn().mockResolvedValue([]),
      getSkills: vi.fn().mockResolvedValue([]),
      addCognitiveSkill: vi.fn().mockResolvedValue('skill-1'),
    };
  });

  it('should generate a new skill and emit event', async () => {
    const generator = new LearnGenerator(bus, mockDb as any, { autoLevel: 'semi-auto', learn: { skillConfirmRequired: true } } as any);

    bus.on('learning.skill.generated', vi.fn());
    await generator.generate('u1', {
      name: 'test-workflow',
      description: 'A test workflow',
      content: '# Test\n\nSteps here.',
      triggers: ['test', '测试'],
    }, 'session-abc');

    expect(mockDb.addCognitiveSkill).toHaveBeenCalledTimes(1);
    const call = (mockDb.addCognitiveSkill as any).mock.calls[0][0];
    expect(call.confirmedAt).toBeNull(); // semi-auto: needs confirmation
    expect(call.autoGenerated).toBe(true);
  });

  it('should auto-confirm in full-auto mode', async () => {
    mockDb.getCognitiveSkills = vi.fn().mockResolvedValue([]);
    const generator = new LearnGenerator(bus, mockDb as any, { autoLevel: 'full-auto', learn: { skillConfirmRequired: false } } as any);

    await generator.generate('u1', {
      name: 'test-workflow',
      description: 'A test workflow',
      content: '# Test\n\nSteps here.',
      triggers: ['test'],
    }, 'session-abc');

    const call = (mockDb.addCognitiveSkill as any).mock.calls[0][0];
    expect(call.confirmedAt).not.toBeNull();
  });

  it('should skip if skill with same name already exists', async () => {
    mockDb.getCognitiveSkills = vi.fn().mockResolvedValue([
      { name: 'test-workflow', active: true, confirmedAt: new Date() },
    ]);

    const generator = new LearnGenerator(bus, mockDb as any, { autoLevel: 'semi-auto', learn: { skillConfirmRequired: true } } as any);
    await generator.generate('u1', {
      name: 'test-workflow',
      description: 'A test workflow',
      content: '# Test',
      triggers: ['test'],
    }, 'session-abc');

    expect(mockDb.addCognitiveSkill).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run tests/cognitive/learn/generator.test.ts`
Expected: FAIL

**Step 3: Write implementation**

Create `backend/src/cognitive/learn/generator.ts`:
```typescript
import type { DbManager } from '../../db.js';
import type { CognitiveConfig } from '../config.js';
import type { CognitiveBus } from '../bus.js';
import type { ExtractedSkill } from './extractor.js';

export class LearnGenerator {
  constructor(
    private bus: CognitiveBus,
    private db: DbManager,
    private config: CognitiveConfig,
  ) {}

  async generate(userId: string, skill: ExtractedSkill, sessionId: string): Promise<boolean> {
    // Check for existing skill with same name
    const existingSkills = await this.db.getCognitiveSkills(userId);
    if (existingSkills.some(s => s.name === skill.name && s.active)) {
      console.log(`[LearnGenerator] skill "${skill.name}" already exists, skipping`);
      return false;
    }

    const isFullAuto = this.config.autoLevel === 'full-auto';

    await this.db.addCognitiveSkill({
      userId,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      version: 1,
      confidence: 0.5,
      autoGenerated: true,
      sourceConversationIds: [sessionId],
      confirmedAt: isFullAuto ? new Date() : null,
      active: true,
    });

    await this.bus.emit('learning.skill.generated', {
      userId,
      skill: {
        name: skill.name,
        description: skill.description,
        content: skill.content,
        triggers: skill.triggers,
        autoGenerated: true,
      },
      needsConfirmation: !isFullAuto,
    });

    return true;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run tests/cognitive/learn/generator.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add backend/src/cognitive/learn/generator.ts backend/tests/cognitive/learn/generator.test.ts
git commit -m "feat(cognitive): add LearnGenerator - skill generation with dedup + auto-confirm"
```

---

## Task 10: CognitiveAdapter — Bridge to ConversationEngine

**Files:**
- Create: `backend/src/cognitive/adapter.ts`
- Create: `backend/tests/cognitive/adapter.test.ts`

**Step 1: Write the failing test**

Create `backend/tests/cognitive/adapter.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CognitiveAdapter } from '../../../src/cognitive/adapter.js';
import { CognitiveBus } from '../../../src/cognitive/bus.js';
import type { DbManager } from '../../../src/db.js';

describe('CognitiveAdapter', () => {
  let bus: CognitiveBus;
  let mockDb: Partial<DbManager>;
  let adapter: CognitiveAdapter;

  beforeEach(() => {
    bus = new CognitiveBus();
    mockDb = {
      getLongTermMemory: vi.fn().mockResolvedValue({ markdown: '# Memory\n\nTypeScript fan' }),
      getDailyLogs: vi.fn().mockResolvedValue([{ date: '2026-05-02', content: 'Some log' }]),
      getActiveCognitiveSkills: vi.fn().mockResolvedValue([]),
      getCommitments: vi.fn().mockResolvedValue([]),
      getEnabledSkills: vi.fn().mockResolvedValue([]),
    };
    adapter = new CognitiveAdapter(bus, mockDb as any, { retrieval: { topK: 3, bm25: { enabled: true }, vector: { enabled: false }, fusion: { method: 'rrf', k: 60 } } } as any);
  });

  it('should emit conversation.end with correct payload', async () => {
    const spy = vi.fn();
    bus.on('conversation.end', spy);

    await adapter.afterConversation('u1', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', name: 'fetch_url', arguments: '{}' }] },
      { role: 'tool', content: 'result', tool_call_id: 't1' },
    ]);

    expect(spy).toHaveBeenCalledWith({
      userId: 'u1',
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant' }),
      ]),
      toolCallCount: 1,
    });
  });

  it('should get memory context via retrieval engine', async () => {
    const context = await adapter.getMemoryContext('u1', 'TypeScript');
    expect(typeof context).toBe('string');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run tests/cognitive/adapter.test.ts`
Expected: FAIL

**Step 3: Write implementation**

Create `backend/src/cognitive/adapter.ts`:
```typescript
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
      // Fallback: load full MEMORY.md like original
      const memory = await this.db.getLongTermMemory(userId);
      return memory?.markdown || '';
    }

    await this.retrieval.rebuildIndex(userId);
    const results = await this.retrieval.query(userId, query);
    const context = this.retrieval.formatAsContext(results);

    if (!context) {
      // Fallback to full memory
      const memory = await this.db.getLongTermMemory(userId);
      return memory?.markdown || '';
    }

    return context;
  }

  async afterConversation(userId: string, messages: ChatMessage[]): Promise<void> {
    const toolCallCount = messages.reduce((sum, m) => sum + (m.tool_calls?.length || 0), 0);
    await this.bus.emit('conversation.end', {
      userId,
      messages,
      toolCallCount,
    });
  }

  async getSkillsContext(userId: string): Promise<string> {
    const parts: string[] = [];

    // Original skills
    const enabledSkills = await this.db.getEnabledSkills(userId);
    for (const skill of enabledSkills) {
      parts.push(`### Skill: ${skill.name}\n${skill.content}`);
    }

    // Active cognitive skills
    const cognitiveSkills = await this.db.getActiveCognitiveSkills(userId);
    for (const skill of cognitiveSkills) {
      parts.push(`### Auto-Skill: ${skill.name} (confidence: ${skill.confidence})\n${skill.content}`);
    }

    return parts.length > 0
      ? `## Skills & Methods\n\n${parts.join('\n\n')}`
      : '';
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run tests/cognitive/adapter.test.ts`
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add backend/src/cognitive/adapter.ts backend/tests/cognitive/adapter.test.ts
git commit -m "feat(cognitive): add CognitiveAdapter - bridge to ConversationEngine"
```

---

## Task 11: CognitiveCore — Main Entry Point

**Files:**
- Create: `backend/src/cognitive/index.ts`
- Create: `backend/tests/cognitive/core.test.ts`

**Step 1: Write the failing test**

Create `backend/tests/cognitive/core.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CognitiveCore } from '../../../src/cognitive/index.js';
import type { DbManager } from '../../../src/db.js';

describe('CognitiveCore', () => {
  it('should initialize all sub-modules', () => {
    const mockDb = {} as DbManager;
    const mockOpenai = {} as any;

    const core = CognitiveCore.create(mockDb, mockOpenai, 'test-model', {});
    expect(core.bus).toBeDefined();
    expect(core.adapter).toBeDefined();
  });

  it('should use default config when none provided', () => {
    const core = CognitiveCore.create({} as DbManager, {} as any, 'model');
    expect(core.config.autoLevel).toBe('semi-auto');
  });

  it('should accept partial config overrides', () => {
    const core = CognitiveCore.create({} as DbManager, {} as any, 'model', {
      autoLevel: 'full-auto',
    });
    expect(core.config.autoLevel).toBe('full-auto');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run tests/cognitive/core.test.ts`
Expected: FAIL

**Step 3: Write implementation**

Create `backend/src/cognitive/index.ts`:
```typescript
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

  private scorer: MemoryScorer;
  private collector: DreamCollector;
  private promoter: DreamPromoter;
  private extractor: LearnExtractor;
  private generator: LearnGenerator;

  private constructor(
    config: CognitiveConfig,
    bus: CognitiveBus,
    adapter: CognitiveAdapter,
    retrieval: RetrievalEngine,
    scorer: MemoryScorer,
    collector: DreamCollector,
    promoter: DreamPromoter,
    extractor: LearnExtractor,
    generator: LearnGenerator,
  ) {
    this.config = config;
    this.bus = bus;
    this.adapter = adapter;
    this.retrieval = retrieval;
    this.scorer = scorer;
    this.collector = collector;
    this.promoter = promoter;
    this.extractor = extractor;
    this.generator = generator;
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
    const collector = new DreamCollector(bus, scorer, db, config);
    const promoter = new DreamPromoter(bus, db, openai, model);
    const extractor = new LearnExtractor(openai, model, {
      minToolCalls: config.learn.minToolCalls,
    });
    const generator = new LearnGenerator(bus, db, config);

    return new CognitiveCore(
      config, bus, adapter, retrieval,
      scorer, collector, promoter, extractor, generator,
    );
  }
}

export type { CognitiveConfig };
export { CognitiveBus } from './bus.js';
export { CognitiveAdapter } from './adapter.js';
```

**Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run tests/cognitive/core.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add backend/src/cognitive/index.ts backend/tests/cognitive/core.test.ts
git commit -m "feat(cognitive): add CognitiveCore - main entry point wiring all modules"
```

---

## Task 12: Integrate CognitiveCore into ConversationEngine

**Files:**
- Modify: `backend/src/engine.ts` (use adapter for memory + skills context)
- Modify: `backend/src/index.ts` (create CognitiveCore, pass to engine)
- Modify: `backend/src/types.ts` (add cognitive config to Config)

**Step 1: Add cognitive config to Config type**

In `backend/src/types.ts`, add to the `Config` interface (after `scheduler?`):
```typescript
cognitive?: {
  autoLevel?: 'manual' | 'semi-auto' | 'full-auto';
  dream?: { threshold?: number; minScore?: number };
  learn?: { minToolCalls?: number };
  retrieval?: { topK?: number };
};
```

**Step 2: Modify ConversationEngine to accept adapter**

In `backend/src/engine.ts`, add a new private field and update constructor:

```typescript
// Add import at top:
import type { CognitiveAdapter } from './cognitive/adapter.js';

// In ConversationEngine class, add field:
private cognitiveAdapter?: CognitiveAdapter;

// Update constructor signature (add cognitiveAdapter as optional param):
constructor(
  config: Config,
  mcp: McpManager,
  db?: DbManager,
  memory?: MemoryEngine,
  skill?: SkillEngine,
  cognitiveAdapter?: CognitiveAdapter,
) {
  // ... existing code ...
  this.cognitiveAdapter = cognitiveAdapter;
  // ... rest of constructor ...
}
```

**Step 3: Modify buildSystemPrompt to use cognitive adapter**

In `engine.ts`, update `buildSystemPrompt()` (around line 349). Replace the memory/skills injection block:

```typescript
private async buildSystemPrompt(userId?: string): Promise<string> {
  const tools = this.getTools();
  const toolSection = tools.map(t => `- ${t.name}: ${t.description}`).join('\n');

  let memorySection = '';
  if (userId) {
    if (this.cognitiveAdapter) {
      // Use cognitive adapter for retrieval-based memory context
      const latestUserMsg = this.findLatestUserMessage();
      memorySection = await this.cognitiveAdapter.getMemoryContext(userId, latestUserMsg);
    } else if (this.memory) {
      // Fallback to original memory engine
      memorySection = await this.memory.getMemoryContext(userId);
    }

    if (this.memory) {
      const commitments = await this.memory.getCommitmentsContext(userId);
      if (commitments) memorySection += '\n\n' + commitments;
    }
  }

  let skillSection = '';
  if (userId) {
    if (this.cognitiveAdapter) {
      skillSection = await this.cognitiveAdapter.getSkillsContext(userId);
    } else if (this.skill) {
      skillSection = await this.skill.getSkillsContext(userId);
    }
  }

  const basePrompt = `你是一个智能助手。你可以使用以下工具来帮助用户：

## 可用工具
${toolSection}
${memorySection ? `\n${memorySection}` : ''}
${skillSection ? `\n${skillSection}` : ''}

## 规则
- 先理解用户意图，再决定使用哪些工具
- 使用工具时，确保参数正确
- 回答要简洁、准确、有帮助
- 如果工具调用失败，向用户解释原因`;

  return basePrompt;
}

private findLatestUserMessage(): string {
  for (let i = this.sessions.values().length - 1; i >= 0; i--) {
    const msgs = Array.from(this.sessions.values())[i];
    for (let j = msgs.length - 1; j >= 0; j--) {
      if (msgs[j].role === 'user') return msgs[j].content;
    }
  }
  return '';
}
```

**Step 4: Modify triggerMemoryHooks to emit cognitive event**

In `engine.ts`, update `triggerMemoryHooks()` (around line 391):

```typescript
triggerMemoryHooks(sessionId: string, userId?: string): void {
  const messages = this.sessions.get(sessionId);
  if (!messages) return;

  // Clone and strip reasoning_content for storage/cognitive processing
  const cleaned = messages.map(m => {
    if (m.role === 'assistant' && m.reasoning_content) {
      const { reasoning_content, ...rest } = m;
      return rest as ChatMessage;
    }
    return m;
  });

  // Original memory hooks (preserved)
  if (this.memory && userId) {
    this.memory.afterConversation(userId, cleaned);
  }

  // Cognitive bus event (new)
  if (this.cognitiveAdapter && userId) {
    this.cognitiveAdapter.afterConversation(userId, cleaned).catch(err => {
      console.error('[Cognitive] event emit failed:', err);
    });
  }
}
```

**Step 5: Modify index.ts startup to create CognitiveCore**

In `backend/src/index.ts`, add import and initialization:

```typescript
// Add import:
import { CognitiveCore } from './cognitive/index.js';

// Add module-level variable:
let cognitive: CognitiveCore | undefined;

// In start() function, after skill engine initialization (around line 416), add:
if (db && config.mongodb) {
  cognitive = CognitiveCore.create(db, openai, config.llm.model, config.cognitive);
  console.log('[Cognitive] Core initialized, mode:', cognitive.config.autoLevel);
}

// Update ConversationEngine creation to pass cognitive adapter (line 477):
engine = new ConversationEngine(config, mcp, db, memory, skillEngine, cognitive?.adapter);
```

**Step 6: Build and verify no type errors**

Run: `cd backend && npx tsc --noEmit`
Expected: No errors

**Step 7: Commit**

```bash
git add backend/src/types.ts backend/src/engine.ts backend/src/index.ts
git commit -m "feat(cognitive): integrate CognitiveCore into ConversationEngine"
```

---

## Task 13: API Endpoints for Cognitive Features

**Files:**
- Modify: `backend/src/index.ts` (add new routes)

**Step 1: Add cognitive skill endpoints**

In `backend/src/index.ts`, add these routes after the existing skills routes (around line 369):

```typescript
// ── Cognitive Skills ──

app.get('/api/cognitive/skills/:userId', async (req, res) => {
  try {
    const skills = await db!.getCognitiveSkills(req.params.userId);
    res.json(skills);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cognitive/skills/:userId/pending', async (req, res) => {
  try {
    const all = await db!.getCognitiveSkills(req.params.userId);
    const pending = all.filter(s => s.confirmedAt === null);
    res.json(pending);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cognitive/skills/:userId/:id/confirm', async (req, res) => {
  try {
    await db!.confirmCognitiveSkill(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/cognitive/skills/:userId/:id', async (req, res) => {
  try {
    await db!.deactivateCognitiveSkill(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cognitive Candidates ──

app.get('/api/cognitive/candidates/:userId', async (req, res) => {
  try {
    const candidates = await db!.getCognitiveCandidates(req.params.userId, 'candidate');
    res.json(candidates);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cognitive Config ──

app.get('/api/cognitive/config', (_req, res) => {
  res.json(cognitive?.config || null);
});
```

**Step 2: Build and verify**

Run: `cd backend && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat(api): add cognitive skills, candidates, and config endpoints"
```

---

## Task 14: Update config.json Example + Root Config

**Files:**
- Modify: `backend/config.example.json` (add cognitive section)

**Step 1: Add cognitive config to example**

In `backend/config.example.json`, add at the end:
```json
{
  "cognitive": {
    "autoLevel": "semi-auto",
    "dream": {
      "threshold": 5,
      "minScore": 3
    },
    "learn": {
      "minToolCalls": 3
    },
    "retrieval": {
      "topK": 8
    }
  }
}
```

(Add as a sibling to the existing top-level keys.)

**Step 2: Commit**

```bash
git add backend/config.example.json
git commit -m "docs(config): add cognitive config example"
```

---

## Task 15: Integration Verification

**Step 1: Run all tests**

Run: `cd backend && npx vitest run`
Expected: All tests PASS

**Step 2: Build the project**

Run: `cd backend && npm run build`
Expected: No errors

**Step 3: Verify the full cognitive loop works**

Start the server with cognitive config:
```bash
cd backend && npm run dev
```

Then test the flow:
1. POST `/api/chat` with a message containing user preferences
2. GET `/api/cognitive/candidates/:userId` — should show scored candidates
3. After 5+ conversations, candidates should auto-promote
4. POST `/api/chat` with complex tool-call conversation (3+ calls)
5. GET `/api/cognitive/skills/:userId/pending` — should show generated skill
6. POST `/api/cognitive/skills/:userId/:id/confirm` — confirm the skill
7. POST `/api/chat` again — system prompt should include the confirmed auto-skill

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat(cognitive): complete Phase 1 - dreaming + learning + BM25 retrieval"
```

---

## Summary: Phase 1 File Map

```
backend/
├── src/
│   └── cognitive/
│       ├── index.ts              # CognitiveCore (Task 11)
│       ├── config.ts             # Config types + validation (Task 2)
│       ├── bus.ts                # Event system (Task 3)
│       ├── adapter.ts            # Bridge to ConversationEngine (Task 10)
│       ├── memory/
│       │   ├── scorer.ts         # LLM memory scoring (Task 5)
│       │   └── retrieval.ts      # BM25 search (Task 7)
│       └── dream/
│           ├── collector.ts      # Light sleep (Task 6a)
│           └── promoter.ts       # Deep sleep (Task 6b)
│       └── learn/
│           ├── extractor.ts      # Experience extraction (Task 8)
│           └── generator.ts      # Skill generation (Task 9)
├── tests/
│   └── cognitive/
│       ├── config.test.ts
│       ├── bus.test.ts
│       ├── core.test.ts
│       ├── adapter.test.ts
│       ├── db-extensions.test.ts
│       ├── memory/
│       │   ├── scorer.test.ts
│       │   └── retrieval.test.ts
│       ├── dream/
│       │   ├── collector.test.ts
│       │   └── promoter.test.ts
│       └── learn/
│           ├── extractor.test.ts
│           └── generator.test.ts
└── [modified]
    ├── src/types.ts              # +CognitiveCandidateDoc, +CognitiveSkillDoc, +Config.cognitive
    ├── src/db.ts                 # +cognitive collection methods
    ├── src/engine.ts             # +cognitiveAdapter field, modified buildSystemPrompt/triggerMemoryHooks
    └── src/index.ts              # +CognitiveCore init, +cognitive API routes
```

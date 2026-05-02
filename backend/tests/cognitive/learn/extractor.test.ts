import { describe, it, expect, vi } from 'vitest';
import { LearnExtractor } from '../../../src/cognitive/learn/extractor.js';
import type { ChatMessage } from '../../../src/types.js';

const complexConversation: ChatMessage[] = [
  { role: 'user', content: 'Help me research React vs Vue for my new project' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', name: 'fetch_url', arguments: '{"url": "https://react.dev"}' }] },
  { role: 'tool', content: 'React is a UI library by Meta...', tool_call_id: 'tc1' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'tc2', name: 'fetch_url', arguments: '{"url": "https://vuejs.org"}' }] },
  { role: 'tool', content: 'Vue is a progressive framework...', tool_call_id: 'tc2' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'tc3', name: 'fetch_url', arguments: '{"url": "https://example.com/comparison"}' }] },
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
    expect(result.skill!.name).toBe('framework-research-workflow');
    expect(result.skill!.description).toContain('research');
    expect(result.skill!.triggers.length).toBeGreaterThan(0);
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
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error('timeout')) } },
    };
    const extractor = new LearnExtractor(failingOpenai as any, 'test-model');
    const result = await extractor.extract(complexConversation, 'u1');
    expect(result.shouldGenerate).toBe(false);
  });
});

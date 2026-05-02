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

  async extract(messages: ChatMessage[], _userId: string): Promise<ExtractionResult> {
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

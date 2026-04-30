import type { DbManager } from "./db.js";

/** Parse a SKILL.md string into structured fields.
 *  Expects YAML frontmatter between `---` fences.
 */
export function parseSkillMarkdown(markdown: string): {
  name: string;
  description: string;
  triggers: string[];
  content: string;
} | null {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1];
  const content = match[2].trim();

  const name = frontmatter.match(/name:\s*(.+)/)?.[1]?.trim();
  const description = frontmatter.match(/description:\s*(.+)/)?.[1]?.trim();
  const triggersRaw = frontmatter.match(/triggers:\s*\[(.*?)\]/)?.[1];
  const triggers = triggersRaw
    ? triggersRaw.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))
    : [];

  if (!name || !description) return null;
  return { name, description, triggers, content };
}

const BUILTIN_SKILLS: Array<{
  name: string;
  description: string;
  triggers: string[];
  content: string;
}> = [
  {
    name: "emoji-translator",
    description: "把用户的文字翻译成emoji表情。当用户说'用emoji说'或'翻译成emoji'时触发。",
    triggers: ["emoji", "表情", "用emoji", "翻译成emoji"],
    content: `你是一个emoji翻译专家。

规则：
1. 当用户要求把文字翻译成emoji时，只输出emoji，不要加任何解释文字
2. 尽量保持原句的意思和情感
3. 可以混合少量中文标点来增强表达

示例：
- "我喜欢吃火锅" → 🍲❤️😋
- "今天天气真好" → ☀️👍🌈
- "我成功了" → 🎉✅💪`,
  },
];

export class SkillEngine {
  private db: DbManager;

  constructor(db: DbManager) {
    this.db = db;
  }

  /** Seed builtin skills if not present */
  async initBuiltinSkills(): Promise<void> {
    for (const skill of BUILTIN_SKILLS) {
      await this.db.initBuiltinSkill({
        userId: undefined,
        name: skill.name,
        description: skill.description,
        triggers: skill.triggers,
        content: skill.content,
        enabled: true,
        builtin: true,
      });
    }
  }

  /** Get formatted skill context for system prompt injection */
  async getSkillsContext(userId: string): Promise<string> {
    const skills = await this.db.getEnabledSkills(userId);
    if (skills.length === 0) return "";

    const lines = skills.map((s) => `【${s.name}】${s.description}\n${s.content}`);
    return `【已启用技能】\n${lines.join("\n\n")}\n当用户需求匹配某个技能时，请严格按照该技能的指令执行。`;
  }
}

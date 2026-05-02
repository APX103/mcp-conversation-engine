import type OpenAI from 'openai';
import type { DbManager } from '../../db.js';
import type { CognitiveBus } from '../bus.js';
import type { CognitiveConfig } from '../config.js';
import type { CognitiveSkillDoc } from '../../types.js';

export class LearnIterater {
  private failureCounts = new Map<string, number>(); // userId:skillName -> count

  constructor(
    private bus: CognitiveBus,
    private db: DbManager,
    private config: CognitiveConfig,
    private openai: OpenAI,
    private model: string,
  ) {
    this.bus.on('learning.skill.used', this.handleSkillUsed.bind(this));
  }

  private async handleSkillUsed(payload: { userId: string; skillName: string; success: boolean }): Promise<void> {
    const { userId, skillName, success } = payload;
    const skills = await this.db.getCognitiveSkills(userId);
    const skill = skills.find((s: CognitiveSkillDoc) => s.name === skillName);
    if (!skill || !skill.active) return;

    if (success) {
      const newConf = Math.min(1.0, skill.confidence + this.config.learn.confidence.boost);
      await this.db.updateCognitiveSkillConfidence(skill._id!.toString(), newConf);
    } else {
      const newConf = Math.max(0, skill.confidence - this.config.learn.confidence.decay);
      await this.db.updateCognitiveSkillConfidence(skill._id!.toString(), newConf);

      const key = `${userId}:${skillName}`;
      const failures = (this.failureCounts.get(key) || 0) + 1;
      this.failureCounts.set(key, failures);

      if (newConf < this.config.learn.confidence.minForRevision) {
        await this.db.deactivateCognitiveSkill(skill._id!.toString());
      } else if (failures >= 3) {
        await this.reviseSkill(userId, skill);
        this.failureCounts.set(key, 0);
      }
    }
  }

  private async reviseSkill(_userId: string, skill: CognitiveSkillDoc): Promise<void> {
    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a skill revision assistant. Improve the skill based on failure feedback. Output the updated skill in Markdown with YAML frontmatter.' },
          { role: 'user', content: `Revise this skill which has been failing:\n\n# ${skill.name}\n${skill.content}\n\nImprove it to handle edge cases better.` },
        ],
        temperature: 0.2,
        max_tokens: 3000,
      });

      const newContent = response.choices[0]?.message?.content?.trim();
      if (newContent && skill.version < this.config.learn.maxSkillVersion) {
        await this.db.updateCognitiveSkillContent(skill._id!.toString(), newContent, skill.version + 1);
      }
    } catch (err) {
      console.error('[LearnIterater] skill revision failed:', err);
    }
  }
}

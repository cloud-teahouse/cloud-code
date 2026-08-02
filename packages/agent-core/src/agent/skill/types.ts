import type { SkillDefinition } from '../../skill';

export interface SkillRegistry {
  getSkill(name: string): SkillDefinition | undefined;
  getPluginSkill(pluginId: string, name: string): SkillDefinition | undefined;
  renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string;
  listInvocableSkills(): readonly SkillDefinition[];
  getSkillRoots(): readonly string[];
  getModelSkillListing(): string;
  /** True while at least one `paths`-gated skill waits for a matching touch. */
  hasPendingConditionalSkills(): boolean;
  /**
   * Activate pending `paths`-gated skills matching any touched path
   * (gitignore-style, matched relative to `cwd`). Returns newly activated
   * skills sorted by name.
   */
  activateSkillsForPaths(paths: readonly string[], cwd: string): readonly SkillDefinition[];
  /** Currently active `paths`-gated skills, sorted by name. */
  listActivatedConditionalSkills(): readonly SkillDefinition[];
  /**
   * Re-activate one pending conditional skill by name (resume healing: the
   * replayed history's activation announcements are the ledger).
   */
  activatePendingConditionalSkill(name: string): SkillDefinition | undefined;
}

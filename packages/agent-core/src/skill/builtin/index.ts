import type { SessionSkillRegistry } from '../registry';
import { CHECK_CLOUD_CODE_DOCS_SKILL } from './check-cloud-code-docs';
import { CUSTOM_THEME_SKILL } from './custom-theme';
import { IMPORT_FROM_CC_CODEX_SKILL } from './import-from-cc-codex';
import { LOOP_SKILL } from './loop';
import { MCP_CONFIG_SKILL } from './mcp-config';
import { PR_COMMENTS_SKILL } from './pr_comments';
import { REVIEW_SKILL } from './review';
import { SECURITY_REVIEW_SKILL } from './security-review';
import {
  SUB_SKILL_CONSOLIDATE,
  SUB_SKILL_PARENT,
  SUB_SKILL_REVIEW,
} from './sub-skill';
import { UPDATE_CONFIG_SKILL } from './update-config';
import { WRITE_GOAL_SKILL } from './write-goal';

export function registerBuiltinSkills(registry: SessionSkillRegistry): void {
  registry.registerBuiltinSkill(MCP_CONFIG_SKILL);
  registry.registerBuiltinSkill(IMPORT_FROM_CC_CODEX_SKILL);
  registry.registerBuiltinSkill(UPDATE_CONFIG_SKILL);
  registry.registerBuiltinSkill(CUSTOM_THEME_SKILL);
  registry.registerBuiltinSkill(WRITE_GOAL_SKILL);
  registry.registerBuiltinSkill(CHECK_CLOUD_CODE_DOCS_SKILL);
  registry.registerBuiltinSkill(LOOP_SKILL);
  registry.registerBuiltinSkill(REVIEW_SKILL);
  registry.registerBuiltinSkill(SECURITY_REVIEW_SKILL);
  registry.registerBuiltinSkill(PR_COMMENTS_SKILL);
  registry.registerBuiltinSkill(SUB_SKILL_PARENT);
  registry.registerBuiltinSkill(SUB_SKILL_REVIEW);
  registry.registerBuiltinSkill(SUB_SKILL_CONSOLIDATE);
}

export {
  CHECK_CLOUD_CODE_DOCS_SKILL,
  CUSTOM_THEME_SKILL,
  IMPORT_FROM_CC_CODEX_SKILL,
  LOOP_SKILL,
  MCP_CONFIG_SKILL,
  PR_COMMENTS_SKILL,
  REVIEW_SKILL,
  SECURITY_REVIEW_SKILL,
  SUB_SKILL_CONSOLIDATE,
  SUB_SKILL_PARENT,
  SUB_SKILL_REVIEW,
  UPDATE_CONFIG_SKILL,
  WRITE_GOAL_SKILL,
};

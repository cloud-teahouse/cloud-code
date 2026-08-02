import { describe, expect, it } from 'vitest';

import {
  PR_COMMENTS_SKILL,
  REVIEW_SKILL,
  SECURITY_REVIEW_SKILL,
  SessionSkillRegistry,
  isUserActivatableSkillType,
  registerBuiltinSkills,
  type SkillDefinition,
} from '../../src/skill';

const REVIEW_SKILLS: readonly SkillDefinition[] = [
  REVIEW_SKILL,
  SECURITY_REVIEW_SKILL,
  PR_COMMENTS_SKILL,
];

describe('builtin skills: review trio identity', () => {
  it('parses frontmatter into the expected name, description, and source', () => {
    expect(REVIEW_SKILL.name).toBe('review');
    expect(REVIEW_SKILL.source).toBe('builtin');
    expect(REVIEW_SKILL.description).toContain('Review code changes');

    expect(SECURITY_REVIEW_SKILL.name).toBe('security-review');
    expect(SECURITY_REVIEW_SKILL.source).toBe('builtin');
    expect(SECURITY_REVIEW_SKILL.description.toLowerCase()).toContain('security');

    expect(PR_COMMENTS_SKILL.name).toBe('pr_comments');
    expect(PR_COMMENTS_SKILL.source).toBe('builtin');
    expect(PR_COMMENTS_SKILL.description).toContain('pull request');
  });

  it('uses inline type and keeps model invocation enabled (Skill tool path)', () => {
    for (const skill of REVIEW_SKILLS) {
      expect(skill.metadata.type).toBe('inline');
      expect(skill.metadata.disableModelInvocation).not.toBe(true);
    }
  });

  it('exposes pseudo paths under builtin://', () => {
    expect(REVIEW_SKILL.path).toBe('builtin://review');
    expect(SECURITY_REVIEW_SKILL.path).toBe('builtin://security-review');
    expect(PR_COMMENTS_SKILL.path).toBe('builtin://pr_comments');
  });
});

describe('builtin skills: review trio registration', () => {
  it('registers all three through registerBuiltinSkills', () => {
    const registry = new SessionSkillRegistry();
    registerBuiltinSkills(registry);

    for (const skill of REVIEW_SKILLS) {
      expect(registry.getSkill(skill.name)).toBeDefined();
    }
  });

  it('lists all three as model-invocable skills (Skill tool activation)', () => {
    const registry = new SessionSkillRegistry();
    registerBuiltinSkills(registry);

    const invocable = registry.listInvocableSkills().map((skill) => skill.name);
    expect(invocable).toContain('review');
    expect(invocable).toContain('security-review');
    expect(invocable).toContain('pr_comments');
  });

  it('keeps all three user-activatable and visible for the slash listing', () => {
    const registry = new SessionSkillRegistry();
    registerBuiltinSkills(registry);

    // The TUI builds slash commands from listSkills(): a builtin source maps
    // the skill name to the plain `/review` command, and SkillManager.activate
    // gates on isUserActivatableSkillType. Assert both preconditions here.
    const listed = registry.listSkills();
    for (const skill of REVIEW_SKILLS) {
      const found = listed.find((entry) => entry.name === skill.name);
      expect(found).toBeDefined();
      expect(found?.source).toBe('builtin');
      expect(isUserActivatableSkillType(found?.metadata.type)).toBe(true);
    }
  });
});

describe('builtin skills: review trio prompt rendering', () => {
  it('substitutes $ARGUMENTS in the review prompt', () => {
    const registry = new SessionSkillRegistry();
    registerBuiltinSkills(registry);

    const skill = registry.getSkill('review');
    expect(skill).toBeDefined();
    const rendered = registry.renderSkillPrompt(skill!, '123');
    expect(rendered).toContain('123');
    expect(rendered).not.toContain('$ARGUMENTS');
  });

  it('renders pr_comments with empty arguments', () => {
    const registry = new SessionSkillRegistry();
    registerBuiltinSkills(registry);

    const skill = registry.getSkill('pr_comments');
    expect(skill).toBeDefined();
    const rendered = registry.renderSkillPrompt(skill!, '');
    expect(rendered).not.toContain('$ARGUMENTS');
    expect(rendered).toContain('gh pr view');
  });
});

describe('builtin skills: review trio content', () => {
  it('review covers local diff, PR, and range targets plus severity-sorted output', () => {
    const content = REVIEW_SKILL.content;
    expect(content).toContain('git diff HEAD');
    expect(content).toContain('gh pr diff');
    expect(content).toContain('git merge-base');
    expect(content).toContain('sorted by severity');
    expect(content).toContain('file.ts:42');
  });

  it('security-review covers the required vulnerability categories and exclusions', () => {
    const content = SECURITY_REVIEW_SKILL.content;
    expect(content).toContain('command injection');
    expect(content).toContain('XSS');
    expect(content).toContain('hardcoded API keys');
    expect(content).toContain('Insecure dependency usage');
    expect(content).toContain('Exploit scenario');
    expect(content).toContain('Recommendation');
    expect(content.toLowerCase()).toContain('denial of service');
  });

  it('pr_comments fetches via gh api and classifies every thread', () => {
    const content = PR_COMMENTS_SKILL.content;
    expect(content).toContain('/issues/{number}/comments');
    expect(content).toContain('/pulls/{number}/comments');
    expect(content).toContain('change');
    expect(content).toContain('question');
    expect(content).toContain('nitpick');
    expect(content).toContain('Actions taken');
  });
});

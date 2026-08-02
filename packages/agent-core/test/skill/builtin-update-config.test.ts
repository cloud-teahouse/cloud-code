import { describe, expect, it } from 'vitest';

import { CHECK_CLOUD_CODE_DOCS_SKILL, SessionSkillRegistry, UPDATE_CONFIG_SKILL, registerBuiltinSkills } from '../../src/skill';

describe('builtin skill: update-config', () => {
  it('has the expected identity and inline metadata', () => {
    expect(UPDATE_CONFIG_SKILL.name).toBe('update-config');
    expect(UPDATE_CONFIG_SKILL.source).toBe('builtin');
    expect(UPDATE_CONFIG_SKILL.description.length).toBeGreaterThan(0);
    expect(UPDATE_CONFIG_SKILL.metadata.type).toBe('inline');
  });

  it('is model-invocable (does not disable model invocation)', () => {
    expect(UPDATE_CONFIG_SKILL.metadata.disableModelInvocation).not.toBe(true);
  });

  it('pins the in-repo schema as the single source of truth and references TOML / cloudcode doctor / /reload', () => {
    const content = UPDATE_CONFIG_SKILL.content;
    expect(content).toContain('packages/agent-core/src/config/schema.ts');
    expect(content).toContain('cloudcode doctor');
    expect(content).toContain('/reload');
    expect(content.toLowerCase()).toContain('toml');
  });

  it('registers through registerBuiltinSkills and shows up as model-invocable', () => {
    const registry = new SessionSkillRegistry();
    registerBuiltinSkills(registry);

    expect(registry.getSkill('update-config')).toBeDefined();
    expect(
      registry.listInvocableSkills().some((skill) => skill.name === 'update-config'),
    ).toBe(true);
  });
});

describe('builtin skill: check-cloud-code-docs', () => {
  it('has the expected identity and inline metadata', () => {
    expect(CHECK_CLOUD_CODE_DOCS_SKILL.name).toBe('check-cloud-code-docs');
    expect(CHECK_CLOUD_CODE_DOCS_SKILL.source).toBe('builtin');
    expect(CHECK_CLOUD_CODE_DOCS_SKILL.description.length).toBeGreaterThan(0);
    expect(CHECK_CLOUD_CODE_DOCS_SKILL.metadata.type).toBe('inline');
  });

  it('is model-invocable (does not disable model invocation)', () => {
    expect(CHECK_CLOUD_CODE_DOCS_SKILL.metadata.disableModelInvocation).not.toBe(true);
  });

  it('routes to the repository documentation and in-repo schema files', () => {
    const content = CHECK_CLOUD_CODE_DOCS_SKILL.content;
    expect(content).toContain('AGENTS.md');
    expect(content).toContain('docs/plan.md');
    expect(content).toContain('packages/agent-core/src/config/schema.ts');
    expect(content).not.toContain('kimi.com');
    expect(content).not.toContain('moonshotai.github.io');
  });

  it('registers through registerBuiltinSkills and shows up as model-invocable', () => {
    const registry = new SessionSkillRegistry();
    registerBuiltinSkills(registry);

    expect(registry.getSkill('check-cloud-code-docs')).toBeDefined();
    expect(
      registry.listInvocableSkills().some((skill) => skill.name === 'check-cloud-code-docs'),
    ).toBe(true);
  });
});

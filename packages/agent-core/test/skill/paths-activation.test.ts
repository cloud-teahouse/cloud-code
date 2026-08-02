import { describe, expect, it, vi } from 'vitest';

import { parseSkillText } from '../../src/skill/parser';
import { SessionSkillRegistry } from '../../src/skill/registry';
import type { SkillDefinition, SkillMetadata } from '../../src/skill/types';

const CWD = '/repo';

function makeSkill(name: string, metadata: SkillMetadata = {}, content?: string): SkillDefinition {
  return {
    name,
    description: `desc for ${name}`,
    path: `/skills/${name}/SKILL.md`,
    dir: `/skills/${name}`,
    content: content ?? `body of ${name}`,
    metadata,
    source: 'project',
  };
}

function makeRegistry(
  skills: readonly SkillDefinition[],
  options: { readonly onWarning?: (message: string, cause?: unknown) => void } = {},
): SessionSkillRegistry {
  const registry = new SessionSkillRegistry(options);
  for (const skill of skills) {
    registry.register(skill);
  }
  return registry;
}

describe('skill frontmatter paths parsing', () => {
  it('parses a paths list into metadata', () => {
    const skill = parseSkillText({
      skillMdPath: '/skills/api/SKILL.md',
      skillDirName: 'api',
      source: 'project',
      text: '---\nname: api\ndescription: API work\npaths:\n  - "src/api/**"\n  - "*.test.ts"\n---\nbody',
    });
    expect(skill.metadata.paths).toEqual(['src/api/**', '*.test.ts']);
  });

  it('drops non-string entries and treats an emptied list as absent', () => {
    const skill = parseSkillText({
      skillMdPath: '/skills/api/SKILL.md',
      skillDirName: 'api',
      source: 'project',
      text: '---\nname: api\ndescription: API work\npaths:\n  - "src/api/**"\n  - 42\n  - ""\n---\nbody',
    });
    expect(skill.metadata.paths).toEqual(['src/api/**']);

    const empty = parseSkillText({
      skillMdPath: '/skills/api/SKILL.md',
      skillDirName: 'api',
      source: 'project',
      text: '---\nname: api\ndescription: API work\npaths: []\n---\nbody',
    });
    expect(empty.metadata.paths).toBeUndefined();
  });
});

describe('SessionSkillRegistry conditional (paths-gated) skills', () => {
  it('keeps a paths-gated skill out of every listing and lookup before activation', () => {
    const registry = makeRegistry([
      makeSkill('api', { paths: ['src/api/**'] }),
      makeSkill('plain'),
    ]);

    expect(registry.hasPendingConditionalSkills()).toBe(true);
    expect(registry.getSkill('api')).toBeUndefined();
    expect(registry.listSkills().map((skill) => skill.name)).toEqual(['plain']);
    expect(registry.listInvocableSkills().map((skill) => skill.name)).toEqual(['plain']);
    expect(registry.getModelSkillListing()).not.toContain('api');
  });

  it('activates on a matching relative path and keeps the listing byte-stable', () => {
    const registry = makeRegistry([makeSkill('api', { paths: ['src/api/**'] }), makeSkill('plain')]);
    const listingBefore = registry.getModelSkillListing();

    const activated = registry.activateSkillsForPaths(['src/api/routes.ts'], CWD);

    expect(activated.map((skill) => skill.name)).toEqual(['api']);
    expect(registry.getSkill('api')?.name).toBe('api');
    expect(registry.hasPendingConditionalSkills()).toBe(false);
    expect(registry.listActivatedConditionalSkills().map((skill) => skill.name)).toEqual(['api']);
    // Prefix invariant: activation never joins the system-prompt listing.
    expect(registry.getModelSkillListing()).toBe(listingBefore);
    expect(registry.listSkills().map((skill) => skill.name)).toEqual(['plain']);
  });

  it('matches absolute paths under cwd and ignores paths escaping it', () => {
    const registry = makeRegistry([makeSkill('api', { paths: ['src/api/**'] })]);

    expect(registry.activateSkillsForPaths(['/elsewhere/src/api/x.ts'], CWD)).toEqual([]);
    expect(registry.activateSkillsForPaths(['../outside/src/api/x.ts'], CWD)).toEqual([]);
    expect(registry.hasPendingConditionalSkills()).toBe(true);

    const activated = registry.activateSkillsForPaths(['/repo/src/api/x.ts'], CWD);
    expect(activated.map((skill) => skill.name)).toEqual(['api']);
  });

  it('matches basename patterns at any depth (gitignore semantics)', () => {
    const registry = makeRegistry([makeSkill('tests', { paths: ['*.test.ts'] })]);
    const activated = registry.activateSkillsForPaths(['src/deep/nested/foo.test.ts'], CWD);
    expect(activated.map((skill) => skill.name)).toEqual(['tests']);
  });

  it('does not match non-matching paths and activates only once', () => {
    const registry = makeRegistry([makeSkill('api', { paths: ['src/api/**'] })]);

    expect(registry.activateSkillsForPaths(['src/web/foo.ts'], CWD)).toEqual([]);
    expect(registry.hasPendingConditionalSkills()).toBe(true);

    expect(registry.activateSkillsForPaths(['src/api/a.ts'], CWD)).toHaveLength(1);
    expect(registry.activateSkillsForPaths(['src/api/b.ts'], CWD)).toEqual([]);
    expect(registry.listActivatedConditionalSkills()).toHaveLength(1);
  });

  it('activates several skills in one call, sorted by name', () => {
    const registry = makeRegistry([
      makeSkill('zeta', { paths: ['src/**'] }),
      makeSkill('alpha', { paths: ['src/**'] }),
    ]);
    const activated = registry.activateSkillsForPaths(['src/a.ts'], CWD);
    expect(activated.map((skill) => skill.name)).toEqual(['alpha', 'zeta']);
  });

  it('treats paths on a non-inline skill type as inert and warns', () => {
    const onWarning = vi.fn();
    const registry = makeRegistry([makeSkill('flowy', { type: 'flow', paths: ['src/**'] })], {
      onWarning,
    });

    expect(registry.hasPendingConditionalSkills()).toBe(false);
    expect(registry.getSkill('flowy')).toBeDefined();
    expect(onWarning).toHaveBeenCalledOnce();
  });

  it('activatePendingConditionalSkill re-activates by name (resume heal)', () => {
    const registry = makeRegistry([makeSkill('api', { paths: ['src/api/**'] })]);

    expect(registry.activatePendingConditionalSkill('nope')).toBeUndefined();
    const healed = registry.activatePendingConditionalSkill('API');
    expect(healed?.name).toBe('api');
    expect(registry.getSkill('api')).toBeDefined();
    expect(registry.activatePendingConditionalSkill('api')).toBeUndefined();
  });

  it('register() with replace swaps a pending conditional skill', () => {
    const registry = makeRegistry([makeSkill('api', { paths: ['src/api/**'] })]);
    registry.register(makeSkill('api', { paths: ['src/api/**'] }, 'v2 body'), { replace: true });
    const [activated] = registry.activateSkillsForPaths(['src/api/a.ts'], CWD);
    expect(activated?.content).toBe('v2 body');
  });
});

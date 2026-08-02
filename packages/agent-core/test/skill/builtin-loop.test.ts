/**
 * Tests for the builtin `loop` skill — the natural-language frontend
 * for the cron stack (parse interval → CronCreate → run once now).
 *
 * The skill is pure prompt content, so these assertions pin the parts
 * of the contract the model relies on: parsing rules, the interval→cron
 * table, CronCreate usage (`recurring: true`), the immediate first
 * execution, and the usage escape hatch.
 */
import { describe, expect, it } from 'vitest';

import {
  LOOP_SKILL,
  SessionSkillRegistry,
  isUserActivatableSkillType,
  registerBuiltinSkills,
} from '../../src/skill';

describe('builtin skill: loop identity', () => {
  it('parses frontmatter into the expected name, description, and source', () => {
    expect(LOOP_SKILL.name).toBe('loop');
    expect(LOOP_SKILL.source).toBe('builtin');
    expect(LOOP_SKILL.description).toContain('recurring interval');
    expect(LOOP_SKILL.description).toContain('10m');
  });

  it('uses inline type and keeps model invocation enabled (Skill tool path)', () => {
    expect(LOOP_SKILL.metadata.type).toBe('inline');
    expect(LOOP_SKILL.metadata.disableModelInvocation).not.toBe(true);
  });

  it('exposes a pseudo path under builtin://', () => {
    expect(LOOP_SKILL.path).toBe('builtin://loop');
  });
});

describe('builtin skill: loop registration', () => {
  it('registers through registerBuiltinSkills and is model-invocable', () => {
    const registry = new SessionSkillRegistry();
    registerBuiltinSkills(registry);

    expect(registry.getSkill('loop')).toBeDefined();
    expect(registry.listInvocableSkills().map((s) => s.name)).toContain('loop');
  });

  it('stays user-activatable for the /loop slash listing', () => {
    const registry = new SessionSkillRegistry();
    registerBuiltinSkills(registry);

    const found = registry.listSkills().find((s) => s.name === 'loop');
    expect(found).toBeDefined();
    expect(found?.source).toBe('builtin');
    expect(isUserActivatableSkillType(found?.metadata.type)).toBe(true);
  });

  it('substitutes $ARGUMENTS with the raw input', () => {
    const registry = new SessionSkillRegistry();
    registerBuiltinSkills(registry);

    const skill = registry.getSkill('loop');
    expect(skill).toBeDefined();
    const rendered = registry.renderSkillPrompt(skill!, '5m /review');
    expect(rendered).toContain('5m /review');
    expect(rendered).not.toContain('$ARGUMENTS');
  });
});

describe('builtin skill: loop content', () => {
  it('teaches the parsing priority: leading token, trailing every-clause, 10m default', () => {
    const content = LOOP_SKILL.content;
    expect(content).toContain('^\\d+[smhd]$');
    expect(content).toContain('Trailing "every" clause');
    expect(content).toContain('`10m` and the entire input is the prompt');
    // The disambiguation example: "every" not followed by a time is not an interval.
    expect(content).toContain('check every PR');
  });

  it('teaches the interval-to-cron conversion with 1-minute granularity', () => {
    const content = LOOP_SKILL.content;
    expect(content).toContain('`*/N * * * *`');
    expect(content).toContain('<minute> */N * * *');
    expect(content).toContain('ceil(N/60)m');
    expect(content).toContain('Minimum granularity is 1 minute');
    // Non-dividing intervals must be rounded and disclosed.
    expect(content).toContain('nearest clean interval');
  });

  it('teaches herd-avoidance minute selection per the cron stack jitter rules', () => {
    expect(LOOP_SKILL.content).toContain('NOT 0 or 30');
  });

  it('schedules through CronCreate with recurring: true', () => {
    const content = LOOP_SKILL.content;
    expect(content).toContain('CronCreate');
    expect(content).toContain('`recurring`: `true`');
    // Durable is mentioned but must default off.
    expect(content).toContain('`durable`');
    expect(content).toContain('.cloud-code/scheduled_tasks.json');
  });

  it('documents the 7-day auto-expire and CronDelete cancellation', () => {
    const content = LOOP_SKILL.content;
    expect(content).toContain('auto-expire after 7 days');
    expect(content).toContain('CronDelete');
  });

  it('demands immediate first execution instead of waiting for the first fire', () => {
    const content = LOOP_SKILL.content;
    expect(content).toContain('immediately execute the parsed prompt now');
    expect(content).toContain('Skill tool');
  });

  it('shows usage and stops when the input is empty', () => {
    const content = LOOP_SKILL.content;
    expect(content).toContain('Usage: /loop [interval] <prompt>');
    expect(content).toContain('show this usage and stop');
  });
});

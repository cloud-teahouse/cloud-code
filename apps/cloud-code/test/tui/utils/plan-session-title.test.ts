import { describe, expect, it } from 'vitest';

import { planSessionTitleFromPlan } from '#/tui/utils/plan-session-title';

describe('planSessionTitleFromPlan', () => {
  it('prefers the first markdown heading', () => {
    expect(
      planSessionTitleFromPlan('# Refactor auth flow\n\n1. Inspect\n2. Change\n\n## Details\n'),
    ).toBe('Refactor auth flow');
  });

  it('falls back to the first non-empty line when there is no heading', () => {
    expect(planSessionTitleFromPlan('\n\nFix the login redirect bug\n- step one\n')).toBe(
      'Fix the login redirect bug',
    );
  });

  it('strips markdown punctuation and collapses whitespace', () => {
    expect(planSessionTitleFromPlan('# Add `retry` to **fetch** wrapper   [core]')).toBe(
      'Add retry to fetch wrapper core',
    );
  });

  it('truncates long titles with an ellipsis', () => {
    const long = `# ${'a'.repeat(100)}`;
    const title = planSessionTitleFromPlan(long);
    expect(title).toBeDefined();
    expect(title!.endsWith('…')).toBe(true);
    expect(title!.length).toBe(60);
  });

  it('returns undefined for empty or punctuation-only plans', () => {
    expect(planSessionTitleFromPlan('')).toBeUndefined();
    expect(planSessionTitleFromPlan('\n  \n')).toBeUndefined();
    expect(planSessionTitleFromPlan('***\n')).toBeUndefined();
  });
});

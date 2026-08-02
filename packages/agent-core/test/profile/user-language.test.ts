import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_AGENT_PROFILES } from '../../src/profile';
import {
  getUserLanguage,
  onUserLanguageChange,
  setUserLanguage,
} from '../../src/profile/user-language';

const promptContext = {
  osEnv: {
    osKind: 'macOS',
    osArch: 'arm64',
    osVersion: '0',
    shellName: 'bash',
    shellPath: '/bin/bash',
  },
  cwd: '/workspace',
  now: '2026-05-09T00:00:00.000Z',
} as const;

afterEach(() => {
  setUserLanguage(undefined);
});

describe('system prompt # Language section', () => {
  it('renders exactly the historical section when no language is set', () => {
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';

    expect(prompt).toContain('# Language');
    expect(prompt).not.toContain('explicitly set their UI language');
  });

  it('injects the explicit language sentence when userLanguage is set', () => {
    const prompt =
      DEFAULT_AGENT_PROFILES['agent']?.systemPrompt({ ...promptContext, userLanguage: '简体中文' }) ??
      '';

    expect(prompt).toContain(
      'The user has explicitly set their UI language to: 简体中文. Prefer it over inferring from message language.',
    );
  });

  it('re-renders byte-identically for an unchanged context (cache discipline)', () => {
    const render = () =>
      DEFAULT_AGENT_PROFILES['agent']?.systemPrompt({ ...promptContext, userLanguage: 'English' }) ??
      '';

    expect(render()).toBe(render());
  });
});

describe('user language bridge', () => {
  it('holds the current value and normalizes blanks to unset', () => {
    expect(getUserLanguage()).toBeUndefined();
    setUserLanguage('简体中文');
    expect(getUserLanguage()).toBe('简体中文');
    setUserLanguage('   ');
    expect(getUserLanguage()).toBeUndefined();
  });

  it('notifies listeners only on effective changes', () => {
    const listener = vi.fn();
    const unsubscribe = onUserLanguageChange(listener);

    setUserLanguage('English');
    setUserLanguage('English');
    setUserLanguage(undefined);
    expect(listener.mock.calls).toEqual([['English'], [undefined]]);

    unsubscribe();
    setUserLanguage('简体中文');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

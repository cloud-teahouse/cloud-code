import { visibleWidth } from '@cloud-code/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  detectSystemLocale,
  getActiveLocale,
  getLocalePreference,
  padEndVisible,
  resolveDescription,
  resolveLocale,
  setLocalePreference,
  t,
  tIfKnown,
  userLanguageNameForModel,
} from '#/tui/i18n';
import { enMessages, type MessageKey } from '../../../src/tui/i18n/locales/en/index';
import { zhCnMessages } from '../../../src/tui/i18n/locales/zh-CN/index';

afterEach(() => {
  setLocalePreference('en');
  vi.unstubAllEnvs();
});

describe('t()', () => {
  it('resolves English messages by default', () => {
    expect(t('welcome.title')).toBe('Welcome to Cloud Code CLI!');
  });

  it('resolves zh-CN messages after switching locale', () => {
    setLocalePreference('zh-CN');
    expect(t('welcome.title')).toBe('欢迎使用 Cloud Code CLI！');
    expect(getActiveLocale()).toBe('zh-CN');
    expect(getLocalePreference()).toBe('zh-CN');
  });

  it('interpolates {vars}', () => {
    expect(t('commands.language.set', { name: 'English' })).toBe('Language set to English.');
  });

  it('keeps placeholders for vars that were not provided', () => {
    expect(t('commands.language.set')).toBe('Language set to {name}.');
  });

  it('returns the key itself when even English has no entry', () => {
    expect(t('no.such.key' as MessageKey)).toBe('no.such.key');
  });

  it('resolves the T2 interrupt-recall status message in both locales', () => {
    expect(t('controllers.editor.cancelledInputRecalled')).toBe(
      'Cancelled — your input was restored to the editor for re-editing.',
    );
    setLocalePreference('zh-CN');
    expect(t('controllers.editor.cancelledInputRecalled')).toBe('已取消，原文已回填可编辑。');
  });

  it('resolves the editor placeholder in both locales', () => {
    expect(t('editor.placeholder')).toBe('Type a message (? for shortcuts)');
    setLocalePreference('zh-CN');
    expect(t('editor.placeholder')).toBe('输入消息（? 查看快捷键）');
  });
});

describe('zh-CN dictionary completeness', () => {
  it('has a non-empty translation for every English key', () => {
    const keys = Object.keys(enMessages) as MessageKey[];
    expect(keys.length).toBeGreaterThan(200);
    for (const key of keys) {
      const value = zhCnMessages[key];
      expect(typeof value, key).toBe('string');
      expect(value.length, key).toBeGreaterThan(0);
    }
  });

  it('keeps the same {var} placeholders in both locales', () => {
    const placeholder = /\{(\w+)\}/g;
    for (const key of Object.keys(enMessages) as MessageKey[]) {
      const enVars = [...enMessages[key].matchAll(placeholder)].map((m) => m[1]).sort();
      const zhVars = [...zhCnMessages[key].matchAll(placeholder)].map((m) => m[1]).sort();
      expect(zhVars, key).toEqual(enVars);
    }
  });
});

describe('detectSystemLocale / resolveLocale', () => {
  it('maps zh locales to zh-CN', () => {
    vi.stubEnv('LC_ALL', '');
    vi.stubEnv('LC_MESSAGES', '');
    vi.stubEnv('LANG', 'zh_CN.UTF-8');
    expect(detectSystemLocale()).toBe('zh-CN');
    vi.stubEnv('LANG', 'zh_TW.UTF-8');
    expect(detectSystemLocale()).toBe('zh-CN');
  });

  it('prefers LC_ALL over LC_MESSAGES over LANG', () => {
    vi.stubEnv('LC_ALL', 'en_US.UTF-8');
    vi.stubEnv('LC_MESSAGES', 'zh_CN.UTF-8');
    vi.stubEnv('LANG', 'zh_CN.UTF-8');
    expect(detectSystemLocale()).toBe('en');
    vi.stubEnv('LC_ALL', '');
    expect(detectSystemLocale()).toBe('zh-CN');
    vi.stubEnv('LC_MESSAGES', '');
    expect(detectSystemLocale()).toBe('zh-CN');
  });

  it('falls back to en when nothing is set', () => {
    vi.stubEnv('LC_ALL', '');
    vi.stubEnv('LC_MESSAGES', '');
    vi.stubEnv('LANG', '');
    expect(detectSystemLocale()).toBe('en');
  });

  it('resolveLocale passes concrete locales through and resolves auto', () => {
    expect(resolveLocale('en')).toBe('en');
    expect(resolveLocale('zh-CN')).toBe('zh-CN');
    vi.stubEnv('LC_ALL', 'zh_CN.UTF-8');
    expect(resolveLocale('auto')).toBe('zh-CN');
  });

  it("setLocalePreference('auto') follows the system locale", () => {
    vi.stubEnv('LC_ALL', 'zh_CN.UTF-8');
    setLocalePreference('auto');
    expect(getActiveLocale()).toBe('zh-CN');
    expect(getLocalePreference()).toBe('auto');
  });
});

describe('resolveDescription', () => {
  it('resolves i18n keys and passes plain text through', () => {
    expect(resolveDescription('commands.help.description')).toBe(
      'Show available commands and shortcuts',
    );
    expect(resolveDescription('A plugin-provided description')).toBe(
      'A plugin-provided description',
    );
    setLocalePreference('zh-CN');
    expect(resolveDescription('commands.help.description')).toBe('显示可用命令与快捷键');
    expect(resolveDescription('A plugin-provided description')).toBe(
      'A plugin-provided description',
    );
  });
});

describe('tIfKnown', () => {
  it('resolves wire keys with params in the active locale', () => {
    expect(tIfKnown('toolResult.cron.deleted', { id: 'abc12345' })).toBe(
      'Deleted cron job abc12345.',
    );
    setLocalePreference('zh-CN');
    expect(tIfKnown('toolResult.cron.deleted', { id: 'abc12345' })).toBe(
      '已删除定时任务 abc12345。',
    );
  });

  it('returns undefined for unknown keys instead of rendering the key', () => {
    // A newer agent-core on an older TUI: the caller falls back to raw output.
    expect(tIfKnown('toolResult.futureTool.something', { id: 1 })).toBeUndefined();
  });
});

describe('padEndVisible', () => {
  it('pads by display columns for CJK text', () => {
    const padded = padEndVisible('目录:', 11);
    expect(visibleWidth(padded)).toBe(11);
    expect(padded).toBe('目录:' + ' '.repeat(6));
  });

  it('matches padEnd for pure ASCII', () => {
    expect(padEndVisible('Directory:', 11)).toBe('Directory: ');
  });

  it('handles mixed CJK/ASCII and ANSI escapes', () => {
    expect(visibleWidth(padEndVisible('模型: abc', 14))).toBe(14);
    const ansi = '[38;2;1;2;3m目录:[39m';
    expect(visibleWidth(padEndVisible(ansi, 11))).toBe(11);
  });

  it('returns text unchanged when already at or beyond the width', () => {
    expect(padEndVisible('超过六个字符的文本', 6)).toBe('超过六个字符的文本');
  });
});

describe('userLanguageNameForModel', () => {
  it('maps preferences to model-facing names; auto stays unset', () => {
    expect(userLanguageNameForModel('zh-CN')).toBe('简体中文');
    expect(userLanguageNameForModel('en')).toBe('English');
    expect(userLanguageNameForModel('auto')).toBeUndefined();
  });
});

import { visibleWidth } from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import { setRainbowDance, type RainbowDanceController } from '#/tui/easter-eggs/dance';
import { setLocalePreference } from '#/tui/i18n';
import { darkColors } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';

const TRUECOLOR_PATTERN = /\u001B\[38;2;(\d+);(\d+);(\d+)m/g;

const appState: AppState = {
  version: '1.2.3',
  workDir: '/tmp/project',
  additionalDirs: [],
  sessionId: 'ses-1',
  sessionTitle: null,
  model: 'kimi-k2',
  permissionMode: 'manual',
  thinkingEffort: 'off',
  contextUsage: 0,
  contextTokens: 0,
  maxContextTokens: 0,
  isCompacting: false,
  isReplaying: false,
  streamingPhase: 'idle',
  streamingStartTime: 0,
  planMode: false,
  inputMode: 'prompt',
  swarmMode: false,
  coordinatorMode: false,
  theme: 'dark',
  language: 'auto',
  editorCommand: null,
  notifications: { enabled: true, condition: 'unfocused' },
  upgrade: { autoInstall: true },
  availableModels: {},
  availableProviders: {},
  mcpServersSummary: null,
};

function truecolorCodes(text: string): Set<string> {
  const codes = new Set<string>();
  for (const match of text.matchAll(TRUECOLOR_PATTERN)) {
    codes.add(`${match[1]},${match[2]},${match[3]}`);
  }
  return codes;
}

/** The two header rows (logo + title) of the rendered welcome box. */
function headerOf(lines: string[]): string {
  return [lines[3], lines[4]].join('\n');
}

function setDanceView(colored: boolean, phase: number): void {
  const dance: RainbowDanceController = {
    colored,
    phase,
    start: () => {},
    stop: () => {},
    dispose: () => {},
  };
  setRainbowDance(dance);
}

describe('WelcomeComponent', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
    setRainbowDance(undefined);
  });

  it('renders the banner in the brand color with a border-token frame by default', () => {
    const codes = truecolorCodes(headerOf(new WelcomeComponent(appState).render(80)));

    // No rainbow by default — just the brand primary (logo + title), the dim
    // tagline, and the border-token box frame.
    expect(codes.size).toBeLessThanOrEqual(3);
  });

  it('paints the banner in rainbow while colored', () => {
    setDanceView(true, 0);
    const codes = truecolorCodes(headerOf(new WelcomeComponent(appState).render(80)));

    expect(codes.size).toBeGreaterThanOrEqual(5);
  });

  it('renders exactly the default banner when not colored', () => {
    const base = headerOf(new WelcomeComponent(appState).render(80));
    setDanceView(false, 5);
    const off = headerOf(new WelcomeComponent(appState).render(80));

    expect(off).toBe(base);
  });

  it('keeps every line within the requested width on narrow terminals', () => {
    for (const width of [0, 1, 2, 4, 10, 39, 80]) {
      for (const line of new WelcomeComponent(appState).render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

const ANSI_ESCAPE = new RegExp('\\u001B\\[[0-9;]*m', 'g');

function plain(lines: string[]): string {
  return lines.map((line) => line.replace(ANSI_ESCAPE, '')).join('\n');
}

describe('WelcomeComponent channel note', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
    setLocalePreference('en');
  });

  it('shows the dim dev note under the box on dev builds', () => {
    setLocalePreference('zh-CN');
    const rendered = new WelcomeComponent(appState, 'dev').render(80);
    const text = plain(rendered);
    expect(text).toContain('dev 构建（内部开发版）');
    expect(text).toContain('本渠道不支持 /update');
    // The note sits outside (after) the box's bottom border.
    expect(text.indexOf('dev 构建（内部开发版）')).toBeGreaterThan(text.lastIndexOf('╰'));
  });

  it('shows the beta note under the box on beta builds', () => {
    setLocalePreference('zh-CN');
    const text = plain(new WelcomeComponent(appState, 'beta').render(80));
    expect(text).toContain('beta 构建（main 滚动预发布）');
    expect(text).toContain('github.com/cloud-teahouse/cloud-code/issues');
  });

  it('shows the note in English when the locale is en', () => {
    expect(plain(new WelcomeComponent(appState, 'dev').render(80))).toContain(
      'dev build (internal development)',
    );
    expect(plain(new WelcomeComponent(appState, 'beta').render(80))).toContain(
      'beta build (rolling pre-release from main)',
    );
  });

  it('shows no note on release builds', () => {
    const text = plain(new WelcomeComponent(appState, 'release').render(80));
    expect(text).not.toContain('unstable');
    expect(text).not.toContain('不稳定');
  });

  it('keeps every line within the requested width when the note is present', () => {
    for (const width of [0, 1, 2, 4, 10, 39, 80]) {
      for (const line of new WelcomeComponent(appState, 'dev').render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { setRainbowDance, type RainbowDanceController } from '#/tui/easter-eggs/dance';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';
import type { ModelAlias } from '@cloud-code/sdk';
import type { AppState } from '#/tui/types';

const TRUECOLOR_PATTERN = /\[38;2;(\d+);(\d+);(\d+)m/g;

function truecolorCodes(text: string): Set<string> {
  const codes = new Set<string>();
  for (const match of text.matchAll(TRUECOLOR_PATTERN)) {
    codes.add(`${match[1]},${match[2]},${match[3]}`);
  }
  return codes;
}

// Dark dance colors the footer never uses outside of /dance.
const RAINBOW_CYAN = '91,192,190';
const RAINBOW_GREEN = '78,200,126';

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
  availableModels: {
    'kimi-k2': {
      provider: 'managed:chatgpt-codex',
      model: 'kimi-k2',
      maxContextSize: 272000,
      serviceTiers: ['priority'],
    },
  },
  availableProviders: {
    'managed:chatgpt-codex': { type: 'openai_responses', baseUrl: 'https://chatgpt.com/backend-api/codex' },
  },
  mcpServersSummary: null,
};

describe('FooterComponent', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
    setRainbowDance(undefined);
  });

  it('paints the model name in rainbow while colored', () => {
    setDanceView(true, 0);
    const footer = new FooterComponent(appState);

    const codes = truecolorCodes(footer.render(120).join('\n'));

    // "kimi-k2" spreads across the palette, pulling in colors the footer
    // never renders on its own.
    expect(codes.has(RAINBOW_CYAN)).toBe(true);
    expect(codes.has(RAINBOW_GREEN)).toBe(true);
  });

  it('renders the model name in its normal color when not dancing', () => {
    const footer = new FooterComponent(appState);

    const codes = truecolorCodes(footer.render(120).join('\n'));

    expect(codes.has(RAINBOW_CYAN)).toBe(false);
    expect(codes.has(RAINBOW_GREEN)).toBe(false);
  });

  it('repaints from the active palette on the next render (no setColors needed)', () => {
    const footer = new FooterComponent(appState);
    const before = footer.render(120).join('\n');

    currentTheme.setPalette(lightColors);
    try {
      const after = footer.render(120).join('\n');
      // Reads currentTheme live, so a palette swap changes the emitted colours.
      expect(after).not.toBe(before);
    } finally {
      currentTheme.setPalette(darkColors);
    }
  });

  it('shows the effort for an effort-capable model', () => {
    const effortModel: ModelAlias = {
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      maxContextSize: 262144,
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: 'max',
      availableModels: { 'kimi-k2': effortModel },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join('\n')).toContain('thinking: max');
  });

  it('does not show the effort for a legacy boolean model', () => {
    const plainModel: ModelAlias = {
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      maxContextSize: 262144,
      capabilities: ['thinking'],
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: 'high',
      availableModels: { 'kimi-k2': plainModel },
    };
    const footer = new FooterComponent(state);
    const rendered = footer.render(120).join('\n');

    expect(rendered).toContain('thinking');
    expect(rendered).not.toContain('thinking:high');
  });
});

describe('FooterComponent overrides', () => {
  it('shows the overridden effort list', () => {
    const effortModelWithOverride: ModelAlias = {
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      maxContextSize: 262144,
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
      overrides: { supportEfforts: ['low', 'high'], defaultEffort: 'high' },
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: 'high',
      availableModels: { 'kimi-k2': effortModelWithOverride },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join('\n')).toContain('thinking: high');
  });
});

describe('FooterComponent displayName override', () => {
  it('renders the overridden display name', () => {
    const state: AppState = {
      ...appState,
      model: 'kimi-k2',
      availableModels: {
        'kimi-k2': {
          provider: 'managed:kimi-code',
          model: 'kimi-k2',
          maxContextSize: 262144,
          displayName: 'Remote Name',
          overrides: { displayName: 'Custom Name' },
        },
      },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join('\n')).toContain('Custom Name');
    expect(footer.render(120).join('\n')).not.toContain('Remote Name');
  });
});

describe('FooterComponent fast marker', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
  });

  const fastMarker = (): string => chalk.hex(currentTheme.palette.fastTier)('fast');

  it('appends a magenta fast marker after the model while the fast tier is on', () => {
    const state: AppState = { ...appState, serviceTier: 'priority' };
    const footer = new FooterComponent(state);

    const line1 = footer.render(120)[0] ?? '';
    const marker = fastMarker();

    expect(line1).toContain(marker);
    expect(line1.indexOf('kimi-k2')).toBeGreaterThanOrEqual(0);
    expect(line1.indexOf(marker)).toBeGreaterThan(line1.indexOf('kimi-k2'));
  });

  it('renders no fast marker while the fast tier is off', () => {
    const footer = new FooterComponent({ ...appState, serviceTier: null });

    const line1 = footer.render(120)[0] ?? '';

    expect(line1).not.toContain(fastMarker());
  });

  it('renders no fast marker when the model catalog does not declare the priority tier', () => {
    const state: AppState = {
      ...appState,
      serviceTier: 'priority',
      availableModels: {
        'kimi-k2': { provider: 'managed:chatgpt-codex', model: 'kimi-k2', maxContextSize: 272000 },
      },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120)[0] ?? '').not.toContain(fastMarker());
  });

  it('renders no fast marker on third-party openai_responses endpoints even with a declared tier', () => {
    const state: AppState = {
      ...appState,
      serviceTier: 'priority',
      availableProviders: {
        gateway: { type: 'openai_responses', baseUrl: 'https://openai-proxy.example.com/v1' },
      },
      availableModels: {
        'kimi-k2': {
          provider: 'gateway',
          model: 'kimi-k2',
          maxContextSize: 272000,
          serviceTiers: ['priority'],
        },
      },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120)[0] ?? '').not.toContain(fastMarker());
  });

  it('renders the fast marker on a third-party endpoint the provider declared fast-capable', () => {
    const state: AppState = {
      ...appState,
      serviceTier: 'priority',
      availableProviders: {
        gateway: {
          type: 'openai_responses',
          baseUrl: 'https://openai-proxy.example.com/v1',
          serviceTiers: ['priority'],
        },
      },
      availableModels: {
        'kimi-k2': { provider: 'gateway', model: 'kimi-k2', maxContextSize: 272000 },
      },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120)[0] ?? '').toContain(fastMarker());
  });

  it('re-renders when the service tier changes', () => {
    const footer = new FooterComponent(appState);
    const first = footer.render(120);

    footer.setState({ ...appState, serviceTier: 'priority' });
    const second = footer.render(120);

    expect(second).not.toBe(first);
    expect(second[0]).toContain(fastMarker());
  });

  it('always renders the token breakdown and first-token latency, with 0 placeholders before data', () => {
    const footer = new FooterComponent(appState);
    const initial = footer.render(120)[1] ?? '';
    // All context-area segments render from the start, zeroed.
    expect(initial).toContain('in 0');
    expect(initial).toContain('out 0');
    expect(initial).toContain('cache 0');
    expect(initial).toContain('first token 0s');

    footer.setState({ ...appState, recentFirstTokenLatencies: [7000, 9000] });
    expect(footer.render(120)[1] ?? '').toContain('first token 8.0s');

    footer.setState({ ...appState, recentFirstTokenLatencies: [70_000, 90_000] });
    expect(footer.render(120)[1] ?? '').toContain('first token 1m20s');
  });
});

describe('FooterComponent render signature cache', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
  });

  it('returns the same line array while no render input changed', () => {
    const footer = new FooterComponent(appState);

    const first = footer.render(120);
    const second = footer.render(120);

    expect(second).toBe(first);
  });

  it('recomputes when a rendered state field changes', () => {
    const footer = new FooterComponent(appState);
    const first = footer.render(120);

    footer.setState({ ...appState, planMode: true });
    const second = footer.render(120);

    expect(second).not.toBe(first);
    expect(second[0]).toContain('plan');
    // Third render with the same inputs hits the cache again.
    expect(footer.render(120)).toBe(second);
  });

  it('recomputes when the width changes', () => {
    const footer = new FooterComponent(appState);
    const first = footer.render(120);

    const narrower = footer.render(80);

    expect(narrower).not.toBe(first);
  });

  it('recomputes when the transient hint changes', () => {
    const footer = new FooterComponent(appState);
    const first = footer.render(120);

    footer.setTransientHint('Press Ctrl+C again to exit');
    const hinted = footer.render(120);

    expect(hinted).not.toBe(first);
    expect(hinted[1]).toContain('Press Ctrl+C again to exit');

    footer.setTransientHint(null);
    expect(footer.render(120)).not.toBe(hinted);
  });

  it('does not serve stale lines across a palette swap', () => {
    const footer = new FooterComponent(appState);
    const first = footer.render(120).join('\n');

    currentTheme.setPalette(lightColors);
    try {
      const second = footer.render(120).join('\n');
      expect(second).not.toBe(first);
    } finally {
      currentTheme.setPalette(darkColors);
    }
  });
});

describe('FooterComponent mode badges', () => {
  it('shows the coordinator badge only in Coordinator Mode', () => {
    const off = new FooterComponent(appState);
    expect(off.render(120).join('\n')).not.toContain('coordinator');

    const on = new FooterComponent({ ...appState, coordinatorMode: true });
    expect(on.render(120).join('\n')).toContain('coordinator');
  });
});

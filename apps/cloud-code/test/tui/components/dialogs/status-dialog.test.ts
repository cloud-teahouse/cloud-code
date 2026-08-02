import chalk from 'chalk';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hitZoneAt } from '@cloud-code/pi-tui';
import type { ConsumeCodexResetCreditResult } from '@cloud-code/oauth';

import { StatusDialogComponent, type StatusDialogOptions } from '#/tui/components/dialogs/status-dialog';
import type { TokenActivityBucket } from '#/tui/components/messages/token-activity-chart';
import { setLocalePreference } from '#/tui/i18n';
import { currentTheme, darkColors } from '#/tui/theme';

const ESC = String.fromCodePoint(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replaceAll(SGR, '');
const TAB = '\t';

/** Local YYYY-MM-DD for a day offset from today (buckets use local days). */
function dayKey(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const BUCKETS: TokenActivityBucket[] = [
  { date: dayKey(-1), tokens: 2000 },
  { date: dayKey(0), tokens: 3000 },
];

const AVAILABLE_MODELS = {
  k2: {
    provider: 'managed:kimi-code',
    model: 'kimi-k2',
    maxContextSize: 10000,
    displayName: 'Kimi K2',
  },
  'gpt-5-codex': {
    provider: 'managed:chatgpt-codex',
    model: 'gpt-5-codex',
    maxContextSize: 272000,
    displayName: 'GPT-5 Codex',
  },
};

function make(overrides: Partial<StatusDialogOptions> = {}): {
  component: StatusDialogComponent;
  onCancel: ReturnType<typeof vi.fn>;
} {
  const onCancel = vi.fn();
  const component = new StatusDialogComponent({
    status: {
      version: '1.2.3',
      model: 'k2',
      workDir: '/tmp/project',
      sessionId: 'ses-1',
      sessionTitle: 'My session',
      availableModels: AVAILABLE_MODELS,
      permissionMode: 'manual',
      contextUsage: 0.25,
      contextTokens: 2500,
      maxContextTokens: 10000,
      mcpServers: [{ name: 'web', transport: 'http', status: 'connected', toolCount: 2 }],
    },
    kimi: {
      account: { state: 'not-logged-in' },
      availableModels: AVAILABLE_MODELS,
      sessionUsage: { byModel: {} },
    },
    chatgpt: {
      account: { state: 'logged-in', email: 'user@example.com', planType: 'plus' },
      availableModels: AVAILABLE_MODELS,
      sessionUsage: {
        byModel: {
          'gpt-5-codex': { inputOther: 1000, inputCacheRead: 0, inputCacheCreation: 0, output: 100 },
        },
      },
      rateLimit: null,
    },
    stats: {
      buckets: BUCKETS,
      stats: {
        totalTokens: 5000,
        activeDays: 2,
        mostActiveDay: { date: dayKey(-1), tokens: 2000 },
        favoriteModel: { model: 'kimi-k2', tokens: 4000 },
        sessionCount: 3,
        longestSessionMs: 3_660_000,
      },
    },
    onCancel,
    ...overrides,
  });
  component.focused = true;
  return { component, onCancel };
}

function output(component: StatusDialogComponent, width = 120): string {
  return strip(component.render(width).join('\n'));
}

describe('StatusDialogComponent', () => {
  let previousLevel: typeof chalk.level;
  beforeAll(() => {
    previousLevel = chalk.level;
    chalk.level = 3;
    currentTheme.setPalette(darkColors);
  });
  afterAll(() => {
    chalk.level = previousLevel;
  });
  afterEach(() => {
    setLocalePreference('en');
  });

  it('renders the Status tab by default with the tab strip and global facts', () => {
    const out = output(make().component);
    expect(out).toContain('Status');
    expect(out).toContain('Kimi Code');
    expect(out).toContain('ChatGPT');
    expect(out).toContain('Stats');
    expect(out).toContain('Tab: switch tab · Esc: close');
    expect(out).toContain('>_ Cloud Code CLI (v1.2.3)');
    expect(out).toContain('1 connected');
    // The context window bar moved here from the old Usage tab.
    expect(out).toContain('Context window');
    // Account facts live on the account tabs now, not on Status.
    expect(out).not.toContain('user@example.com');
  });

  it('opens on the Kimi Code account tab when initialTab=kimi (the /usage alias path)', () => {
    const out = output(make({ initialTab: 'kimi' }).component);
    expect(out).toContain('Not logged in — run /login to see Kimi plan usage.');
  });

  it('opens on the ChatGPT account tab when initialTab=chatgpt', () => {
    const out = output(make({ initialTab: 'chatgpt' }).component);
    expect(out).toContain('user@example.com (Plus)');
    expect(out).toContain('Session usage');
    expect(out).toContain('gpt-5-codex');
    // The token-activity heatmap lives on the Stats tab only.
    expect(out).not.toContain('Less');
  });

  it('cycles tabs with Tab and wraps around', () => {
    const { component } = make();
    expect(output(component)).toContain('>_ Cloud Code CLI (v1.2.3)');

    component.handleInput(TAB);
    expect(output(component)).toContain('Not logged in — run /login to see Kimi plan usage.');

    component.handleInput(TAB);
    expect(output(component)).toContain('user@example.com (Plus)');

    component.handleInput(TAB);
    const stats = output(component);
    expect(stats).toContain('Favorite model');
    expect(stats).toContain('kimi-k2');
    expect(stats).toContain('Total tokens');
    expect(stats).toContain('5K');
    expect(stats).toContain('Sessions');
    expect(stats).toContain('Longest session');
    expect(stats).toContain('1h 1m');
    expect(stats).toContain('Active days');
    expect(stats).toContain('Most active day');

    component.handleInput(TAB);
    expect(output(component)).toContain('>_ Cloud Code CLI (v1.2.3)');
  });

  it('switches the stats range with d/w/c and cycles with r', () => {
    const { component } = make({ initialTab: 'stats' });
    // Default daily view: the Less/More legend is present, bar captions are not.
    expect(output(component)).toContain('Less');
    expect(output(component)).toContain('daily · weekly · cumulative');

    component.handleInput('w');
    expect(output(component)).toContain('Each column = 1 week');

    component.handleInput('c');
    expect(output(component)).toContain('Running total · top');

    component.handleInput('d');
    expect(output(component)).toContain('Less');

    component.handleInput('r'); // daily → weekly
    expect(output(component)).toContain('Each column = 1 week');
    component.handleInput('r'); // weekly → cumulative
    expect(output(component)).toContain('Running total · top');
    component.handleInput('r'); // cumulative → daily
    expect(output(component)).toContain('Less');
  });

  it('shows the stats range hint on the Stats tab only', () => {
    const { component } = make();
    expect(output(component)).not.toContain('d/w/c');
    component.handleInput(TAB);
    component.handleInput(TAB);
    component.handleInput(TAB);
    expect(output(component)).toContain('d/w/c or click: range');
  });

  it('renders the stats empty state when there is no activity', () => {
    const { component } = make({
      initialTab: 'stats',
      stats: {
        buckets: [],
        stats: {
          totalTokens: 0,
          activeDays: 0,
          mostActiveDay: undefined,
          favoriteModel: undefined,
          sessionCount: 0,
          longestSessionMs: undefined,
        },
      },
    });
    expect(output(component)).toContain('No activity yet');
  });

  it('closes on Escape', () => {
    const { component, onCancel } = make();
    component.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('StatusDialogComponent mouse support', () => {
  /** The dispatch the TUI performs for a left-press at a component-relative cell. */
  const press = (component: StatusDialogComponent, row: number, col: number): void | boolean => {
    component.render(100); // a render always runs before dispatched input
    const zone = hitZoneAt(component.hitZones(), row, col, 'action');
    if (zone === null) return false;
    return component.onHitZone(zone.id, { type: 'press', button: 0, col, row, slotRelative: false });
  };
  /** The hover update the TUI performs for pointer motion at a component-relative cell. */
  const motion = (component: StatusDialogComponent, row: number, col: number): void | boolean => {
    component.render(100);
    const zone = row < 0 ? null : hitZoneAt(component.hitZones(), row, col, 'hover');
    return component.setHoveredZone(zone?.id ?? null);
  };

  /** 1-based column at which `marker` starts on its rendered line. */
  function colOf(component: StatusDialogComponent, marker: string): number {
    const lines = component.render(100).map(strip);
    for (const line of lines) {
      const idx = line.indexOf(marker);
      if (idx >= 0) return idx + 1;
    }
    throw new Error(`marker not rendered: ${marker}`);
  }

  it('switches tabs when a tab cell is clicked', () => {
    const { component } = make();

    expect(press(component, 4, colOf(component, 'Kimi Code'))).not.toBe(false);
    let out = output(component, 100);
    expect(out).toContain('Not logged in — run /login to see Kimi plan usage.');

    expect(press(component, 4, colOf(component, 'Stats'))).not.toBe(false);
    out = output(component, 100);
    expect(out).toContain('Active days');

    // The dialog title also contains "Status", so take the column from the
    // declared zone instead of a text marker.
    const statusCol = [...component.hitZones()][0]!.col;
    expect(press(component, 4, statusCol)).not.toBe(false);
    out = output(component, 100);
    expect(out).toContain('My session');

    // A press off the zones (body row, or the strip row between cells) hits nothing.
    expect(press(component, 8, 1)).toBe(false);
    expect(press(component, 4, 1)).toBe(false);
    expect(output(component, 100)).toContain('My session');
  });

  it('switches the stats range when a range word is clicked', () => {
    const { component } = make({ initialTab: 'stats' });

    // The range selector is the first body line (component-relative row 6).
    expect(press(component, 6, colOf(component, 'weekly'))).not.toBe(false);
    expect(output(component, 100)).toContain('Each column = 1 week');

    expect(press(component, 6, colOf(component, 'cumulative'))).not.toBe(false);
    expect(output(component, 100)).toContain('Running total · top');

    expect(press(component, 6, colOf(component, 'daily'))).not.toBe(false);
    expect(output(component, 100)).toContain('Less');

    // A press on the active range is a no-op; the separators are chrome.
    expect(press(component, 6, colOf(component, 'daily'))).toBe(false);
    expect(press(component, 6, colOf(component, 'daily') + 'daily'.length + 1)).toBe(false);
    expect(output(component, 100)).toContain('Less');
  });

  it('declares no range zones while the stats placeholder is showing', () => {
    const { component } = make({
      initialTab: 'stats',
      stats: { buckets: undefined, stats: undefined },
    });

    // Row 6 is the loading placeholder here — no zone covers it.
    expect(press(component, 6, 4)).toBe(false);
    expect(output(component, 100)).toContain('loading…');
  });

  it('underlines the hovered tab and clears on leave', () => {
    const prevLevel = chalk.level;
    chalk.level = 1;
    try {
      const { component } = make();
      const baseline = component.render(100).join('\n');

      expect(motion(component, 4, colOf(component, 'Kimi Code'))).not.toBe(false);
      expect(component.render(100).join('\n')).toContain(`${ESC}[4m`);
      expect(motion(component, 4, colOf(component, 'Kimi Code'))).toBe(false);

      motion(component, 0, 1); // header: not the strip → cleared
      expect(component.render(100).join('\n')).toBe(baseline);
    } finally {
      chalk.level = prevLevel;
    }
  });

  it('highlights the hovered stats range word with the hover background and clears on leave', () => {
    const prevLevel = chalk.level;
    chalk.level = 1;
    try {
      const { component } = make({ initialTab: 'stats' });
      const baseline = component.render(100).join('\n');
      expect(baseline).not.toContain(`${ESC}[48;2;`);

      // The range selector is the first body line (component-relative row 6).
      const weeklyCol = colOf(component, 'weekly');
      expect(motion(component, 6, weeklyCol)).not.toBe(false);
      const hovered = component.render(100);
      const weeklyLine = hovered[6] ?? '';
      expect(weeklyLine).toContain(`${ESC}[48;2;`);
      expect(weeklyLine).not.toContain(`${ESC}[4m`);
      // The background spans exactly the hovered word, not the neighbours.
      expect(strip(weeklyLine)).toContain('daily · weekly · cumulative');
      expect(motion(component, 6, weeklyCol)).toBe(false); // unchanged → frame skipped

      // The separator between words is chrome, not a range: leaving the word
      // clears the affordance back to the byte-identical baseline.
      const dailyCol = colOf(component, 'daily');
      expect(motion(component, 6, dailyCol + 'daily'.length + 1)).not.toBe(false);
      expect(component.render(100).join('\n')).toBe(baseline);

      motion(component, 0, 1); // header: not the selector → cleared
      expect(component.render(100).join('\n')).toBe(baseline);
    } finally {
      chalk.level = prevLevel;
    }
  });

  it('does not highlight range words while the stats placeholder is showing', () => {
    const prevLevel = chalk.level;
    chalk.level = 1;
    try {
      const { component } = make({
        initialTab: 'stats',
        stats: { buckets: undefined, stats: undefined },
      });
      const baseline = component.render(100).join('\n');

      // Row 6 is the loading placeholder here — no zone, nothing to highlight.
      expect(motion(component, 6, 4)).toBe(false);
      expect(component.render(100).join('\n')).toBe(baseline);
    } finally {
      chalk.level = prevLevel;
    }
  });
});

// ---------------------------------------------------------------------------
// ChatGPT reset-credit redeem flow
// ---------------------------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush pending promise chains (the dialog's async redeem transitions). */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

const REDEEM_CREDITS = [
  {
    id: 'credit-late',
    resetType: 'codex_rate_limits',
    status: 'available',
    title: 'Late reset',
    description: 'Expires later.',
    expiresAt: Date.parse('2028-06-01T00:00:00Z'),
  },
  {
    id: 'credit-early',
    resetType: 'codex_rate_limits',
    status: 'available',
    title: 'Full reset',
    description: 'Reset your current usage limits.',
    expiresAt: Date.parse('2027-06-01T00:00:00Z'),
  },
] as const;

function makeRedeem(overrides: Partial<StatusDialogOptions> = {}) {
  const preview = vi.fn(async () => [...REDEEM_CREDITS]);
  const consume = vi.fn(
    async (): Promise<ConsumeCodexResetCreditResult> => ({
      code: 'reset',
      rawCode: null,
      windowsReset: 2,
    }),
  );
  const requestRender = vi.fn();
  const refreshUsage = vi.fn();
  const made = make({
    initialTab: 'chatgpt',
    chatgpt: {
      account: { state: 'logged-in', email: 'user@example.com', planType: 'plus' },
      availableModels: AVAILABLE_MODELS,
      sessionUsage: { byModel: {} },
      rateLimit: null,
      codexUsage: {
        planType: 'plus',
        primary: { usedPercent: 42, windowMinutes: 300, resetsAt: null },
        secondary: null,
        credits: null,
        resetCreditsAvailable: 2,
        capturedAt: Date.now(),
      },
    },
    redeemResetCredit: { preview, consume, requestRender, refreshUsage },
    ...overrides,
  });
  return { ...made, preview, consume, requestRender, refreshUsage };
}

describe('StatusDialogComponent reset-credit redeem flow', () => {
  let previousLevel: typeof chalk.level;
  beforeAll(() => {
    previousLevel = chalk.level;
    chalk.level = 3;
    currentTheme.setPalette(darkColors);
  });
  afterAll(() => {
    chalk.level = previousLevel;
  });

  it('offers the action row only with a wired controller and available resets', () => {
    const withController = output(makeRedeem().component);
    expect(withController).toContain('Usage limit resets: 2 available · press R to redeem one');

    // No controller → the plain read-only count line.
    const plain = output(make({ initialTab: 'chatgpt' }).component);
    expect(plain).not.toContain('press R');

    // A zero count keeps the read-only line even with a controller.
    const none = makeRedeem();
    none.component.update({
      chatgpt: {
        codexUsage: {
          planType: 'plus',
          primary: null,
          secondary: null,
          credits: null,
          resetCreditsAvailable: 0,
          capturedAt: Date.now(),
        },
      },
    });
    const zeroed = output(none.component);
    expect(zeroed).toContain('Usage limit resets: none available');
    expect(zeroed).not.toContain('press R');
  });

  it('arms the confirm with r (listing the earliest-expiring credit) and disarms with n', async () => {
    const { component, consume } = makeRedeem();

    component.handleInput('r');
    expect(output(component)).toContain('checking available resets…');
    await flush();

    const armed = output(component);
    expect(armed).toContain('Redeem 1 of 2 usage limit resets? [y/N]');
    // codex picker order: soonest expiry first, regardless of payload order.
    expect(armed).toContain('Will use: "Full reset"');
    expect(armed).toContain('Also available: "Late reset"');

    component.handleInput('n');
    expect(output(component)).toContain('Usage limit resets: 2 available');
    expect(consume).not.toHaveBeenCalled();
  });

  it('Esc peels the armed confirm first and closes on the second press', async () => {
    const { component, onCancel } = makeRedeem();

    component.handleInput('r');
    await flush();
    expect(output(component)).toContain('[y/N]');

    component.handleInput(ESC);
    expect(onCancel).not.toHaveBeenCalled();
    expect(output(component)).toContain('Usage limit resets: 2 available');

    component.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('confirms with y, consumes the earliest-expiring credit, and refreshes on success', async () => {
    const { component, consume, refreshUsage, requestRender } = makeRedeem();

    component.handleInput('r');
    await flush();
    component.handleInput('y');
    expect(output(component)).toContain('Redeeming a usage limit reset…');
    await flush();

    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith('credit-early');
    expect(refreshUsage).toHaveBeenCalledTimes(1);
    expect(requestRender).toHaveBeenCalled();
    expect(output(component)).toContain('Usage limit reset — refreshing your quota…');
  });

  it('redeems directly without a credit id when the list endpoint fails', async () => {
    const { component, preview, consume } = makeRedeem();
    preview.mockRejectedValue(new Error('list exploded'));

    component.handleInput('r');
    await flush();
    const armed = output(component);
    expect(armed).toContain('Redeem 1 of 2 usage limit resets? [y/N]');
    expect(armed).not.toContain('Will use:');

    component.handleInput('y');
    await flush();
    expect(consume).toHaveBeenCalledWith(undefined);
    expect(output(component)).toContain('Usage limit reset — refreshing your quota…');
  });

  it('keeps the count and shows an error notice when the consume fails', async () => {
    const { component, consume, refreshUsage } = makeRedeem();
    consume.mockRejectedValue(new Error('endpoint unreachable'));

    component.handleInput('r');
    await flush();
    component.handleInput('y');
    await flush();

    const out = output(component);
    expect(out).toContain('Could not redeem a usage limit reset: endpoint unreachable');
    expect(out).toContain('Usage limit resets: 2 available');
    expect(refreshUsage).not.toHaveBeenCalled();
  });

  it('shows a neutral notice without refreshing on nothing_to_reset', async () => {
    const { component, consume, refreshUsage } = makeRedeem();
    consume.mockResolvedValue({ code: 'nothing_to_reset', rawCode: null, windowsReset: 0 });

    component.handleInput('r');
    await flush();
    component.handleInput('y');
    await flush();

    expect(output(component)).toContain('Your usage does not need a reset right now.');
    expect(refreshUsage).not.toHaveBeenCalled();
  });

  it('refreshes the stale count away on no_credit', async () => {
    const { component, consume, refreshUsage } = makeRedeem();
    consume.mockResolvedValue({ code: 'no_credit', rawCode: null, windowsReset: 0 });

    component.handleInput('r');
    await flush();
    component.handleInput('y');
    await flush();

    expect(output(component)).toContain('That reset is no longer available.');
    expect(refreshUsage).toHaveBeenCalledTimes(1);
  });

  it('swallows tab cycling and other keys while the confirm is armed', async () => {
    const { component } = makeRedeem();

    component.handleInput('r');
    await flush();
    component.handleInput(TAB);
    component.handleInput('d');
    const armed = output(component);
    expect(armed).toContain('[y/N]');
    // Still the ChatGPT tab — Tab never cycled.
    expect(armed).toContain('user@example.com (Plus)');
  });

  it('ignores r when no resets are available or no controller is wired', () => {
    const plain = make({ initialTab: 'chatgpt' });
    plain.component.handleInput('r');
    expect(output(plain.component)).not.toContain('[y/N]');

    const zero = makeRedeem();
    zero.component.update({
      chatgpt: {
        codexUsage: {
          planType: 'plus',
          primary: null,
          secondary: null,
          credits: null,
          resetCreditsAvailable: 0,
          capturedAt: Date.now(),
        },
      },
    });
    zero.component.handleInput('r');
    expect(output(zero.component)).not.toContain('[y/N]');
    expect(zero.preview).not.toHaveBeenCalled();
  });

  it('drops a stale preview settle after the arm was cancelled', async () => {
    const { component, preview } = makeRedeem();
    const gate = deferred<Awaited<ReturnType<typeof preview>>>();
    preview.mockReturnValue(gate.promise);

    component.handleInput('r');
    component.handleInput(ESC); // cancel while the list fetch is in flight
    gate.resolve([...REDEEM_CREDITS]);
    await flush();

    const out = output(component);
    expect(out).not.toContain('[y/N]');
    expect(out).toContain('Usage limit resets: 2 available');
  });
});

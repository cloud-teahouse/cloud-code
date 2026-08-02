/**
 * Hit-zone tests for StatusDialogComponent: the tab cells and the Stats
 * range words are the declared zones — they align with the rendered strip /
 * selector line, a press switches tabs/ranges (a press on the active one is
 * a no-op), and hover paints and clears. The range words became zones in the
 * hover-migration wave: the TUI delivers motion to zone-aware components
 * exclusively via setHoveredZone, so the previous raw handleMouse fallback
 * could never fire in production (only in direct unit-test calls).
 * Dispatch helpers mirror what the TUI does with the declared zones
 * (see choice-picker-zones.test.ts).
 */

import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hitZoneAt, type MouseEvent } from '@cloud-code/pi-tui';

import { StatusDialogComponent, type StatusDialogOptions } from '#/tui/components/dialogs/status-dialog';
import type { TokenActivityBucket } from '#/tui/components/messages/token-activity-chart';
import { setLocalePreference } from '#/tui/i18n';
import { currentTheme, darkColors } from '#/tui/theme';

const strip = (s: string): string => s.replaceAll(/\[[0-9;]*m/g, '');

const BUCKETS: TokenActivityBucket[] = [
  { date: '2026-06-14', tokens: 2000 },
  { date: '2026-06-15', tokens: 3000 },
];

function make(overrides: Partial<StatusDialogOptions> = {}) {
  const component = new StatusDialogComponent({
    status: {
      version: '1.2.3',
      model: 'k2',
      workDir: '/tmp/project',
      sessionId: 'ses-1',
      sessionTitle: 'My session',
      availableModels: {},
      permissionMode: 'manual',
      contextUsage: 0.25,
      contextTokens: 2500,
      maxContextTokens: 10000,
      mcpServers: [],
    },
    kimi: {
      account: { state: 'not-logged-in' },
      availableModels: {},
      sessionUsage: { byModel: {} },
    },
    chatgpt: {
      account: { state: 'not-logged-in' },
      availableModels: {},
      sessionUsage: { byModel: {} },
      rateLimit: null,
    },
    stats: {
      buckets: BUCKETS,
      stats: {
        totalTokens: 5000,
        activeDays: 2,
        mostActiveDay: { date: '2026-06-14', tokens: 2000 },
        favoriteModel: { model: 'kimi-k2', tokens: 4000 },
        sessionCount: 3,
        longestSessionMs: 3_660_000,
      },
    },
    onCancel: vi.fn(),
    ...overrides,
  });
  component.render(80);
  return { component };
}

function pressEvent(row: number, col = 1): MouseEvent {
  return { type: 'press', button: 0, col, row, slotRelative: false };
}

/** The dispatch the TUI performs for a left-press at a component-relative cell. */
function dispatchPress(component: StatusDialogComponent, row: number, col = 1): void | boolean {
  const zone = hitZoneAt(component.hitZones(), row, col, 'action');
  if (zone === null) return false;
  return component.onHitZone(zone.id, pressEvent(row, col));
}

/** The hover update the TUI performs for pointer motion at a component-relative cell. */
function dispatchHover(component: StatusDialogComponent, row: number, col = 1): void | boolean {
  const zone = row < 0 ? null : hitZoneAt(component.hitZones(), row, col, 'hover');
  return component.setHoveredZone(zone?.id ?? null);
}

/** 1-based column at which `marker` starts on the tab-strip row. */
function tabCol(component: StatusDialogComponent, marker: string): number {
  const stripRow = component.render(80).map(strip)[4] ?? '';
  const idx = stripRow.indexOf(marker);
  if (idx < 0) throw new Error(`tab not rendered: ${marker}`);
  return idx + 1;
}

describe('StatusDialogComponent hit zones', () => {
  const prevLevel = chalk.level;
  const prevPalette = currentTheme.palette;
  beforeAll(() => {
    chalk.level = 3;
    currentTheme.setPalette(darkColors);
    setLocalePreference('en');
  });
  afterAll(() => {
    chalk.level = prevLevel;
    currentTheme.setPalette(prevPalette);
    setLocalePreference('auto');
  });

  // Layout (width 80): 0 divider, 1 title, 2 hint, 3 blank, 4 tab strip,
  // 5 blank, 6+ tab body, closing divider.
  it('declares one zone per tab cell on the strip row', () => {
    const { component } = make();
    const lines = component.render(80).map(strip);
    const zones = [...component.hitZones()];
    expect(zones.map((zone) => zone.id)).toEqual(['tab:0', 'tab:1', 'tab:2', 'tab:3']);
    const labels = ['Status', 'Kimi Code', 'ChatGPT', 'Stats'];
    for (const [i, zone] of zones.entries()) {
      expect(zone.row).toBe(4);
      expect(lines[4]!.slice(zone.col - 1, zone.col - 1 + zone.width)).toBe(` ${labels[i]!} `);
    }
  });

  it('switches tabs on a tab-cell press; a press on the active tab is a no-op', () => {
    const { component } = make();
    const text = (): string => strip(component.render(80).join('\n'));

    expect(dispatchPress(component, 4, tabCol(component, 'Stats'))).not.toBe(false);
    expect(text()).toContain('daily · weekly · cumulative'); // the Stats body

    expect(dispatchPress(component, 4, tabCol(component, 'Stats'))).toBe(false); // already active
    expect(dispatchPress(component, 4, tabCol(component, 'Kimi Code'))).not.toBe(false);
    expect(text()).not.toContain('daily · weekly · cumulative');
  });

  it('misses zones for presses off the tab strip', () => {
    const { component } = make();
    for (const row of [0, 1, 2, 3, 5, 6, 7]) {
      expect(dispatchPress(component, row)).toBe(false);
    }
  });

  it('underlines the hovered tab cell and clears on leave and on switch', () => {
    const { component } = make();
    const baseline = component.render(80).join('\n'); // Status tab, nothing hovered
    const kimiCol = tabCol(component, 'Kimi Code');

    expect(dispatchHover(component, 4, kimiCol)).not.toBe(false);
    expect(component.render(80).join('\n')).toContain('[4m');
    expect(dispatchHover(component, 4, kimiCol)).toBe(false); // unchanged → frame skipped

    dispatchHover(component, -1); // pointer left → cleared
    expect(component.render(80).join('\n')).toBe(baseline);

    // Switching to the hovered tab clears the affordance with the press.
    expect(dispatchHover(component, 4, kimiCol)).not.toBe(false);
    expect(dispatchPress(component, 4, kimiCol)).not.toBe(false);
    expect(component.render(80).join('\n')).not.toContain('[4m');
  });

  it('declares one zone per range word on the Stats selector row', () => {
    const { component } = make({ initialTab: 'stats' });
    const lines = component.render(80).map(strip);
    const rangeZones = [...component.hitZones()].filter(
      (zone) => typeof zone.id === 'string' && zone.id.startsWith('range:'),
    );
    expect(rangeZones.map((zone) => zone.id)).toEqual(['range:0', 'range:1', 'range:2']);
    for (const [i, zone] of rangeZones.entries()) {
      expect(zone.row).toBe(6); // first body line
      expect(zone.height).toBe(1);
      const word = ['daily', 'weekly', 'cumulative'][i]!;
      expect(lines[6]!.slice(zone.col - 1, zone.col - 1 + zone.width)).toBe(word);
    }
    // The separators between words are chrome, not ranges.
    const daily = rangeZones[0]!;
    expect(hitZoneAt(rangeZones, 6, daily.col + daily.width, 'action')).toBeNull();
  });

  it('switches the range on a range-word press; a press on the active range is a no-op', () => {
    const { component } = make({ initialTab: 'stats' });
    const text = (): string => strip(component.render(80).join('\n'));

    const weeklyCol = strip(component.render(80)[6] ?? '').indexOf('weekly') + 1;
    expect(dispatchPress(component, 6, weeklyCol)).not.toBe(false);
    expect(text()).toContain('Each column = 1 week');

    // Same-range press: no-op, exactly like the active tab cell.
    expect(dispatchPress(component, 6, weeklyCol)).toBe(false);
    expect(text()).toContain('Each column = 1 week');

    // Identical to the keyboard path (`w`).
    const keyboard = make({ initialTab: 'stats' }).component;
    keyboard.handleInput('w');
    expect(text()).toBe(strip(keyboard.render(80).join('\n')));
  });

  it('paints the hover background on the hovered range word and clears on leave', () => {
    const { component } = make({ initialTab: 'stats' });
    const baseline = component.render(80).join('\n'); // nothing hovered
    const weeklyCol = strip(component.render(80)[6] ?? '').indexOf('weekly') + 1;

    expect(dispatchHover(component, 6, weeklyCol)).not.toBe(false);
    const hoveredLine = component.render(80)[6] ?? '';
    expect(hoveredLine).toContain('[48;2;'); // hover background, not underline
    expect(hoveredLine).not.toContain('[4m');
    expect(dispatchHover(component, 6, weeklyCol)).toBe(false); // unchanged → frame skipped

    dispatchHover(component, -1); // pointer left → cleared, byte-identical
    expect(component.render(80).join('\n')).toBe(baseline);

    // Switching ranges keeps the hover state coherent with the press.
    expect(dispatchHover(component, 6, weeklyCol)).not.toBe(false);
    expect(dispatchPress(component, 6, weeklyCol)).not.toBe(false);
    expect(component.render(80).join('\n')).toContain('[48;2;');
  });

  it('declares no range zones while the stats are still loading', () => {
    const { component } = make({
      initialTab: 'stats',
      stats: { buckets: BUCKETS, stats: undefined },
    });
    component.render(80);
    const zones = [...component.hitZones()];
    expect(zones.every((zone) => zone.row === 4)).toBe(true);
    expect(dispatchPress(component, 6, 12)).toBe(false);
    expect(dispatchHover(component, 6, 12)).toBe(false);
  });

  it('keeps the tab bodies read-only: no raw handleMouse fallback remains', () => {
    const { component } = make();
    // All mouse interaction is zone-dispatched; wheel/outside-zone events
    // have no handler to reach.
    expect('handleMouse' in component).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ChatGPT reset-credit redeem action row
// ---------------------------------------------------------------------------

/** Flush pending promise chains (the armed redeem's async preview settle). */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

function makeRedeem() {
  return make({
    initialTab: 'chatgpt',
    chatgpt: {
      account: { state: 'logged-in', email: 'user@example.com', planType: 'plus' },
      availableModels: {},
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
    redeemResetCredit: {
      preview: vi.fn(async () => []),
      consume: vi.fn(async () => ({ code: 'reset', rawCode: null, windowsReset: 2 }) as const),
      requestRender: vi.fn(),
      refreshUsage: vi.fn(),
    },
  });
}

describe('StatusDialogComponent redeem action-row zone', () => {
  const prevLevel = chalk.level;
  const prevPalette = currentTheme.palette;
  beforeAll(() => {
    chalk.level = 3;
    currentTheme.setPalette(darkColors);
    setLocalePreference('en');
  });
  afterAll(() => {
    chalk.level = prevLevel;
    currentTheme.setPalette(prevPalette);
    setLocalePreference('auto');
  });

  function redeemZone(component: StatusDialogComponent) {
    component.render(80);
    return [...component.hitZones()].find((zone) => zone.id === 'redeem') ?? null;
  }

  it('declares the zone exactly over the action line and arms the confirm on press', async () => {
    const { component } = makeRedeem();
    const zone = redeemZone(component);
    expect(zone).not.toBeNull();
    // The zone covers the rendered `press R` count line.
    const line = strip(component.render(80)[zone!.row] ?? '');
    expect(line).toContain('Usage limit resets: 2 available · press R to redeem one');
    expect(zone!.height).toBe(1);

    // A click on the action row is the `r` key's mouse equivalent.
    expect(dispatchPress(component, zone!.row, zone!.col)).not.toBe(false);
    expect(strip(component.render(80).join('\n'))).toContain('checking available resets…');
    await flush();
    expect(strip(component.render(80).join('\n'))).toContain('Redeem 1 of 2 usage limit resets? [y/N]');

    // While the confirm is armed the row declares no zone (keyboard-only).
    expect(redeemZone(component)).toBeNull();
  });

  it('declares no zone without a controller or with a zero count', () => {
    expect(redeemZone(make({ initialTab: 'chatgpt' }).component)).toBeNull();

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
    expect(redeemZone(zero.component)).toBeNull();
  });

  it('underlines the action row on hover and clears on leave', () => {
    const { component } = makeRedeem();
    const zone = redeemZone(component)!;
    const baseline = component.render(80).join('\n');

    expect(dispatchHover(component, zone.row, zone.col)).not.toBe(false);
    const hovered = component.render(80)[zone.row] ?? '';
    expect(hovered).toContain('[4m');
    expect(dispatchHover(component, zone.row, zone.col)).toBe(false); // unchanged → frame skipped

    dispatchHover(component, -1); // pointer left → cleared, byte-identical
    expect(component.render(80).join('\n')).toBe(baseline);
  });
});

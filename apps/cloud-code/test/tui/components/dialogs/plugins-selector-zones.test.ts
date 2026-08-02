/**
 * Hit-zone tests for PluginsPanelComponent: tab-cell zones, list-row zones
 * per tab, zone dispatch (tab switch, row highlight / re-click activate),
 * hover underline, and the installing-state mouse suppression. Dispatch
 * helpers mirror what the TUI does with the declared zones (see
 * choice-picker-zones.test.ts).
 */

import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hitZoneAt, type MouseEvent } from '@cloud-code/pi-tui';

import {
  PluginsPanelComponent,
  type PluginsPanelOptions,
  type PluginsPanelSelection,
} from '#/tui/components/dialogs/plugins-selector';
import { setLocalePreference } from '#/tui/i18n';

const strip = (s: string): string => s.replaceAll(/\u001B\[[0-9;]*m/g, '');

const superpowers = {
  id: 'superpowers',
  displayName: 'Superpowers',
  version: '5.1.0',
  enabled: true,
  state: 'ok' as const,
  skillCount: 14,
  mcpServerCount: 0,
  enabledMcpServerCount: 0,
  hookCount: 0,
  commandCount: 0,
  hasErrors: false,
  source: 'local-path' as const,
};

const datasource = {
  ...superpowers,
  id: 'kimi-datasource',
  displayName: 'Kimi Datasource',
};

function makePanel(over: Partial<PluginsPanelOptions> = {}) {
  const onSelect = vi.fn<(s: PluginsPanelSelection) => void>();
  const onRequestMarketplace = vi.fn();
  const panel = new PluginsPanelComponent({
    installed: [superpowers, datasource],
    installedIds: new Set(['superpowers', 'kimi-datasource']),
    onSelect,
    onCancel: vi.fn(),
    onRequestMarketplace,
    ...over,
  });
  panel.render(120);
  return { panel, onSelect, onRequestMarketplace };
}

function pressEvent(row: number, col = 1): MouseEvent {
  return { type: 'press', button: 0, col, row, slotRelative: false };
}

/** The dispatch the TUI performs for a left-press at a component-relative cell. */
function dispatchPress(panel: PluginsPanelComponent, row: number, col = 1): void | boolean {
  const zone = hitZoneAt(panel.hitZones(), row, col, 'action');
  if (zone === null) return false;
  return panel.onHitZone(zone.id, pressEvent(row, col));
}

/** The hover update the TUI performs for pointer motion at a component-relative cell. */
function dispatchHover(panel: PluginsPanelComponent, row: number, col = 1): void | boolean {
  const zone = row < 0 ? null : hitZoneAt(panel.hitZones(), row, col, 'hover');
  return panel.setHoveredZone(zone?.id ?? null);
}

describe('PluginsPanelComponent hit zones', () => {
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
    setLocalePreference('en');
  });
  afterAll(() => {
    chalk.level = prevLevel;
    setLocalePreference('auto');
  });

  // Layout (Installed tab, width 120): 0 divider, 1 title, 2 hint, 3 blank,
  // 4 tab strip, 5 blank, 6-8 search box, 9-10 first row (label + description),
  // 11-12 second row, 13 blank, 14 count, 15 divider.
  it('declares the tab cells, the search box, and one zone per list row spanning its rows', () => {
    const { panel } = makePanel();
    const lines = panel.render(120).map(strip);
    const zones = [...panel.hitZones()];
    expect(zones.map((zone) => zone.id)).toEqual([
      'tab:0',
      'tab:1',
      'tab:2',
      'tab:3',
      'search',
      'row:0',
      'row:1',
    ]);
    for (const zone of zones.slice(0, 4)) {
      expect(zone.row).toBe(4);
      expect(zone.height).toBe(1);
    }
    expect(zones[4]).toMatchObject({ row: 6, col: 1, width: 120, height: 3 });
    expect(zones[5]).toMatchObject({ row: 9, col: 1, width: 120, height: 2 });
    expect(zones[6]).toMatchObject({ row: 11, col: 1, width: 120, height: 2 });
    expect(lines[9]).toContain('Superpowers');
    expect(lines[11]).toContain('Kimi Datasource');
    // A press on a row's description line hits the same row.
    expect(hitZoneAt([zones[5]!], 10, 1, 'action')?.id).toBe('row:0');
  });

  it('switches tabs on a tab-cell press and requests the marketplace once', () => {
    const { panel, onRequestMarketplace } = makePanel();
    const official = [...panel.hitZones()].find((zone) => zone.id === 'tab:1')!;

    expect(dispatchPress(panel, official.row, official.col)).not.toBe(false);
    const out = strip(panel.render(120).join('\n'));
    expect(out).toContain('Kimi WebBridge'); // the Official tab's pinned row
    expect(onRequestMarketplace).toHaveBeenCalledTimes(1);

    // A press on the already-active tab is a no-op.
    const officialAgain = [...panel.hitZones()].find((zone) => zone.id === 'tab:1')!;
    expect(dispatchPress(panel, officialAgain.row, officialAgain.col)).toBe(false);
  });

  it('dispatches a row press: highlight, then re-click activates like Enter', () => {
    const { panel, onSelect } = makePanel();
    const text = (): string => strip(panel.render(120).join('\n'));

    expect(dispatchPress(panel, 11)).not.toBe(false); // Kimi Datasource row
    expect(text()).toContain('❯ Kimi Datasource');
    expect(onSelect).not.toHaveBeenCalled();

    dispatchPress(panel, 11); // re-click opens details (no update available)
    expect(onSelect).toHaveBeenCalledWith({ kind: 'details', id: 'kimi-datasource' });
  });

  it('focuses the search box on a search-zone press (the mouse counterpart of /)', () => {
    const { panel } = makePanel();
    const search = [...panel.hitZones()].find((zone) => zone.id === 'search')!;

    expect(dispatchPress(panel, search.row, search.col)).not.toBe(false);
    const out = strip(panel.render(120).join('\n'));
    expect(out).toContain('Esc back to list');

    // Typed characters land in the query, filtering the rows.
    panel.handleInput('d');
    panel.handleInput('a');
    const filtered = strip(panel.render(120).join('\n'));
    expect(filtered).toContain('Kimi Datasource');
    expect(filtered).not.toContain('❯ Superpowers');
  });

  it('misses row zones for presses on the header, blanks, and divider', () => {
    const { panel, onSelect } = makePanel();
    for (const row of [0, 1, 2, 3, 5, 13, 14, 15]) {
      expect(dispatchPress(panel, row)).toBe(false);
    }
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('underlines the hovered row / tab cell and clears on leave', () => {
    const { panel } = makePanel();
    const baseline = panel.render(120).join('\n');

    expect(dispatchHover(panel, 11)).not.toBe(false); // Kimi Datasource row
    expect(panel.render(120).join('\n')).toContain('[4m');
    expect(dispatchHover(panel, 11)).toBe(false); // unchanged → frame skipped

    const official = [...panel.hitZones()].find((zone) => zone.id === 'tab:1')!;
    expect(dispatchHover(panel, official.row, official.col)).not.toBe(false);
    expect(panel.render(120).join('\n')).toContain('[4m');

    dispatchHover(panel, -1);
    expect(panel.render(120).join('\n')).toBe(baseline);
  });

  it('declares only the tab zones on the Custom tab (a text input)', () => {
    const { panel } = makePanel({ initialTab: 'custom' });
    panel.render(120);
    expect([...panel.hitZones()].map((zone) => zone.id)).toEqual(['tab:0', 'tab:1', 'tab:2', 'tab:3']);
  });

  it('declares no zones and ignores the mouse while installing', () => {
    const { panel } = makePanel();
    panel.setInstalling('Superpowers');
    panel.render(120);
    expect([...panel.hitZones()]).toHaveLength(0);
    expect(
      panel.handleMouse({ type: 'press', button: 0, col: 1, row: 6, slotRelative: false }),
    ).toBe(false);
    expect(
      panel.handleMouse({ type: 'motion', button: 3, col: 1, row: 6, slotRelative: false }),
    ).toBe(false);
  });

  it('keeps the wheel behavior on handleMouse', () => {
    const { panel } = makePanel();
    const text = (): string => strip(panel.render(120).join('\n'));
    panel.handleMouse({ type: 'wheel', button: 65, col: 1, row: 1, slotRelative: false });
    expect(text()).toContain('❯ Kimi Datasource');
    panel.handleMouse({ type: 'wheel', button: 64, col: 1, row: 1, slotRelative: false });
    expect(text()).toContain('❯ Superpowers');
  });
});

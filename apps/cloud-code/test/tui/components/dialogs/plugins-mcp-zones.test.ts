/**
 * Hit-zone tests for PluginMcpSelectorComponent: zone alignment with the
 * rendered server/action rows (descriptions included), zone dispatch (toggle
 * / back activation), and hover underline. Dispatch helpers mirror what the
 * TUI does with the declared zones (see choice-picker-zones.test.ts).
 */

import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hitZoneAt, type MouseEvent } from '@cloud-code/pi-tui';

import {
  PluginMcpSelectorComponent,
  type PluginMcpSelection,
  type PluginMcpSelectorOptions,
} from '#/tui/components/dialogs/plugins-selector';
import { setLocalePreference } from '#/tui/i18n';

const strip = (s: string): string => s.replaceAll(/\u001B\[[0-9;]*m/g, '');

const info: PluginMcpSelectorOptions['info'] = {
  id: 'kimi-datasource',
  displayName: 'Kimi Datasource',
  version: '1.0.0',
  enabled: true,
  state: 'ok',
  skillCount: 1,
  mcpServerCount: 2,
  enabledMcpServerCount: 1,
  hookCount: 0,
  commandCount: 0,
  hasErrors: false,
  source: 'local-path',
  installedAt: '2026-05-29T00:00:00.000Z',
  root: '/plugins/kimi-datasource',
  manifest: undefined,
  mcpServers: [
    {
      name: 'data',
      runtimeName: 'plugin-kimi-datasource-data',
      enabled: true,
      transport: 'stdio',
      command: 'node',
      args: ['./bin/kimi-datasource.mjs'],
      cwd: '/plugins/kimi-datasource',
    },
    {
      name: 'search',
      runtimeName: 'plugin-kimi-datasource-search',
      enabled: false,
      transport: 'http',
      url: 'https://mcp.example.com/sse',
    },
  ],
  diagnostics: [],
};

function makePicker(over: Partial<PluginMcpSelectorOptions> = {}) {
  const onSelect = vi.fn<(s: PluginMcpSelection) => void>();
  const picker = new PluginMcpSelectorComponent({
    info,
    onSelect,
    onCancel: vi.fn(),
    ...over,
  });
  picker.render(120);
  return { picker, onSelect };
}

function pressEvent(row: number, col = 1): MouseEvent {
  return { type: 'press', button: 0, col, row, slotRelative: false };
}

/** The dispatch the TUI performs for a left-press at a component-relative cell. */
function dispatchPress(picker: PluginMcpSelectorComponent, row: number, col = 1): void | boolean {
  const zone = hitZoneAt(picker.hitZones(), row, col, 'action');
  if (zone === null) return false;
  return picker.onHitZone(zone.id, pressEvent(row, col));
}

/** The hover update the TUI performs for pointer motion at a component-relative cell. */
function dispatchHover(picker: PluginMcpSelectorComponent, row: number, col = 1): void | boolean {
  const zone = row < 0 ? null : hitZoneAt(picker.hitZones(), row, col, 'hover');
  return picker.setHoveredZone(zone?.id ?? null);
}

describe('PluginMcpSelectorComponent hit zones', () => {
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
    setLocalePreference('en');
  });
  afterAll(() => {
    chalk.level = prevLevel;
    setLocalePreference('auto');
  });

  // Layout (width 120): 0 divider, 1 title, 2 hint, 3 blank, 4 section label,
  // 5-6 data row (label + description), 7-8 search row, 9 blank,
  // 10 actions label, 11-12 Back row, 13 blank, 14 divider.
  it('declares one zone per server/action row spanning its description rows', () => {
    const { picker } = makePicker();
    const lines = picker.render(120).map(strip);
    const zones = [...picker.hitZones()];
    expect(zones.map((zone) => zone.id)).toEqual([0, 1, 2]);
    expect(zones[0]).toMatchObject({ row: 5, col: 1, width: 120, height: 2 });
    expect(zones[1]).toMatchObject({ row: 7, col: 1, width: 120, height: 2 });
    expect(zones[2]).toMatchObject({ row: 11, col: 1, width: 120, height: 2 });
    expect(lines[5]).toContain('data');
    expect(lines[7]).toContain('search');
    expect(lines[11]).toContain('Back');
    // A press on a row's description line hits the same row.
    expect(hitZoneAt([zones[0]!], 6, 1, 'action')?.id).toBe(0);
  });

  it('activates a server row on press (toggle) and moves the highlight onto it', () => {
    const { picker, onSelect } = makePicker();
    const text = (): string => strip(picker.render(120).join('\n'));

    expect(dispatchPress(picker, 7)).not.toBe(false); // search row
    expect(text()).toContain('❯ search');
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'toggle',
      pluginId: 'kimi-datasource',
      server: 'search',
      enabled: true,
    });
  });

  it('fires the Back row on press', () => {
    const { picker, onSelect } = makePicker();
    expect(dispatchPress(picker, 11)).not.toBe(false);
    expect(onSelect).toHaveBeenCalledWith({ kind: 'back', pluginId: 'kimi-datasource' });
  });

  it('misses zones for presses on the header, section labels, and blanks', () => {
    const { picker, onSelect } = makePicker();
    for (const row of [0, 1, 2, 3, 4, 9, 10, 13, 14]) {
      expect(dispatchPress(picker, row)).toBe(false);
    }
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('declares no zone on the empty-servers notice', () => {
    const { picker, onSelect } = makePicker({
      info: { ...info, mcpServers: [], mcpServerCount: 0, enabledMcpServerCount: 0 },
    });
    picker.render(120);
    const zones = [...picker.hitZones()];
    // Only the Back row is interactive; the notice row (5) is chrome.
    expect(zones.map((zone) => zone.id)).toEqual([0]);
    expect(zones[0]).toMatchObject({ row: 8 });
    expect(dispatchPress(picker, 5)).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('underlines the hovered row and clears on leave', () => {
    const { picker } = makePicker();
    const baseline = picker.render(120).join('\n');

    expect(dispatchHover(picker, 7)).not.toBe(false); // search row
    expect(picker.render(120).join('\n')).toContain('[4m');
    expect(dispatchHover(picker, 7)).toBe(false); // unchanged → frame skipped

    dispatchHover(picker, -1);
    expect(picker.render(120).join('\n')).toBe(baseline);
  });

  it('keeps the wheel behavior on handleMouse', () => {
    const { picker } = makePicker();
    const text = (): string => strip(picker.render(120).join('\n'));
    picker.handleMouse({ type: 'wheel', button: 65, col: 1, row: 1, slotRelative: false });
    expect(text()).toContain('❯ search');
    picker.handleMouse({ type: 'wheel', button: 64, col: 1, row: 1, slotRelative: false });
    expect(text()).toContain('❯ data');
  });
});

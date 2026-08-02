/**
 * Hit-zone tests for TabbedModelSelectorComponent: the frame composes the
 * tab-strip zones with the active tab's content zones (no row-offset math),
 * tab clicks switch tabs, content presses/hover forward to the active inner
 * selector, and wheel events keep forwarding. Dispatch helpers mirror what
 * the TUI does with the declared zones.
 */

import type { ModelAlias } from '@cloud-code/sdk';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hitZoneAt, type MouseEvent } from '@cloud-code/pi-tui';

import { DIALOG_SEARCH_ZONE } from '#/tui/components/dialogs/frame/dialog-frame';
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';
import { setLocalePreference } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { darkColors } from '#/tui/theme/colors';

const strip = (s: string): string => s.replaceAll(/\[[0-9;]*m/g, '');

function model(displayName: string, provider: string): ModelAlias {
  return {
    provider,
    model: displayName.toLowerCase().replaceAll(' ', '-'),
    maxContextSize: 200_000,
    displayName,
    capabilities: ['thinking'],
  } as unknown as ModelAlias;
}

function make() {
  const onSelect = vi.fn();
  const component = new TabbedModelSelectorComponent({
    models: { k2: model('Kimi K2', 'managed:kimi-code'), gpt: model('GPT-5', 'openai') },
    currentValue: 'k2',
    currentThinkingEffort: 'off',
    onSelect,
    onCancel: vi.fn(),
  });
  component.render(120);
  return { component, onSelect };
}

function pressEvent(row: number, col = 1): MouseEvent {
  return { type: 'press', button: 0, col, row, slotRelative: false };
}

/** The dispatch the TUI performs for a left-press at a component-relative cell. */
function dispatchPress(component: TabbedModelSelectorComponent, row: number, col = 1): void | boolean {
  const zone = hitZoneAt(component.hitZones(), row, col, 'action');
  if (zone === null) return false;
  return component.onHitZone(zone.id, pressEvent(row, col));
}

/** The hover update the TUI performs for pointer motion at a component-relative cell. */
function dispatchHover(component: TabbedModelSelectorComponent, row: number, col = 1): void | boolean {
  const zone = row < 0 ? null : hitZoneAt(component.hitZones(), row, col, 'hover');
  return component.setHoveredZone(zone?.id ?? null);
}

describe('TabbedModelSelectorComponent hit zones', () => {
  const prevLevel = chalk.level;
  const prevPalette = currentTheme.palette;
  beforeAll(() => {
    chalk.level = 1;
    currentTheme.setPalette(darkColors);
    setLocalePreference('en');
  });
  afterAll(() => {
    chalk.level = prevLevel;
    currentTheme.setPalette(prevPalette);
    setLocalePreference('auto');
  });

  // Layout (width 120): 0 divider, 1 title, 2 hint, 3 blank, 4 tab strip,
  // 5 blank, 6-8 search box, 9-10 model rows, 11 blank, 12 thinking header,
  // 13 control, 14 blank, 15 divider.
  it('composes tab zones on the strip row with the content zones below the search box', () => {
    const { component } = make();
    const zones = [...component.hitZones()];
    const tabs = zones.filter((zone) => typeof zone.id === 'string' && zone.id.startsWith('tab:'));
    expect(tabs.map((zone) => zone.id)).toEqual(['tab:0', 'tab:1', 'tab:2']);
    for (const tab of tabs) expect(tab.row).toBe(4);

    const rows = zones.filter((zone) => typeof zone.id === 'number');
    expect(rows.map((zone) => [zone.id, zone.row])).toEqual([
      [0, 9],
      [1, 10],
    ]);
    expect(zones.some((zone) => zone.id === DIALOG_SEARCH_ZONE)).toBe(true);
    expect(zones.some((zone) => typeof zone.id === 'string' && zone.id.startsWith('thinking:'))).toBe(
      true,
    );
  });

  it('switches tabs when a tab zone is pressed', () => {
    const { component } = make();
    const lines = component.render(120).map(strip);
    const openaiCol = lines[4]!.indexOf('openai') + 1;

    expect(dispatchPress(component, 4, openaiCol)).not.toBe(false);
    const text = strip(component.render(120).join('\n'));
    expect(text).toContain('❯ GPT-5');
    expect(text).not.toContain('Kimi K2');
  });

  it('forwards content presses to the active tab: highlight, then re-click confirms', () => {
    const { component, onSelect } = make();
    const text = (): string => strip(component.render(120).join('\n'));

    expect(dispatchPress(component, 10)).not.toBe(false); // GPT-5 row on the All tab
    expect(text()).toContain('❯ GPT-5');
    expect(onSelect).not.toHaveBeenCalled();

    dispatchPress(component, 10); // re-click confirms (non-current toggle models draft 'on')
    expect(onSelect).toHaveBeenCalledWith({ alias: 'gpt', thinking: 'on' });
  });

  it('focuses the active tab search box via its zone', () => {
    const { component } = make();
    const focused = (): boolean =>
      component.render(120).map(strip).some((l) => l.includes('Esc back to list'));
    expect(focused()).toBe(false);
    dispatchPress(component, 7);
    expect(focused()).toBe(true);
  });

  it('hovers tabs and content rows independently', () => {
    const { component } = make();
    const baseline = component.render(120).join('\n');
    const lines = component.render(120).map(strip);
    const openaiCol = lines[4]!.indexOf('openai') + 1;

    expect(dispatchHover(component, 4, openaiCol)).not.toBe(false); // tab hover
    expect(component.render(120).join('\n')).toContain('[4m');

    expect(dispatchHover(component, 10)).not.toBe(false); // list hover replaces it
    const hovered = component.render(120).join('\n');
    expect(hovered).toContain('[4m');
    expect(strip(hovered.split('\n')[4]!)).not.toContain('[4m'); // strip clear

    dispatchHover(component, -1);
    expect(component.render(120).join('\n')).toBe(baseline);
  });

  it('keeps forwarding the wheel to the active tab', () => {
    const { component } = make();
    const text = (): string => strip(component.render(120).join('\n'));
    component.handleMouse({ type: 'wheel', button: 65, col: 1, row: 1, slotRelative: false });
    expect(text()).toContain('❯ GPT-5');
    component.handleMouse({ type: 'wheel', button: 64, col: 1, row: 1, slotRelative: false });
    expect(text()).toContain('❯ Kimi K2');
  });

  it('declares the inner zones unchanged when only one tab exists', () => {
    const component = new TabbedModelSelectorComponent({
      models: {},
      currentValue: 'k2',
      currentThinkingEffort: 'off',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    component.render(120);
    const zones = [...component.hitZones()];
    expect(zones.some((zone) => typeof zone.id === 'string' && zone.id.startsWith('tab:'))).toBe(
      false,
    );
    // The single tab's search box is still focusable.
    expect(zones.some((zone) => zone.id === DIALOG_SEARCH_ZONE)).toBe(true);
  });
});

/**
 * Hit-zone tests for ModelSelectorComponent: zone alignment with the
 * rendered rows, zone dispatch (row select / re-click confirm, thinking
 * segments, search-box focus), hover underline, and the delete-confirm
 * mouse suppression. Dispatch helpers mirror what the TUI does with the
 * declared zones (see approval-panel-zones.test.ts).
 */

import type { ModelAlias } from '@cloud-code/sdk';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hitZoneAt, type MouseEvent } from '@cloud-code/pi-tui';

import { DIALOG_SEARCH_ZONE } from '#/tui/components/dialogs/frame/dialog-frame';
import { ModelSelectorComponent, type ModelSelectorOptions } from '#/tui/components/dialogs/model-selector';
import { setLocalePreference } from '#/tui/i18n';

const strip = (s: string): string => s.replaceAll(/\[[0-9;]*m/g, '');
const ESC = String.fromCodePoint(27);

function model(displayName: string, capabilities: string[] = ['thinking']): ModelAlias {
  return {
    provider: 'managed:kimi-code',
    model: displayName.toLowerCase().replaceAll(' ', '-'),
    maxContextSize: 200_000,
    displayName,
    capabilities,
  } as unknown as ModelAlias;
}

function makePicker(over: Partial<ModelSelectorOptions> = {}) {
  const onSelect = vi.fn();
  const picker = new ModelSelectorComponent({
    models: { a: model('Alpha'), b: model('Beta'), c: model('Gamma') },
    currentValue: 'a',
    currentThinkingEffort: 'on',
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
function dispatchPress(picker: ModelSelectorComponent, row: number, col = 1): void | boolean {
  const zone = hitZoneAt(picker.hitZones(), row, col, 'action');
  if (zone === null) return false;
  return picker.onHitZone(zone.id, pressEvent(row, col));
}

/** The hover update the TUI performs for pointer motion at a component-relative cell. */
function dispatchHover(picker: ModelSelectorComponent, row: number, col = 1): void | boolean {
  const zone = row < 0 ? null : hitZoneAt(picker.hitZones(), row, col, 'hover');
  return picker.setHoveredZone(zone?.id ?? null);
}

describe('ModelSelectorComponent hit zones', () => {
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
    setLocalePreference('en');
  });
  afterAll(() => {
    chalk.level = prevLevel;
    setLocalePreference('auto');
  });

  // Layout (no search/warning, width 120): 0 divider, 1 title, 2 hint,
  // 3 blank, 4-6 model rows, 7 blank, 8 thinking header, 9 control, …
  it('declares one full-width zone per visible model row', () => {
    const { picker } = makePicker();
    const lines = picker.render(120).map(strip);
    const rowZones = [...picker.hitZones()].filter((zone) => typeof zone.id === 'number');
    expect(rowZones.map((zone) => zone.id)).toEqual([0, 1, 2]);
    for (const [i, zone] of rowZones.entries()) {
      expect(zone).toMatchObject({ row: 4 + i, col: 1, width: 120, height: 1 });
      expect(lines[zone.row]).toContain(['Alpha', 'Beta', 'Gamma'][i]!);
    }
  });

  it('declares a zone per thinking segment on the control row', () => {
    const { picker } = makePicker();
    const zones = [...picker.hitZones()].filter(
      (zone) => typeof zone.id === 'string' && zone.id.startsWith('thinking:'),
    );
    expect(zones.map((zone) => zone.id)).toEqual(['thinking:on', 'thinking:off']);
    // '  [ On ]  Off  ' — active cell at col 3 (6 cells), gap 2, then '  Off  '.
    expect(zones[0]).toMatchObject({ row: 9, col: 3, width: 6, height: 1 });
    expect(zones[1]).toMatchObject({ row: 9, col: 11, width: 7, height: 1 });
  });

  it('dispatches a row press: highlight, then re-click confirms like Enter', () => {
    const { picker, onSelect } = makePicker();
    const text = (): string => strip(picker.render(120).join('\n'));

    expect(dispatchPress(picker, 5)).not.toBe(false); // Beta row
    expect(text()).toContain('❯ Beta');
    expect(onSelect).not.toHaveBeenCalled();

    dispatchPress(picker, 5); // re-click confirms
    expect(onSelect).toHaveBeenCalledWith({ alias: 'b', thinking: 'on' });
  });

  it('applies a thinking segment press to the selected model', () => {
    const { picker, onSelect } = makePicker();
    expect(dispatchPress(picker, 9, 11)).not.toBe(false); // the Off cell
    expect(strip(picker.render(120).join('\n'))).toContain('[ Off ]');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({ alias: 'a', thinking: 'off' });
  });

  it('declares one zone per effort segment for effort-capable models', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        k2: {
          provider: 'managed:kimi-code',
          model: 'kimi-k2',
          maxContextSize: 200_000,
          displayName: 'Kimi K2',
          capabilities: ['thinking'],
          supportEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
        } as unknown as ModelAlias,
      },
      currentValue: 'k2',
      currentThinkingEffort: 'medium',
      onSelect,
      onCancel: vi.fn(),
    });
    picker.render(120);
    const zones = [...picker.hitZones()].filter(
      (zone) => typeof zone.id === 'string' && zone.id.startsWith('thinking:'),
    );
    expect(zones.map((zone) => zone.id)).toEqual([
      'thinking:off',
      'thinking:low',
      'thinking:medium',
      'thinking:high',
    ]);
    const high = zones[3]!;
    dispatchPress(picker, high.row, high.col);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({ alias: 'k2', thinking: 'high' });
  });

  it('keeps a locked (single-segment) control hoverable but not clickable', () => {
    const { picker } = makePicker({ models: { a: model('Alpha', ['always_thinking']) } });
    picker.render(120);
    const zones = [...picker.hitZones()].filter(
      (zone) => typeof zone.id === 'string' && zone.id.startsWith('thinking:'),
    );
    // The active On cell hovers; the greyed-out Off cell declares no zone.
    expect(zones.map((zone) => zone.id)).toEqual(['thinking:on']);
    const on = zones[0]!;
    expect(hitZoneAt([on], on.row, on.col, 'action')).toBeNull(); // action suppressed
    expect(dispatchPress(picker, on.row, on.col)).toBe(false);
    expect(dispatchHover(picker, on.row, on.col)).not.toBe(false);
    expect(picker.render(120).join('\n')).toContain('[4m');
  });

  it('focuses the search box via its zone, without a hover affordance', () => {
    const { picker } = makePicker({ searchable: true });
    picker.render(120);
    const searchZone = [...picker.hitZones()].find((zone) => zone.id === DIALOG_SEARCH_ZONE);
    expect(searchZone).toMatchObject({ row: 4, col: 1, width: 120, height: 3 });
    expect(hitZoneAt([searchZone!], 5, 3, 'hover')).toBeNull();

    const focused = (): boolean =>
      picker.render(120).map(strip).some((l) => l.includes('Esc back to list'));
    expect(focused()).toBe(false);
    dispatchPress(picker, 5);
    expect(focused()).toBe(true);
  });

  it('underlines the hovered row and clears on leave', () => {
    const { picker } = makePicker();
    const baseline = picker.render(120).join('\n');

    expect(dispatchHover(picker, 6)).not.toBe(false); // Gamma row
    expect(picker.render(120).join('\n')).toContain('[4m');
    expect(dispatchHover(picker, 6)).toBe(false); // unchanged → frame skipped

    dispatchHover(picker, -1);
    expect(picker.render(120).join('\n')).toBe(baseline);
  });

  it('declares no zones while the delete confirmation is armed', () => {
    const { picker } = makePicker({
      manage: { isCustom: () => true, onEdit: vi.fn(), onDelete: vi.fn(), onGuard: vi.fn() },
    });
    picker.handleInput(`${ESC}d`); // Alt+D arms the inline confirm
    picker.render(120);
    expect([...picker.hitZones()]).toHaveLength(0);
    expect(
      picker.handleMouse({ type: 'press', button: 0, col: 1, row: 4, slotRelative: false }),
    ).toBe(false);
  });

  it('keeps the wheel behavior on handleMouse', () => {
    const { picker } = makePicker();
    const text = (): string => strip(picker.render(120).join('\n'));
    picker.handleMouse({ type: 'wheel', button: 65, col: 1, row: 1, slotRelative: false });
    expect(text()).toContain('❯ Beta');
    picker.handleMouse({ type: 'wheel', button: 64, col: 1, row: 1, slotRelative: false });
    expect(text()).toContain('❯ Alpha');
  });
});

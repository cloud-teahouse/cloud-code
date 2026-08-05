/**
 * Hit-zone tests for ProviderManagerComponent: zone alignment with the
 * rendered source/add rows (base-URL rows included), zone dispatch
 * (highlight, add-row re-click), hover underline, and the delete-confirm
 * mouse suppression. Dispatch helpers mirror what the TUI does with the
 * declared zones (see choice-picker-zones.test.ts).
 */

import type { ProviderConfig } from '@cloud-code/sdk';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hitZoneAt, type MouseEvent } from '@cloud-code/pi-tui';

import {
  ProviderManagerComponent,
  type ProviderManagerOptions,
} from '#/tui/components/dialogs/provider-manager';
import { setLocalePreference } from '#/tui/i18n';

const strip = (s: string): string => s.replaceAll(/\u001B\[[0-9;]*m/g, '');

function makeManager(over: Partial<ProviderManagerOptions> = {}) {
  const onAdd = vi.fn();
  const manager = new ProviderManagerComponent({
    providers: {
      acme: { baseUrl: 'https://acme.test' },
      registry: {
        baseUrl: 'https://reg.test/v1',
        source: { kind: 'apiJson', url: 'https://reg.test/api.json', apiKey: 'k' },
      },
    } as unknown as Record<string, ProviderConfig>,
    onAdd,
    onDeleteSource: vi.fn(),
    onClose: vi.fn(),
    ...over,
  });
  manager.render(120);
  return { manager, onAdd };
}

function pressEvent(row: number, col = 1): MouseEvent {
  return { type: 'press', button: 0, col, row, slotRelative: false };
}

/** The dispatch the TUI performs for a left-press at a component-relative cell. */
function dispatchPress(manager: ProviderManagerComponent, row: number, col = 1): void | boolean {
  const zone = hitZoneAt(manager.hitZones(), row, col, 'action');
  if (zone === null) return false;
  return manager.onHitZone(zone.id, pressEvent(row, col));
}

/** The hover update the TUI performs for pointer motion at a component-relative cell. */
function dispatchHover(manager: ProviderManagerComponent, row: number, col = 1): void | boolean {
  const zone = row < 0 ? null : hitZoneAt(manager.hitZones(), row, col, 'hover');
  return manager.setHoveredZone(zone?.id ?? null);
}

describe('ProviderManagerComponent hit zones', () => {
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
    setLocalePreference('en');
  });
  afterAll(() => {
    chalk.level = prevLevel;
    setLocalePreference('auto');
  });

  // Layout (width 120): 0 divider, 1 title, 2 hint, 3 blank, 4-6 search box,
  // 7-8 acme row (label + base URL), 9-10 registry row, 11 add row, 12 blank,
  // 13 divider.
  it('declares one zone per row spanning its base-URL row', () => {
    const { manager } = makeManager();
    const lines = manager.render(120).map(strip);
    const zones = [...manager.hitZones()];
    expect(zones.map((zone) => zone.id)).toEqual(['search', 0, 1, 2]);
    expect(zones[1]).toMatchObject({ row: 7, col: 1, width: 120, height: 2 });
    expect(zones[2]).toMatchObject({ row: 9, col: 1, width: 120, height: 2 });
    expect(zones[3]).toMatchObject({ row: 11, col: 1, width: 120, height: 1 });
    expect(lines[7]).toContain('acme');
    expect(lines[9]).toContain('reg.test/api.json');
    expect(lines[11]).toContain('Add New Platform');
    // A press on a row's base-URL line hits the same row.
    expect(hitZoneAt([zones[1]!], 8, 1, 'action')?.id).toBe(0);
  });

  it('dispatches a row press: highlight, then re-click views the provider models', () => {
    const onViewModels = vi.fn();
    const { manager, onAdd } = makeManager({ onViewModels });
    const text = (): string => strip(manager.render(120).join('\n'));

    expect(dispatchPress(manager, 9)).not.toBe(false); // registry row
    expect(text()).toContain('❯ reg.test/api.json');
    expect(onViewModels).not.toHaveBeenCalled();

    // Re-clicking the selected row is the Enter equivalent: view its models.
    expect(dispatchPress(manager, 9)).not.toBe(false);
    expect(onViewModels).toHaveBeenCalledWith('registry');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('fires onAdd when the highlighted add row is re-clicked', () => {
    const { manager, onAdd } = makeManager();
    expect(dispatchPress(manager, 11)).not.toBe(false); // highlight the add row
    expect(strip(manager.render(120).join('\n'))).toContain('❯ [ Add New Platform ]');
    dispatchPress(manager, 11); // re-click fires it (Enter equivalent)
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('misses zones for presses on the header, blank, and divider rows', () => {
    const { manager, onAdd } = makeManager();
    for (const row of [0, 1, 2, 3, 12, 13]) {
      expect(dispatchPress(manager, row)).toBe(false);
    }
    // The search box rows hit the search zone instead of any content row.
    expect(hitZoneAt([...manager.hitZones()], 5, 1, 'action')?.id).toBe('search');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('declares no zones and ignores the mouse while the delete confirmation is armed', () => {
    const { manager } = makeManager();
    manager.handleInput('D'); // arms the inline [y/N] confirm
    manager.render(120);
    expect([...manager.hitZones()]).toHaveLength(0);
    expect(
      manager.handleMouse({ type: 'press', button: 0, col: 1, row: 7, slotRelative: false }),
    ).toBe(false);
    expect(
      manager.handleMouse({ type: 'motion', button: 3, col: 1, row: 7, slotRelative: false }),
    ).toBe(false);
  });

  it('underlines the hovered row and clears on leave', () => {
    const { manager } = makeManager();
    const baseline = manager.render(120).join('\n');

    expect(dispatchHover(manager, 9)).not.toBe(false); // registry row
    expect(manager.render(120).join('\n')).toContain('[4m');
    expect(dispatchHover(manager, 9)).toBe(false); // unchanged → frame skipped

    dispatchHover(manager, -1);
    expect(manager.render(120).join('\n')).toBe(baseline);
  });

  it('keeps the wheel behavior on handleMouse', () => {
    const { manager } = makeManager();
    const text = (): string => strip(manager.render(120).join('\n'));
    manager.handleMouse({ type: 'wheel', button: 65, col: 1, row: 1, slotRelative: false });
    expect(text()).toContain('❯ reg.test/api.json');
    manager.handleMouse({ type: 'wheel', button: 64, col: 1, row: 1, slotRelative: false });
    expect(text()).toContain('❯ acme');
  });
});

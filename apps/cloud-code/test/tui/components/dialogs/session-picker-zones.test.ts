/**
 * Hit-zone tests for SessionPickerComponent: card-zone alignment with the
 * rendered cards (multi-row cards, separator rows excluded), zone dispatch
 * (select / re-click open, search-box focus), hover underline across the
 * whole card, and the loading/empty states declaring no zones. Dispatch
 * helpers mirror what the TUI does with the declared zones.
 */

import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hitZoneAt, type MouseEvent } from '@cloud-code/pi-tui';

import { DIALOG_SEARCH_ZONE } from '#/tui/components/dialogs/frame/dialog-frame';
import { SessionPickerComponent, type SessionRow } from '#/tui/components/dialogs/session-picker';
import { setLocalePreference } from '#/tui/i18n';

const strip = (s: string): string => s.replaceAll(/\[[0-9;]*m/g, '');

const SESSIONS: SessionRow[] = [
  {
    id: 'ses_alpha',
    title: 'Alpha session',
    last_prompt: 'fix the bug',
    work_dir: '/tmp/project-a',
    updated_at: 1,
  },
  { id: 'ses_beta', title: 'Beta session', work_dir: '/tmp/project-b', updated_at: 2 },
  { id: 'ses_gamma', title: 'Gamma session', work_dir: '/tmp/project-c', updated_at: 3 },
];

function makePicker(over: Partial<ConstructorParameters<typeof SessionPickerComponent>[0]> = {}) {
  const onSelect = vi.fn();
  const picker = new SessionPickerComponent({
    sessions: SESSIONS,
    loading: false,
    currentSessionId: '',
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
function dispatchPress(picker: SessionPickerComponent, row: number, col = 1): void | boolean {
  const zone = hitZoneAt(picker.hitZones(), row, col, 'action');
  if (zone === null) return false;
  return picker.onHitZone(zone.id, pressEvent(row, col));
}

/** The hover update the TUI performs for pointer motion at a component-relative cell. */
function dispatchHover(picker: SessionPickerComponent, row: number, col = 1): void | boolean {
  const zone = row < 0 ? null : hitZoneAt(picker.hitZones(), row, col, 'hover');
  return picker.setHoveredZone(zone?.id ?? null);
}

describe('SessionPickerComponent hit zones', () => {
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
  // 7-9 Alpha card (prompt → 3 rows), 10 separator, 11-12 Beta, 13 separator,
  // 14-15 Gamma, 16 divider.
  it('declares one zone per card spanning its rendered rows, separators excluded', () => {
    const { picker } = makePicker();
    const lines = picker.render(120).map(strip);
    const cardZones = [...picker.hitZones()].filter((zone) => typeof zone.id === 'number');
    expect(cardZones.map((zone) => [zone.id, zone.row, zone.height])).toEqual([
      [0, 7, 3],
      [1, 11, 2],
      [2, 14, 2],
    ]);
    expect(lines[7]).toContain('Alpha session');
    expect(lines[11]).toContain('Beta session');
    // The blank separators between cards declare no zone.
    expect(hitZoneAt(picker.hitZones(), 10, 1, 'action')).toBeNull();
    expect(hitZoneAt(picker.hitZones(), 13, 1, 'action')).toBeNull();
  });

  it('dispatches a card press: highlight anywhere in the card, then re-click opens', () => {
    const { picker, onSelect } = makePicker();
    const text = (): string => strip(picker.render(120).join('\n'));

    expect(dispatchPress(picker, 11)).not.toBe(false); // Beta title row
    expect(text()).toContain('❯ Beta session');
    expect(onSelect).not.toHaveBeenCalled();

    dispatchPress(picker, 12); // re-click on the selected card (any row) opens it
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'ses_beta' }));
  });

  it('focuses the search box via its zone', () => {
    const { picker } = makePicker();
    const searchZone = [...picker.hitZones()].find((zone) => zone.id === DIALOG_SEARCH_ZONE);
    expect(searchZone).toMatchObject({ row: 4, col: 1, width: 120, height: 3 });

    dispatchPress(picker, 5);
    const out = strip(picker.render(120).join('\n'));
    expect(out).toContain('Esc back to list');
    expect(out).toContain('❯ Alpha session'); // cursor untouched
  });

  it('underlines every text row of the hovered card and clears on leave', () => {
    const { picker } = makePicker();
    const baseline = picker.render(120).join('\n');

    expect(dispatchHover(picker, 14)).not.toBe(false); // Gamma card
    const hovered = picker.render(120).join('\n');
    // Both rows of the two-row card underline.
    expect(hovered.match(/\[4m/g)?.length).toBeGreaterThanOrEqual(2);

    dispatchHover(picker, -1);
    expect(picker.render(120).join('\n')).toBe(baseline);
  });

  it('declares no zones in the loading and empty states', () => {
    const loading = makePicker({ sessions: [], loading: true });
    expect([...loading.picker.hitZones()]).toHaveLength(0);
    const empty = makePicker({ sessions: [] });
    expect([...empty.picker.hitZones()]).toHaveLength(0);
  });

  it('keeps the wheel behavior on handleMouse, including lazy-load growth', () => {
    const { picker } = makePicker({
      sessions: Array.from({ length: 6 }, (_, index) => ({
        id: `ses_${String(index)}`,
        title: `Session ${String(index)}`,
        work_dir: '/tmp/project',
        updated_at: index,
      })),
      maxVisibleSessions: 2,
      pageSize: 2, // two sessions loaded initially; scrolling lazy-loads more
    });
    const text = (): string => strip(picker.render(120).join('\n'));
    const wheel = (button: number): void => {
      picker.handleMouse({ type: 'wheel', button, col: 1, row: 1, slotRelative: false });
    };

    wheel(65);
    expect(text()).toContain('❯ Session 1');
    // Walking past the initially loaded window grows the loaded set, exactly
    // like the arrow keys.
    for (let i = 0; i < 5; i++) wheel(65);
    expect(text()).toContain('❯ Session 5');
    wheel(64);
    expect(text()).toContain('❯ Session 4');
  });
});

describe('SessionPickerComponent scrollbar zone', () => {
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
    setLocalePreference('en');
  });
  afterAll(() => {
    chalk.level = prevLevel;
    setLocalePreference('auto');
  });

  // 10 two-row cards, window 4: loaded 10 > maxVisible 4 → scrollable. Layout
  // (width 120): chrome rows 0-6, cards region rows 7-17 (2 rows per card +
  // separators), so the track is rows 7..17 on the rightmost column.
  function makeScrollablePicker() {
    return makePicker({
      sessions: Array.from({ length: 10 }, (_, index) => ({
        id: `ses_${String(index).padStart(2, '0')}`,
        title: `Session ${index}`,
        work_dir: '/tmp/project',
        updated_at: index,
      })),
    });
  }

  it('declares the zone ahead of the cards only while the list scrolls', () => {
    const { picker } = makeScrollablePicker();
    const zones = [...picker.hitZones()];
    expect(zones[0]).toMatchObject({ id: 'scrollbar', row: 7, col: 120, width: 1, height: 11 });

    const { picker: fitted } = makePicker(); // 3 sessions fit the window of 4
    expect([...fitted.hitZones()].some((zone) => zone.id === 'scrollbar')).toBe(false);
  });

  it('reveals on hover of the rightmost column and hides off it', () => {
    const { picker } = makeScrollablePicker();
    expect(strip(picker.render(120).join('\n'))).not.toContain('░');

    dispatchHover(picker, 12, 120);
    const shown = picker.render(120).map(strip);
    // Window at the top: the thumb (size 4) sits at track rows 7-10.
    for (const [row, glyph] of [
      [7, '█'],
      [10, '█'],
      [11, '░'],
      [17, '░'],
    ] as const) {
      expect(shown[row]!.endsWith(glyph)).toBe(true);
    }
    expect(shown[6]!.includes('░')).toBe(false); // the search box is not the track

    dispatchHover(picker, 12, 119);
    expect(strip(picker.render(120).join('\n'))).not.toContain('░');
  });

  it('track press maps the window to the pointed fraction', () => {
    const { picker, onSelect } = makeScrollablePicker();
    expect(strip(picker.render(120).join('\n'))).toContain('❯ Session 0');

    dispatchPress(picker, 17, 120); // track bottom → window to the end
    const text = strip(picker.render(120).join('\n'));
    expect(text).toContain('❯ Session 8'); // window top 6, cursor 6 + half window
    expect(text).toContain('Session 9');
    expect(onSelect).not.toHaveBeenCalled(); // bar presses never open a card

    // Off the bar's column the card zones keep their clicks.
    dispatchPress(picker, 16, 119);
    expect(strip(picker.render(120).join('\n'))).toContain('❯ Session 9');
  });

  it('drag maps continuously until the release', () => {
    const { picker } = makeScrollablePicker();
    dispatchPress(picker, 17, 120); // press at the bottom: selected 9
    picker.handleMouse({ type: 'motion', button: 0, col: 120, row: 7, slotRelative: false });
    expect(strip(picker.render(120).join('\n'))).toContain('❯ Session 2');
    picker.handleMouse({ type: 'release', button: 0, col: 120, row: 7, slotRelative: false });
    // Plain motion afterwards does not scroll (hover only).
    picker.handleMouse({ type: 'motion', button: 3, col: 120, row: 17, slotRelative: false });
    expect(strip(picker.render(120).join('\n'))).toContain('❯ Session 2');
  });
});

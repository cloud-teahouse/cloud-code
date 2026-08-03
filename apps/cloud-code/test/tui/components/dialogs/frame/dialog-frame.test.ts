/**
 * Unit tests for the shared dialog skeleton: layout and row math (the frame
 * counts the rows it renders — no constants), zone composition (chrome zones
 * + content zones offset by the content region's origin), the layered Esc
 * sequence, and the too-small fallback.
 */

import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hitZoneAt, type HitZone } from '@cloud-code/pi-tui';

import {
  DIALOG_SEARCH_ZONE,
  DialogFrame,
  wrapWords,
} from '#/tui/components/dialogs/frame/dialog-frame';
import { SearchableList } from '#/tui/utils/searchable-list';
import { currentTheme } from '#/tui/theme';
import { darkColors } from '#/tui/theme/colors';

const strip = (s: string): string => s.replaceAll(/\u001B\[[0-9;]*m/g, '');

describe('DialogFrame', () => {
  // The layout assertions compare visible text; disable colors so the
  // expected lines carry no SGR sequences.
  const prevLevel = chalk.level;
  const prevPalette = currentTheme.palette;
  beforeAll(() => {
    chalk.level = 0;
    currentTheme.setPalette(darkColors);
  });
  afterAll(() => {
    chalk.level = prevLevel;
    currentTheme.setPalette(prevPalette);
  });

  describe('layout and row math', () => {
    it('renders divider, title, hint, blank, content, divider', () => {
      const frame = new DialogFrame();
      const lines = frame.render(20, {
        title: 'Title',
        hintParts: ['one', 'two'],
        content: ['c1', 'c2'],
      });
      expect(lines).toEqual([
        '─'.repeat(20),
        ' Title',
        ' one · two',
        '',
        'c1',
        'c2',
        '─'.repeat(20),
      ]);
      expect(frame.contentRow).toBe(4);
    });

    it('derives the content row from the actual hint wrap, not a constant', () => {
      const frame = new DialogFrame();
      // At width 12 the hint wraps onto several lines; the content region
      // must start right after them.
      const lines = frame.render(12, {
        title: 'T',
        hintParts: ['alpha beta', 'gamma delta', 'epsilon'],
        content: ['c1'],
      });
      const hintRows = lines.slice(2, frame.contentRow - 1);
      expect(hintRows.length).toBeGreaterThan(1);
      expect(lines[frame.contentRow - 1]).toBe('');
      expect(lines[frame.contentRow]).toBe('c1');
    });

    it('indents the title and hint per the chrome config', () => {
      const frame = new DialogFrame({ titleIndent: ' ', hintIndent: '' });
      const lines = frame.render(20, { title: 'T', hintParts: ['h'], content: [] });
      expect(lines[1]).toBe(' T');
      expect(lines[2]).toBe('h');
    });

    it('applies the hint line formatter instead of the muted styling', () => {
      const frame = new DialogFrame({ formatHintLine: (line) => `<${line}>` });
      const lines = frame.render(20, { title: 'T', hintParts: ['h'], content: [] });
      expect(lines[2]).toBe('< h>');
    });

    it('wraps an ansi notice like the source text, a words notice per source line', () => {
      const frame = new DialogFrame();
      const ansi = frame.render(20, {
        title: 'T',
        hintParts: ['h'],
        notice: { text: 'word '.repeat(8).trim(), tone: 'warning', wrap: 'ansi' },
        content: ['c1'],
      });
      const words = frame.render(20, {
        title: 'T',
        hintParts: ['h'],
        notice: { text: 'first line\nsecond line is here', tone: 'success', wrap: 'words' },
        content: ['c1'],
      });
      // Both notices occupy the rows between the hint and the blank line,
      // and the content row shifts by exactly their line counts.
      expect(ansi[3]).toMatch(/^ /);
      expect(ansi[frame.contentRow]).toBe('c1');
      expect(words[3]).toBe(' first line');
      expect(words[4]).toBe(' second line is here');
      expect(words[frame.contentRow]).toBe('c1');
    });

    it('renders the tab strip and a blank between the blank and the search box', () => {
      const frame = new DialogFrame();
      const lines = frame.render(30, {
        title: 'T',
        hintParts: ['h'],
        tabStrip: { labels: ['All', 'kimi'], activeIndex: 0 },
        search: { query: '', focused: false },
        content: ['c1'],
      });
      // 0 divider, 1 title, 2 hint, 3 blank, 4 strip, 5 blank, 6-8 search, 9 content.
      expect(lines[3]).toBe('');
      expect(strip(lines[4]!)).toBe('  All   kimi ');
      expect(lines[5]).toBe('');
      expect(strip(lines[6]!)).toContain('╭');
      expect(lines[frame.contentRow]).toBe('c1');
      expect(frame.contentRow).toBe(9);
    });

    it('appends footer lines between the content and the closing divider', () => {
      const frame = new DialogFrame();
      const lines = frame.render(20, {
        title: 'T',
        hintParts: ['h'],
        content: ['c1'],
        footer: ['', 'page 1/2'],
      });
      expect(lines).toEqual([
        '─'.repeat(20),
        ' T',
        ' h',
        '',
        'c1',
        '',
        'page 1/2',
        '─'.repeat(20),
      ]);
    });
  });

  describe('zone composition', () => {
    it('offsets content zones by the content row and keeps chrome zones first', () => {
      const frame = new DialogFrame();
      frame.render(30, {
        title: 'T',
        hintParts: ['h'],
        search: { query: '', focused: false },
        content: ['c1', 'c2'],
      });
      const contentZones: HitZone[] = [
        { id: 0, row: 0, col: 1, width: 30, height: 1 },
        { id: 1, row: 1, col: 1, width: 30, height: 1 },
      ];
      const zones = frame.zones(contentZones);
      // Search zone (rows 4-6), then the two content rows (7, 8).
      expect(zones).toHaveLength(3);
      expect(zones[0]).toMatchObject({ id: DIALOG_SEARCH_ZONE, row: 4, col: 1, width: 30, height: 3 });
      expect(zones[1]).toMatchObject({ id: 0, row: 7 });
      expect(zones[2]).toMatchObject({ id: 1, row: 8 });
    });

    it('declares the search box action-only (no hover affordance)', () => {
      const frame = new DialogFrame();
      frame.render(30, {
        title: 'T',
        hintParts: ['h'],
        search: { query: '', focused: false },
        content: ['c1'],
      });
      const zones = frame.zones([]);
      expect(hitZoneAt(zones, 5, 3, 'action')?.id).toBe(DIALOG_SEARCH_ZONE);
      expect(hitZoneAt(zones, 5, 3, 'hover')).toBeNull();
    });

    it('suppresses the search zone when the box is rendered without one', () => {
      const frame = new DialogFrame();
      frame.render(30, {
        title: 'T',
        hintParts: ['h'],
        search: { query: '', focused: false, zone: false },
        content: ['c1'],
      });
      expect(frame.zones([])).toHaveLength(0);
    });

    it('declares namespaced tab zones on the strip row', () => {
      const frame = new DialogFrame();
      frame.render(30, {
        title: 'T',
        hintParts: ['h'],
        tabStrip: { labels: ['All', 'kimi'], activeIndex: 0 },
        content: ['c1'],
      });
      const zones = frame.zones([{ id: 0, row: 0, col: 1, width: 30, height: 1 }]);
      const tabs = zones.filter((zone) => typeof zone.id === 'string' && zone.id.startsWith('tab:'));
      expect(tabs.map((zone) => zone.id)).toEqual(['tab:0', 'tab:1']);
      for (const tab of tabs) expect(tab.row).toBe(4);
      // The content zone lands below the strip + blank (row 6).
      expect(zones.at(-1)).toMatchObject({ id: 0, row: 6 });
      // A hit over the first tab cell resolves to the namespaced id.
      expect(hitZoneAt(zones, 4, 3, 'action')?.id).toBe('tab:0');
    });
  });

  describe('handleEscape (layered Esc)', () => {
    const makeList = () =>
      new SearchableList<number>({ items: [1, 2, 3], toSearchText: String, searchable: true });

    it('clears the query first, running the dialog-specific bookkeeping', () => {
      const frame = new DialogFrame();
      const list = makeList();
      list.focusSearch();
      list.handleKey('x');
      const close = vi.fn();
      const afterClear = vi.fn();
      frame.handleEscape(list, close, afterClear);
      expect(list.view().query).toBe('');
      expect(afterClear).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();
      // The box stays focused after a query clear.
      expect(list.view().searchFocused).toBe(true);
    });

    it('unfocuses the search box second', () => {
      const frame = new DialogFrame();
      const list = makeList();
      list.focusSearch();
      const close = vi.fn();
      frame.handleEscape(list, close);
      expect(list.view().searchFocused).toBe(false);
      expect(close).not.toHaveBeenCalled();
    });

    it('closes the dialog last', () => {
      const frame = new DialogFrame();
      const list = makeList();
      const close = vi.fn();
      frame.handleEscape(list, close);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  describe('tooSmall', () => {
    it('returns null without a configured minimum or when large enough', () => {
      expect(new DialogFrame().tooSmall(10, 5)).toBeNull();
      const frame = new DialogFrame({ minSize: { width: 48, height: 10, message: 'too small' } });
      expect(frame.tooSmall(48, 10)).toBeNull();
      expect(frame.tooSmall(80, 24)).toBeNull();
    });

    it('renders the message once, padded to the screen height when known', () => {
      const frame = new DialogFrame({ minSize: { width: 48, height: 10, message: 'too small' } });
      expect(frame.tooSmall(40)).toEqual(['too small']);
      const padded = frame.tooSmall(40, 6);
      expect(padded).toHaveLength(6);
      expect(padded?.[0]).toBe('too small');
      // The height minimum is honored too.
      expect(frame.tooSmall(80, 5)).not.toBeNull();
    });
  });

  describe('wrapWords', () => {
    it('wraps at word boundaries and truncates an over-long word', () => {
      expect(wrapWords('alpha beta gamma', 10)).toEqual(['alpha beta', 'gamma']);
      expect(wrapWords('supercalifragilistic', 8).map(strip)).toEqual(['superca…']);
      expect(wrapWords('', 8)).toEqual([]);
    });
  });
});

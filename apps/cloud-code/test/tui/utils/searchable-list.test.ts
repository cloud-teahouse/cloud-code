import { describe, expect, it } from 'vitest';

import { SearchableList, type SearchableListOptions } from '#/tui/utils/searchable-list';

const ESC = String.fromCodePoint(27);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const PAGE_UP = `${ESC}[5~`;
const PAGE_DOWN = `${ESC}[6~`;
const HOME = `${ESC}[H`;
const END = `${ESC}[F`;
const BACKSPACE = String.fromCodePoint(127);

const ITEMS = Array.from({ length: 10 }, (_, i) => `item${String(i).padStart(2, '0')}`);

function make(over: Partial<SearchableListOptions<string>> = {}): SearchableList<string> {
  return new SearchableList<string>({
    items: ITEMS,
    toSearchText: (s) => s,
    pageSize: 4,
    ...over,
  });
}

describe('SearchableList', () => {
  it('derives page math from the cursor and pages by pageSize', () => {
    const list = make({ initialIndex: 0 });
    let v = list.view();
    expect(v.page.pageCount).toBe(3); // ceil(10 / 4)
    expect([v.page.start, v.page.end]).toEqual([0, 4]);
    expect(v.selectedIndex).toBe(0);

    list.pageDown();
    v = list.view();
    expect(v.selectedIndex).toBe(4);
    expect(v.page.page).toBe(1);

    list.pageUp();
    expect(list.view().page.page).toBe(0);
  });

  it('clamps the cursor at both ends', () => {
    const list = make({ initialIndex: 0 });
    list.moveUp(); // already at top
    expect(list.view().selectedIndex).toBe(0);

    for (let i = 0; i < 20; i++) list.moveDown();
    expect(list.view().selectedIndex).toBe(9); // last item

    list.pageDown(); // past the end stays clamped
    expect(list.view().selectedIndex).toBe(9);
  });

  it('selected() returns the item under the clamped cursor', () => {
    const list = make({ initialIndex: 2 });
    expect(list.selected()).toBe('item02');
    list.moveDown();
    expect(list.selected()).toBe('item03');
  });

  it('filters on the query, resets the cursor, and clearQuery restores the list', () => {
    const list = make({ initialIndex: 5, searchable: true });
    list.handleKey('/'); // focus the box, then type
    for (const ch of 'item09') list.handleKey(ch);

    let v = list.view();
    expect(v.query).toBe('item09');
    expect(v.items).toContain('item09');
    expect(v.items).not.toContain('item00');
    expect(v.selectedIndex).toBe(0);
    expect(list.selected()).toBe(v.items[0]);

    expect(list.clearQuery()).toBe(true);
    v = list.view();
    expect(v.query).toBe('');
    expect(v.items).toHaveLength(10);
    expect(list.clearQuery()).toBe(false); // nothing left to clear
  });

  it('trims the query on Backspace while the box is focused', () => {
    const list = make({ searchable: true });
    list.handleKey('/');
    for (const ch of 'item0') list.handleKey(ch);
    expect(list.view().query).toBe('item0');
    list.handleKey(BACKSPACE);
    expect(list.view().query).toBe('item');
  });

  it('selectIndex moves the cursor directly, clamped at both ends', () => {
    const list = make({ initialIndex: 0 });

    list.selectIndex(6);
    expect(list.view().selectedIndex).toBe(6);

    list.selectIndex(-3);
    expect(list.view().selectedIndex).toBe(0);

    list.selectIndex(99);
    expect(list.view().selectedIndex).toBe(9);
  });

  it('selectIndex clamps into the filtered range while a query is active', () => {
    const list = make({ searchable: true });
    list.handleKey('/');
    for (const ch of 'item09') list.handleKey(ch);
    expect(list.view().items).toEqual(['item09']);

    list.selectIndex(5);
    expect(list.view().selectedIndex).toBe(0);
    expect(list.selected()).toBe('item09');
  });

  it('handleKey always consumes navigation but only edits the query when searchable', () => {
    const nav = make({ searchable: false });
    expect(nav.handleKey(UP)).toBe(true);
    expect(nav.handleKey(DOWN)).toBe(true);
    expect(nav.handleKey(PAGE_UP)).toBe(true);
    expect(nav.handleKey(PAGE_DOWN)).toBe(true);
    expect(nav.handleKey('a')).toBe(false); // not searchable → printable ignored
    expect(nav.handleKey(BACKSPACE)).toBe(false);
    expect(nav.view().query).toBe('');

    const search = make({ searchable: true });
    search.handleKey('/'); // focus → typing and Backspace edit
    expect(search.handleKey('a')).toBe(true);
    expect(search.view().query).toBe('a');
    expect(search.handleKey(BACKSPACE)).toBe(true);
    expect(search.view().query).toBe('');
  });

  it('Home/End jump the cursor to the first/last item unless the box is selected', () => {
    const nav = make({ searchable: false, initialIndex: 3 });
    expect(nav.handleKey(END)).toBe(true);
    expect(nav.view().selectedIndex).toBe(ITEMS.length - 1);
    expect(nav.handleKey(HOME)).toBe(true);
    expect(nav.view().selectedIndex).toBe(0);

    // While the search box is the selected option they are inert: navigation
    // never moves the list highlight out from under a selected box.
    const search = make({ searchable: true });
    search.handleKey('/');
    expect(search.handleKey(END)).toBe(true);
    expect(search.view().selectedIndex).toBe(0);
    expect(search.view().searchFocused).toBe(true);
    expect(search.handleKey(HOME)).toBe(true);
    expect(search.view().selectedIndex).toBe(0);
    expect(search.view().searchFocused).toBe(true);
  });

  it('opens on the first item with the box unfocused; typing is inert until focused', () => {
    const list = make({ searchable: true });
    let v = list.view();
    expect(v.selectedIndex).toBe(0);
    expect(v.searchFocused).toBe(false);

    // Printable characters neither seed the query nor grab focus.
    expect(list.handleKey('a')).toBe(false);
    expect(list.handleKey('b')).toBe(false);
    v = list.view();
    expect(v.searchFocused).toBe(false);
    expect(v.query).toBe('');
    expect(v.selectedIndex).toBe(0);

    // Backspace is inert too — there is no query to edit.
    expect(list.handleKey(BACKSPACE)).toBe(false);
  });

  it('`/` focuses the box without seeding, and is ordinary text once focused', () => {
    const list = make({ searchable: true });

    expect(list.handleKey('/')).toBe(true);
    let v = list.view();
    expect(v.searchFocused).toBe(true);
    expect(v.query).toBe('');

    expect(list.handleKey('/')).toBe(true);
    v = list.view();
    expect(v.query).toBe('/');
  });

  it('typing edits the query once the box is focused', () => {
    const list = make({ searchable: true });
    list.handleKey('/');
    expect(list.handleKey('a')).toBe(true);
    const v = list.view();
    expect(v.searchFocused).toBe(true);
    expect(v.query).toBe('a');
    expect(v.selectedIndex).toBe(0); // cursor resets on edit
  });

  it('↑ from the first list item selects the box; navigation is inert while it is selected', () => {
    const list = make({ searchable: true, initialIndex: 2 });

    // Away from the first item, ↑ is plain navigation.
    expect(list.handleKey(UP)).toBe(true);
    expect(list.view().selectedIndex).toBe(1);
    expect(list.view().searchFocused).toBe(false);

    expect(list.handleKey(UP)).toBe(true);
    expect(list.view().selectedIndex).toBe(0);
    expect(list.view().searchFocused).toBe(false);

    // The box reads as the stop above the list: one more ↑ selects it.
    expect(list.handleKey(UP)).toBe(true);
    expect(list.view().searchFocused).toBe(true);
    expect(list.view().selectedIndex).toBe(0);

    // While the box is the selected option, the navigation keys never move
    // the list highlight — the box is the topmost stop, so even ↑ stays.
    for (const key of [UP, PAGE_UP, PAGE_DOWN, HOME, END]) {
      expect(list.handleKey(key)).toBe(true);
      expect(list.view().selectedIndex).toBe(0);
      expect(list.view().searchFocused).toBe(true);
    }
  });

  it('↓ from the selected box drops the selection onto the first list option', () => {
    const list = make({ searchable: true, initialIndex: 3 });
    list.handleKey('/');
    expect(list.view().searchFocused).toBe(true);

    expect(list.handleKey(DOWN)).toBe(true);
    const v = list.view();
    expect(v.searchFocused).toBe(false);
    // The first list option — not the row the cursor rested on before the box.
    expect(v.selectedIndex).toBe(0);
    expect(v.query).toBe('');

    // ↓ from there is plain navigation again.
    expect(list.handleKey(DOWN)).toBe(true);
    expect(list.view().selectedIndex).toBe(1);
  });

  it('a mouse row selection or wheel move drops the box selection', () => {
    const list = make({ searchable: true });
    list.handleKey('/');
    expect(list.view().searchFocused).toBe(true);

    // A click on a row selects the clicked option.
    list.selectIndex(4);
    expect(list.view().searchFocused).toBe(false);
    expect(list.view().selectedIndex).toBe(4);

    // A wheel tick (moveUp/moveDown) moves the highlight back into the list.
    list.focusSearch();
    expect(list.view().searchFocused).toBe(true);
    list.moveDown();
    expect(list.view().searchFocused).toBe(false);
    expect(list.view().selectedIndex).toBe(5);
  });

  it('typing filters the list while the box stays the selected option', () => {
    const list = make({ searchable: true });
    list.handleKey('/');
    for (const ch of 'item09') list.handleKey(ch);
    const v = list.view();
    expect(v.searchFocused).toBe(true);
    expect(v.query).toBe('item09');
    expect(v.items).toEqual(['item09']);
    expect(v.selectedIndex).toBe(0);
  });

  it('unfocusSearch reports the transition and gates the layered Esc', () => {
    const list = make({ searchable: true });
    expect(list.unfocusSearch()).toBe(false); // nothing to unfocus

    list.handleKey('/');
    list.handleKey('i');
    list.handleKey('t');
    // Esc layer 1: clear the query (focus kept, Claude Code style).
    expect(list.clearQuery()).toBe(true);
    expect(list.view().searchFocused).toBe(true);
    // Esc layer 2: unfocus.
    expect(list.unfocusSearch()).toBe(true);
    expect(list.view().searchFocused).toBe(false);
    // Esc layer 3 falls through to the component's cancel.
    expect(list.unfocusSearch()).toBe(false);
    // Back on the list, typing is inert again — refocus via `/`.
    expect(list.handleKey('x')).toBe(false);
    expect(list.view().query).toBe('');
    list.handleKey('/');
    list.handleKey('x');
    expect(list.view().searchFocused).toBe(true);
    expect(list.view().query).toBe('x');
  });

  it('focusSearch is a no-op for non-searchable lists', () => {
    const list = make({ searchable: false });
    list.focusSearch();
    expect(list.view().searchFocused).toBe(false);
    expect(list.unfocusSearch()).toBe(false);
    // `/` stays unconsumed so the component can bind it elsewhere.
    expect(list.handleKey('/')).toBe(false);
  });

  it('navigation consumes the key but stays put while the box is selected', () => {
    const list = make({ searchable: true, initialIndex: 0 });
    list.handleKey('/');
    expect(list.view().searchFocused).toBe(true);

    // Every navigation key is consumed, yet the highlight never moves.
    for (const key of [UP, PAGE_UP, PAGE_DOWN, HOME, END]) {
      expect(list.handleKey(key)).toBe(true);
      expect(list.view().selectedIndex).toBe(0);
      expect(list.view().searchFocused).toBe(true);
      expect(list.view().query).toBe('');
    }
  });

  it('updateItems keeps the cursor on the same key across a refresh', () => {
    const list = make({ initialIndex: 4 }); // item04
    list.updateItems(['item00', 'item04', 'item09', 'item10'], (s) => s);
    expect(list.selected()).toBe('item04');
    expect(list.view().selectedIndex).toBe(1);
  });

  it('updateItems clamps the cursor when the selected item is gone', () => {
    const list = make({ initialIndex: 9 }); // item09
    list.updateItems(['item00', 'item01'], (s) => s);
    expect(list.selected()).toBe('item01');
    expect(list.view().selectedIndex).toBe(1);
  });

  it('updateItems preserves the query and follows the key within the filtered view', () => {
    const list = make({ searchable: true });
    list.handleKey('/');
    for (const ch of 'item0') list.handleKey(ch);
    // Filtered: item00..item09; select item08 (position 8 in the filtered view).
    list.selectIndex(8);
    expect(list.selected()).toBe('item08');

    list.updateItems(['item00', 'item08', 'item09', 'item10'], (s) => s);
    const v = list.view();
    expect(v.query).toBe('item0'); // query untouched
    expect(v.items).toEqual(['item00', 'item08', 'item09', 'item10']);
    expect(list.selected()).toBe('item08');
    expect(v.selectedIndex).toBe(1);
  });

  it('updateItems keeps the search box focus state', () => {
    const list = make({ searchable: true });
    list.handleKey('/');
    list.updateItems(['item00'], (s) => s);
    expect(list.view().searchFocused).toBe(true);
  });
});

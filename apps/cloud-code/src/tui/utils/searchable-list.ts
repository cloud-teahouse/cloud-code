/**
 * Cursor + fuzzy-search + paging state machine shared by list pickers
 * (ChoicePicker, ModelSelector). Pure logic, no rendering.
 *
 * The component owns presentation and the keys that carry component-specific
 * meaning — Enter (submit), Esc (cancel), and ←/→ (paging in one picker, a
 * thinking toggle in another). This unit owns the keys that behave identically
 * everywhere: ↑/↓, PgUp/PgDn, Home/End (first/last item), and search editing.
 *
 * Search focus (the Claude Code SearchBox idiom): the search box behaves like
 * a selectable option at the top of the list. It starts unselected with the
 * first list item selected, and typing while it is unselected is inert —
 * there is no type-to-search seeding. The box is selected via `/`, a click on
 * it (components call focusSearch() from their mouse hit test), or ↑ from the
 * first list item (the box reads as the stop above the list). While the box
 * is the selected option, ↑/↓/PgUp/PgDn/Home/End never move the list
 * highlight — the box is the topmost stop, and ↓ drops the selection back
 * onto the first list option (a row click selects the clicked option) —
 * while typing edits the query and the list filters as usual. Esc is layered
 * by the component: clearQuery() → unfocusSearch() → close.
 */

import { fuzzyFilter, Key, matchesKey } from '@cloud-code/pi-tui';

import { pageView, type PageView } from './paging';
import { isPrintableChar, printableChar } from './printable-key';

const DEFAULT_PAGE_SIZE = 8;

export interface SearchableListOptions<T> {
  readonly items: readonly T[];
  /** Text a list item is fuzzy-matched against. */
  readonly toSearchText: (item: T) => string;
  /** Items per page; defaults to 8. */
  readonly pageSize?: number;
  /** Initial cursor position (clamped to >= 0). */
  readonly initialIndex?: number;
  /** When false, typed characters are ignored. Defaults to false. */
  readonly searchable?: boolean;
}

export interface SearchableListView<T> {
  /** Items after the active query filter. */
  readonly items: readonly T[];
  /** Page math for the current cursor over {@link items}. */
  readonly page: PageView;
  /** Cursor clamped into the current {@link items} range. */
  readonly selectedIndex: number;
  readonly query: string;
  /** Whether the search box is the selected option — the typing target, and
   * the state under which navigation keys never move the list highlight
   * (always false when not searchable). */
  readonly searchFocused: boolean;
}

export class SearchableList<T> {
  private items: readonly T[];
  private readonly toSearchText: (item: T) => string;
  private readonly pageSize: number;
  private readonly searchable: boolean;
  private query = '';
  private cursor: number;
  private searchFocused = false;

  constructor(opts: SearchableListOptions<T>) {
    this.items = opts.items;
    this.toSearchText = opts.toSearchText;
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    this.searchable = opts.searchable ?? false;
    this.cursor = Math.max(opts.initialIndex ?? 0, 0);
  }

  filtered(): readonly T[] {
    if (this.query.length === 0) return this.items;
    return fuzzyFilter([...this.items], this.query, this.toSearchText);
  }

  /** The item under the cursor, clamped into the filtered range. */
  selected(): T | undefined {
    const items = this.filtered();
    if (items.length === 0) return undefined;
    return items[Math.min(this.cursor, items.length - 1)];
  }

  view(): SearchableListView<T> {
    const items = this.filtered();
    return {
      items,
      page: pageView(items.length, this.cursor, this.pageSize),
      selectedIndex: Math.min(this.cursor, Math.max(0, items.length - 1)),
      query: this.query,
      searchFocused: this.searchFocused,
    };
  }

  /**
   * Selects the search box (no-op when not searchable). `/`, ↑ from the
   * first list item (see handleKey), and clicks on the box are the
   * documented selection paths.
   */
  focusSearch(): void {
    if (this.searchable) this.searchFocused = true;
  }

  /**
   * Deselects the search box, returning whether it was selected. This is the
   * middle Esc layer: components call it after clearQuery() returns false and
   * before falling through to their own cancel.
   */
  unfocusSearch(): boolean {
    if (!this.searchFocused) return false;
    this.searchFocused = false;
    return true;
  }

  // Every public cursor move drops the box selection: the callers are the
  // mouse/wheel counterparts of the arrow keys, and a moved list highlight
  // means a list option owns the selection again. The keyboard paths in
  // handleKey guard on the box selection before delegating to these.

  moveUp(): void {
    this.searchFocused = false;
    this.cursor = Math.max(0, this.cursor - 1);
  }

  moveDown(): void {
    this.searchFocused = false;
    this.cursor = Math.min(Math.max(0, this.filtered().length - 1), this.cursor + 1);
  }

  pageUp(): void {
    this.searchFocused = false;
    this.cursor = Math.max(0, this.cursor - this.pageSize);
  }

  pageDown(): void {
    this.searchFocused = false;
    this.cursor = Math.min(Math.max(0, this.filtered().length - 1), this.cursor + this.pageSize);
  }

  moveHome(): void {
    this.searchFocused = false;
    this.cursor = 0;
  }

  moveEnd(): void {
    this.searchFocused = false;
    this.cursor = Math.max(0, this.filtered().length - 1);
  }

  /**
   * Moves the cursor directly to `index`, clamped into the filtered range.
   * The mouse-press counterpart of the arrow-key moves: hit-tested rows call
   * this instead of stepping one row at a time. The clicked option becomes
   * the selected one, so a selected search box is dropped.
   */
  selectIndex(index: number): void {
    this.searchFocused = false;
    this.cursor = Math.min(Math.max(0, index), Math.max(0, this.filtered().length - 1));
  }

  /** Clears the active query and resets the cursor. Returns whether a query was cleared. */
  clearQuery(): boolean {
    if (this.query.length === 0) return false;
    this.query = '';
    this.cursor = 0;
    return true;
  }

  /**
   * Replaces the item set (e.g. a live data refresh landed) while preserving
   * the query and search focus. When `keyOf` is given, the cursor follows the
   * previously selected item's key within the filtered view; without it (or
   * when that item is gone) the cursor is clamped into the new range.
   */
  updateItems(items: readonly T[], keyOf?: (item: T) => string): void {
    const previous = keyOf === undefined ? undefined : this.selected();
    this.items = items;
    if (previous !== undefined && keyOf !== undefined) {
      const key = keyOf(previous);
      const idx = this.filtered().findIndex((item) => keyOf(item) === key);
      if (idx >= 0) {
        this.cursor = idx;
        return;
      }
    }
    this.cursor = Math.min(this.cursor, Math.max(0, this.filtered().length - 1));
  }

  /**
   * Handles the keys every picker shares: ↑/↓, PgUp/PgDn, Home/End, and —
   * when searchable — the search box selection transitions and query editing.
   * Returns true when the key was consumed. Enter, Esc, and ←/→ are
   * intentionally left to the component.
   *
   * Search box as an option: while the box is unselected, printable
   * characters are inert (returned unconsumed) except `/`, which selects the
   * box, and ↑ from the first item, which also selects it. While the box is
   * selected, printable characters append to the query (`/` included) and
   * Backspace trims it; the navigation keys never move the list highlight —
   * ↑/PgUp/PgDn/Home/End are inert (the box is the topmost stop) and ↓ drops
   * the selection onto the first list option.
   */
  handleKey(data: string): boolean {
    if (matchesKey(data, Key.up)) {
      // The box is the topmost stop: while it is selected ↑ is inert, and
      // from the first list item it selects the box.
      if (this.searchFocused) return true;
      if (this.searchable && this.cursor === 0) {
        this.searchFocused = true;
        return true;
      }
      this.moveUp();
      return true;
    }
    if (matchesKey(data, Key.down)) {
      // ↓ from the box selects the first list option.
      if (this.searchFocused) {
        this.searchFocused = false;
        this.cursor = 0;
        return true;
      }
      this.moveDown();
      return true;
    }
    if (matchesKey(data, Key.pageUp)) {
      if (this.searchFocused) return true;
      this.pageUp();
      return true;
    }
    if (matchesKey(data, Key.pageDown)) {
      if (this.searchFocused) return true;
      this.pageDown();
      return true;
    }
    if (matchesKey(data, Key.home)) {
      if (this.searchFocused) return true;
      this.moveHome();
      return true;
    }
    if (matchesKey(data, Key.end)) {
      if (this.searchFocused) return true;
      this.moveEnd();
      return true;
    }
    if (!this.searchable) return false;
    if (matchesKey(data, Key.backspace)) {
      // Backspace edits the query; with the box unselected there is nothing
      // to edit.
      if (!this.searchFocused) return false;
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.cursor = 0;
      }
      return true;
    }
    const ch = printableChar(data);
    if (isPrintableChar(ch)) {
      if (!this.searchFocused) {
        if (ch !== '/') return false;
        // The documented selection key: it selects the box instead of
        // seeding a literal '/' as the first character.
        this.searchFocused = true;
        return true;
      }
      this.query += ch;
      this.cursor = 0;
      return true;
    }
    return false;
  }
}

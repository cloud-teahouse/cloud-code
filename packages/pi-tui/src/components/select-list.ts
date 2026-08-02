import chalk from "chalk";
import { getKeybindings } from "../keybindings.ts";
import type { Component, MouseEvent } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

const normalizeToSingleLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

export interface SelectItem {
	value: string;
	label: string;
	description?: string;
}

export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
	/**
	 * Mouse-hover style for a menu row (word/choice affordance — a background
	 * highlight rather than a text underline). Defaults to underline when
	 * omitted.
	 */
	hoverText?: (text: string) => string;
}

export interface SelectListTruncatePrimaryContext {
	text: string;
	maxWidth: number;
	columnWidth: number;
	item: SelectItem;
	isSelected: boolean;
}

export interface SelectListLayoutOptions {
	minPrimaryColumnWidth?: number;
	maxPrimaryColumnWidth?: number;
	truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string;
}

export class SelectList implements Component {
	private items: SelectItem[] = [];
	private filteredItems: SelectItem[] = [];
	private selectedIndex: number = 0;
	private hoveredIndex: number | null = null;
	private maxVisible: number = 5;
	private theme: SelectListTheme;
	private layout: SelectListLayoutOptions;

	public onSelect?: (item: SelectItem) => void;
	public onCancel?: () => void;
	public onSelectionChange?: (item: SelectItem) => void;

	constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme, layout: SelectListLayoutOptions = {}) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.layout = layout;
	}

	setFilter(filter: string): void {
		this.filteredItems = this.items.filter((item) => item.value.toLowerCase().startsWith(filter.toLowerCase()));
		// Reset selection when filter changes
		this.selectedIndex = 0;
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// If no items match filter, show message
		if (this.filteredItems.length === 0) {
			lines.push(this.theme.noMatch("  No matching commands"));
			return lines;
		}

		const primaryColumnWidth = this.getPrimaryColumnWidth();

		// Calculate visible range with scrolling
		const { startIndex, endIndex } = this.visibleItemWindow();

		// Render visible items
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const descriptionSingleLine = item.description ? normalizeToSingleLine(item.description) : undefined;
			let line = this.renderItem(item, isSelected, width, descriptionSingleLine, primaryColumnWidth);
			// Hover affordance (mouse): the theme's hover style (a background
			// highlight for menu choices) or the underline default — a hovered
			// selected row keeps its selection highlight either way.
			if (i === this.hoveredIndex) line = this.theme.hoverText?.(line) ?? chalk.underline(line);
			lines.push(line);
		}

		// Add scroll indicators if needed
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredItems.length})`;
			// Truncate if too long for terminal
			lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.notifySelectionChange();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.notifySelectionChange();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (selectedItem && this.onSelect) {
				this.onSelect(selectedItem);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}

	/**
	 * Hover-to-scroll: the wheel moves the selection one row per tick.
	 * Unlike the arrow keys it clamps at the ends instead of wrapping —
	 * wrapping on a physical scroll gesture feels like the list is jumping.
	 * Left-press selects the item on the hit row; a press on the already
	 * selected row confirms it (the Enter equivalent — SGR has no double-click
	 * event, so re-click is the "open" gesture). Motion updates the hover
	 * underline. Rows are component-relative, 0-based — see MouseEvent.
	 */
	handleMouse(event: MouseEvent): void | boolean {
		if (event.type === "motion") {
			const hit = this.rowToIndex(event.row);
			if (hit === this.hoveredIndex) return false;
			this.hoveredIndex = hit;
			return;
		}
		if (event.type === "press" && event.button === 0) {
			if (this.filteredItems.length === 0) return false;
			const hit = this.rowToIndex(event.row);
			if (hit === null) return false;
			if (hit === this.selectedIndex) {
				// Re-click on the selected row confirms, like Enter.
				const selectedItem = this.filteredItems[this.selectedIndex];
				if (selectedItem && this.onSelect) {
					this.onSelect(selectedItem);
				}
				return;
			}
			this.selectedIndex = hit;
			this.notifySelectionChange();
			return;
		}
		if (event.type !== "wheel") return false;
		const delta = event.button === 64 ? -1 : event.button === 65 ? 1 : 0;
		if (delta === 0 || this.filteredItems.length === 0) return false;
		const next = Math.max(0, Math.min(this.filteredItems.length - 1, this.selectedIndex + delta));
		if (next === this.selectedIndex) return false;
		this.selectedIndex = next;
		this.notifySelectionChange();
	}

	/**
	 * The visible item window: selection centered within the maxVisible
	 * window, clamped at both ends. Shared by render() and the mouse
	 * hit-test so the items on screen and the click targets never disagree.
	 */
	protected visibleItemWindow(): { startIndex: number; endIndex: number } {
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);
		return { startIndex, endIndex };
	}

	/**
	 * Terminal rows render() emits for one item — a single row in the base
	 * list. Subclasses that paint multi-line items (e.g. wrapped
	 * descriptions) override this; the mouse hit-test walks the same counts,
	 * so a click always lands on the item that painted the row.
	 */
	protected itemRowCount(_item: SelectItem): number {
		return 1;
	}

	/**
	 * Maps a component-relative row onto an item index by walking the visible
	 * window with the per-item row counts render() paints (see itemRowCount).
	 * Returns null when the row falls outside the painted item rows (e.g. on
	 * the scroll-info line or above the list).
	 */
	private rowToIndex(row: number): number | null {
		if (row < 0 || this.filteredItems.length === 0) return null;
		const { startIndex, endIndex } = this.visibleItemWindow();
		let rows = 0;
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;
			rows += this.itemRowCount(item);
			if (row < rows) return i;
		}
		return null;
	}

	private renderItem(
		item: SelectItem,
		isSelected: boolean,
		width: number,
		descriptionSingleLine: string | undefined,
		primaryColumnWidth: number,
	): string {
		const prefix = isSelected ? "→ " : "  ";
		const prefixWidth = visibleWidth(prefix);

		if (descriptionSingleLine && width > 40) {
			const effectivePrimaryColumnWidth = Math.max(1, Math.min(primaryColumnWidth, width - prefixWidth - 4));
			const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
			const truncatedValue = this.truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimaryColumnWidth);
			const truncatedValueWidth = visibleWidth(truncatedValue);
			const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
			const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
			const remainingWidth = width - descriptionStart - 2; // -2 for safety

			if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
				const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "");
				if (isSelected) {
					return this.theme.selectedText(`${prefix}${truncatedValue}${spacing}${truncatedDesc}`);
				}

				const descText = this.theme.description(spacing + truncatedDesc);
				return prefix + truncatedValue + descText;
			}
		}

		const maxWidth = width - prefixWidth - 2;
		const truncatedValue = this.truncatePrimary(item, isSelected, maxWidth, maxWidth);
		if (isSelected) {
			return this.theme.selectedText(`${prefix}${truncatedValue}`);
		}

		return prefix + truncatedValue;
	}

	private getPrimaryColumnWidth(): number {
		// Depends only on filteredItems (replaced wholesale by setFilter, never
		// mutated in place) and layout bounds (fixed at construction). render()
		// calls this every frame while the dropdown is open, so memoize on the
		// array identity instead of re-measuring every item each frame.
		const cached = this.primaryColumnWidthCache;
		if (cached && cached.items === this.filteredItems) {
			return cached.width;
		}
		const { min, max } = this.getPrimaryColumnBounds();
		const widestPrimary = this.filteredItems.reduce((widest, item) => {
			return Math.max(widest, visibleWidth(this.getDisplayValue(item)) + PRIMARY_COLUMN_GAP);
		}, 0);

		const width = clamp(widestPrimary, min, max);
		this.primaryColumnWidthCache = { items: this.filteredItems, width };
		return width;
	}

	private primaryColumnWidthCache: { items: readonly SelectItem[]; width: number } | null = null;

	private getPrimaryColumnBounds(): { min: number; max: number } {
		const rawMin =
			this.layout.minPrimaryColumnWidth ?? this.layout.maxPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
		const rawMax =
			this.layout.maxPrimaryColumnWidth ?? this.layout.minPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;

		return {
			min: Math.max(1, Math.min(rawMin, rawMax)),
			max: Math.max(1, Math.max(rawMin, rawMax)),
		};
	}

	private truncatePrimary(item: SelectItem, isSelected: boolean, maxWidth: number, columnWidth: number): string {
		const displayValue = this.getDisplayValue(item);
		const truncatedValue = this.layout.truncatePrimary
			? this.layout.truncatePrimary({
					text: displayValue,
					maxWidth,
					columnWidth,
					item,
					isSelected,
				})
			: truncateToWidth(displayValue, maxWidth, "");

		return truncateToWidth(truncatedValue, maxWidth, "");
	}

	private getDisplayValue(item: SelectItem): string {
		return item.label || item.value;
	}

	private notifySelectionChange(): void {
		const selectedItem = this.filteredItems[this.selectedIndex];
		if (selectedItem && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}

	getSelectedItem(): SelectItem | null {
		const item = this.filteredItems[this.selectedIndex];
		return item || null;
	}
}

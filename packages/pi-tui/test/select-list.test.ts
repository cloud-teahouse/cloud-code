import assert from "node:assert";
import { describe, it } from "node:test";
import chalk from "chalk";
import { SelectList } from "../src/components/select-list.ts";
import type { MouseEvent } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";

const wheel = (button: 64 | 65): MouseEvent => ({ type: "wheel", button, col: 5, row: 3, slotRelative: false });

const testTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

const visibleIndexOf = (line: string, text: string): number => {
	const index = line.indexOf(text);
	assert.notEqual(index, -1);
	return visibleWidth(line.slice(0, index));
};

describe("SelectList", () => {
	it("normalizes multiline descriptions to single line", () => {
		const items = [
			{
				value: "test",
				label: "test",
				description: "Line one\nLine two\nLine three",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(100);

		assert.ok(rendered.length > 0);
		assert.ok(!rendered[0].includes("\n"));
		assert.ok(rendered[0].includes("Line one Line two Line three"));
	});

	it("keeps descriptions aligned when the primary text is truncated", () => {
		const items = [
			{ value: "short", label: "short", description: "short description" },
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "long description",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(80);

		assert.equal(visibleIndexOf(rendered[0], "short description"), visibleIndexOf(rendered[1], "long description"));
	});

	it("uses the configured minimum primary column width", () => {
		const items = [
			{ value: "a", label: "a", description: "first" },
			{ value: "bb", label: "bb", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		assert.equal(rendered[0].indexOf("first"), 14);
		assert.equal(rendered[1].indexOf("second"), 14);
	});

	it("uses the configured maximum primary column width", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		assert.equal(visibleIndexOf(rendered[0], "first"), 22);
		assert.equal(visibleIndexOf(rendered[1], "second"), 22);
	});

	it("allows overriding primary truncation while preserving description alignment", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 12,
			truncatePrimary: ({ text, maxWidth }) => {
				if (text.length <= maxWidth) {
					return text;
				}

				return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
			},
		});
		const rendered = list.render(80);

		assert.ok(rendered[0].includes("…"));
		assert.equal(visibleIndexOf(rendered[0], "first"), visibleIndexOf(rendered[1], "second"));
	});
});

describe("SelectList hover-to-scroll", () => {
	const items = Array.from({ length: 6 }, (_, i) => ({ value: `item-${i}`, label: `item-${i}` }));

	it("wheel moves the selection one row per tick and clamps at the ends", () => {
		const list = new SelectList(items, 5, testTheme);
		const changes: string[] = [];
		list.onSelectionChange = (item) => changes.push(item.value);

		list.handleMouse(wheel(65));
		list.handleMouse(wheel(65));
		assert.deepStrictEqual(changes, ["item-1", "item-2"]);
		for (let i = 0; i < 10; i++) list.handleMouse(wheel(65));
		// Clamped at the last item — no wrap-around on wheel.
		assert.strictEqual(changes.at(-1), "item-5");
		const count = changes.length;
		list.handleMouse(wheel(64));
		list.handleMouse(wheel(64));
		assert.strictEqual(changes.at(-1), "item-3");
		for (let i = 0; i < 10; i++) list.handleMouse(wheel(64));
		assert.strictEqual(changes.at(-1), "item-0");
		assert.ok(count < changes.length);
	});

	it("ignores release events and presses on empty lists", () => {
		const list = new SelectList(items, 5, testTheme);
		const changes: string[] = [];
		list.onSelectionChange = (item) => changes.push(item.value);
		list.handleMouse({ type: "release", button: 0, col: 5, row: 1, slotRelative: false });
		list.handleMouse({ type: "release", button: 64, col: 5, row: 3, slotRelative: false });
		const empty = new SelectList([], 5, testTheme);
		empty.onSelectionChange = (item) => changes.push(item.value);
		empty.handleMouse({ type: "press", button: 0, col: 5, row: 0, slotRelative: false });
		assert.deepStrictEqual(changes, []);

		empty.handleMouse(wheel(65)); // must not throw
	});
});


describe("SelectList click-to-select", () => {
	const items = Array.from({ length: 6 }, (_, i) => ({ value: `item-${i}`, label: `item-${i}` }));
	const press = (row: number): MouseEvent => ({ type: "press", button: 0, col: 5, row, slotRelative: false });

	it("selects the item on the hit row", () => {
		const list = new SelectList(items, 5, testTheme);
		const changes: string[] = [];
		list.onSelectionChange = (item) => changes.push(item.value);
		list.handleMouse(press(2));
		assert.deepStrictEqual(changes, ["item-2"]);
		list.handleMouse(press(0));
		assert.deepStrictEqual(changes, ["item-2", "item-0"]);
	});

	it("maps rows through the scrolled window", () => {
		const list = new SelectList(items, 5, testTheme);
		list.setSelectedIndex(5);
		// Window math: startIndex = min(5 - 2, 6 - 5) = 1 → rows show item-1..item-5.
		const changes: string[] = [];
		list.onSelectionChange = (item) => changes.push(item.value);
		list.handleMouse(press(0));
		assert.deepStrictEqual(changes, ["item-1"]);
	});

	it("ignores clicks on the scroll-info line and outside the window", () => {
		const list = new SelectList(items, 5, testTheme);
		const changes: string[] = [];
		list.onSelectionChange = (item) => changes.push(item.value);
		list.handleMouse(press(5)); // scroll-info line
		list.handleMouse(press(9)); // beyond the list
		list.handleMouse(press(-1)); // above the component
		assert.deepStrictEqual(changes, []);
	});

	it("confirms the already-selected row on re-click (Enter equivalent)", () => {
		const list = new SelectList(items, 5, testTheme);
		const changes: string[] = [];
		const selected: string[] = [];
		list.onSelectionChange = (item) => changes.push(item.value);
		list.onSelect = (item) => selected.push(item.value);
		list.handleMouse(press(1)); // selects item-1
		assert.deepStrictEqual(selected, []);
		list.handleMouse(press(1)); // re-click confirms it
		assert.deepStrictEqual(changes, ["item-1"]);
		assert.deepStrictEqual(selected, ["item-1"]);
	});
});


describe("SelectList hover underline (motion)", () => {
	const items = Array.from({ length: 6 }, (_, i) => ({ value: `item-${i}`, label: `item-${i}` }));
	const motion = (row: number): MouseEvent => ({ type: "motion", button: 3, col: 5, row, slotRelative: false });

	it("underlines the hovered row and reports unchanged cells", () => {
		const previousLevel = chalk.level;
		chalk.level = 1;
		try {
			const list = new SelectList(items, 5, testTheme);
			const baseline = list.render(80);
			assert.ok(!baseline.join("\n").includes("\x1b[4m"), "no underline without a mouse");

			assert.notStrictEqual(list.handleMouse(motion(2)), false);
			const hovered = list.render(80);
			assert.ok(hovered[2]!.includes("\x1b[4m"), "hovered row is underlined");
			assert.ok(!hovered[1]!.includes("\x1b[4m"), "other rows are not");

			// Same cell again: unchanged — the TUI skips the re-render.
			assert.strictEqual(list.handleMouse(motion(2)), false);

			// Moving off the list (scroll-info line, then above the component) clears.
			assert.notStrictEqual(list.handleMouse(motion(9)), false);
			assert.deepStrictEqual(list.render(80), baseline);
			list.handleMouse(motion(2));
			assert.notStrictEqual(list.handleMouse(motion(-1)), false);
			assert.deepStrictEqual(list.render(80), baseline);
		} finally {
			chalk.level = previousLevel;
		}
	});

	it("maps motion rows through the scrolled window like presses", () => {
		const list = new SelectList(items, 5, testTheme);
		list.setSelectedIndex(5);
		// Window: rows show item-1..item-5, so row 0 hovers item-1, not item-0.
		list.handleMouse(motion(0));
		const rendered = list.render(80);
		assert.ok(rendered[0]!.includes("item-1"));
	});

	it("does not move the selection on motion", () => {
		const list = new SelectList(items, 5, testTheme);
		const changes: string[] = [];
		list.onSelectionChange = (item) => changes.push(item.value);
		list.handleMouse(motion(3));
		assert.deepStrictEqual(changes, []);
	});

	it("uses the theme's hoverText for the hovered row when provided", () => {
		const list = new SelectList(items, 5, { ...testTheme, hoverText: (text) => `[H]${text}` });
		const baseline = list.render(80);
		assert.ok(!baseline.join("\n").includes("[H]"), "no hover style without a mouse");

		assert.notStrictEqual(list.handleMouse(motion(2)), false);
		const hovered = list.render(80);
		assert.ok(hovered[2]!.startsWith("[H]"), "hovered row paints hoverText");
		assert.ok(!hovered[2]!.includes("\x1b[4m"), "hoverText replaces the underline default");
		assert.ok(!hovered[1]!.includes("[H]"), "other rows are plain");

		// Clearing the hover restores the byte-identical baseline.
		list.handleMouse(motion(-1));
		assert.deepStrictEqual(list.render(80), baseline);
	});
});

describe("SelectList variable-height rows", () => {
	// Items paint two terminal rows each; the subclass reports the same count
	// through itemRowCount, and the hit-test must walk those rows — a click on
	// an item's second row belongs to that item, not the next one.
	class TwoRowList extends SelectList {
		override render(width: number): string[] {
			return super.render(width).flatMap((line) => [line, line]);
		}
		protected override itemRowCount(): number {
			return 2;
		}
	}
	const items = Array.from({ length: 6 }, (_, i) => ({ value: `item-${i}`, label: `item-${i}` }));
	const press = (row: number): MouseEvent => ({ type: "press", button: 0, col: 5, row, slotRelative: false });

	it("maps both painted rows of an item to that item", () => {
		const list = new TwoRowList(items, 5, testTheme);
		list.handleMouse(press(0)); // first row of item-0
		assert.strictEqual(list.getSelectedItem()?.value, "item-0");
		// Second painted row of item-0: one-row-per-item math would read item-1.
		list.handleMouse(press(1));
		assert.strictEqual(list.getSelectedItem()?.value, "item-0");
		list.handleMouse(press(2)); // first row of item-1
		assert.strictEqual(list.getSelectedItem()?.value, "item-1");
		list.handleMouse(press(3)); // second row of item-1
		assert.strictEqual(list.getSelectedItem()?.value, "item-1");
	});

	it("hits the last visible item and ignores rows past the painted items", () => {
		const list = new TwoRowList(items, 5, testTheme);
		const changes: string[] = [];
		list.onSelectionChange = (item) => changes.push(item.value);
		list.handleMouse(press(9)); // second row of item-4, the last visible item
		assert.deepStrictEqual(changes, ["item-4"]);
		list.handleMouse(press(10)); // scroll-info line
		list.handleMouse(press(20)); // beyond everything
		assert.deepStrictEqual(changes, ["item-4"]);
	});

	it("maps rows through the scrolled window with per-item heights", () => {
		const list = new TwoRowList(items, 5, testTheme);
		list.setSelectedIndex(5);
		// Window: startIndex = min(5 - 2, 6 - 5) = 1 → rows show item-1..item-5,
		// two rows each, so row 0 is item-1's first row, not item-0.
		const changes: string[] = [];
		list.onSelectionChange = (item) => changes.push(item.value);
		list.handleMouse(press(0));
		assert.deepStrictEqual(changes, ["item-1"]);

		// The click re-centers the window on the new selection (startIndex 0).
		// Move it back to the end: window 1..5, item-5's rows are 8-9, and a
		// click on the already-selected last item confirms it.
		list.setSelectedIndex(5);
		const selected: string[] = [];
		list.onSelect = (item) => selected.push(item.value);
		list.handleMouse(press(8)); // first row of item-5
		assert.deepStrictEqual(selected, ["item-5"]);
	});

	it("confirms the already-selected item when its second row is re-clicked", () => {
		const list = new TwoRowList(items, 5, testTheme);
		const selected: string[] = [];
		list.onSelect = (item) => selected.push(item.value);
		list.handleMouse(press(3)); // selects item-1 via its second row
		list.handleMouse(press(3)); // re-click on the same row confirms item-1
		assert.deepStrictEqual(selected, ["item-1"]);
	});
});

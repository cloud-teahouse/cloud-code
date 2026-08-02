import assert from "node:assert";
import { describe, it } from "node:test";
import { visibleWidth } from "../src/utils.ts";
import {
	drawScrollbar,
	MIN_TRACK_ROWS,
	Scrollbar,
	scrollbarThumb,
	scrollTopForThumbOffset,
	scrollTopForTrackRow,
} from "../src/scrollbar.ts";

describe("scrollbarThumb", () => {
	it("returns null when the content fits the viewport", () => {
		assert.strictEqual(scrollbarThumb({ scrollTop: 0, viewport: 10, content: 10 }, 10), null);
		assert.strictEqual(scrollbarThumb({ scrollTop: 0, viewport: 10, content: 5 }, 10), null);
	});

	it("returns null for tracks shorter than MIN_TRACK_ROWS", () => {
		const metrics = { scrollTop: 0, viewport: 2, content: 100 };
		assert.strictEqual(scrollbarThumb(metrics, MIN_TRACK_ROWS - 1), null);
		assert.notStrictEqual(scrollbarThumb(metrics, MIN_TRACK_ROWS), null);
	});

	it("sizes the thumb proportionally to viewport/content", () => {
		const thumb = scrollbarThumb({ scrollTop: 0, viewport: 50, content: 100 }, 10);
		assert.deepStrictEqual(thumb, { offset: 0, size: 5 });
	});

	it("enforces a minimum thumb size of one row", () => {
		const thumb = scrollbarThumb({ scrollTop: 0, viewport: 1, content: 1000 }, 5);
		assert.deepStrictEqual(thumb, { offset: 0, size: 1 });
	});

	it("pins the thumb to the track ends at the scroll limits", () => {
		const metrics = { viewport: 9, content: 30 }; // maxScroll 21, size 3 on a 9-row track
		assert.deepStrictEqual(scrollbarThumb({ ...metrics, scrollTop: 0 }, 9), { offset: 0, size: 3 });
		assert.deepStrictEqual(scrollbarThumb({ ...metrics, scrollTop: 21 }, 9), { offset: 6, size: 3 });
	});

	it("places the thumb proportionally between the ends", () => {
		// size 3, track 9 → travel 6; half of maxScroll → offset 3.
		const thumb = scrollbarThumb({ scrollTop: 10, viewport: 9, content: 29 }, 9);
		assert.deepStrictEqual(thumb, { offset: 3, size: 3 });
	});

	it("clamps an out-of-range scrollTop", () => {
		const thumb = scrollbarThumb({ scrollTop: 999, viewport: 9, content: 30 }, 9);
		assert.deepStrictEqual(thumb, { offset: 6, size: 3 });
	});
});

describe("scrollTopForThumbOffset", () => {
	// size round(11*10/110) = 1 → travel 10; maxScroll 100.
	const metrics = { scrollTop: 0, viewport: 10, content: 110 };

	it("is the inverse of the thumb offset mapping", () => {
		assert.strictEqual(scrollTopForThumbOffset(metrics, 11, 0), 0);
		assert.strictEqual(scrollTopForThumbOffset(metrics, 11, 5), 50);
		assert.strictEqual(scrollTopForThumbOffset(metrics, 11, 10), 100);
	});

	it("round-trips the thumb placement", () => {
		const thumb = scrollbarThumb({ ...metrics, scrollTop: 70 }, 11);
		assert.strictEqual(scrollTopForThumbOffset(metrics, 11, thumb!.offset), 70);
	});

	it("clamps offsets outside the travel (drag running past an edge)", () => {
		assert.strictEqual(scrollTopForThumbOffset(metrics, 11, -3), 0);
		assert.strictEqual(scrollTopForThumbOffset(metrics, 11, 99), 100);
	});

	it("returns 0 when the thumb fills the track or there is nothing to scroll", () => {
		// size round(3*10/12) = 3 = track → travel 0.
		assert.strictEqual(scrollTopForThumbOffset({ scrollTop: 0, viewport: 10, content: 12 }, 3, 1), 0);
		assert.strictEqual(scrollTopForThumbOffset({ scrollTop: 0, viewport: 10, content: 10 }, 11, 5), 0);
	});
});

describe("scrollTopForTrackRow", () => {
	const metrics = { scrollTop: 0, viewport: 10, content: 110 }; // maxScroll 100

	it("maps the track ends to the scroll limits", () => {
		assert.strictEqual(scrollTopForTrackRow(metrics, 11, 0), 0);
		assert.strictEqual(scrollTopForTrackRow(metrics, 11, 10), 100);
	});

	it("maps the middle of the track to the middle of the content", () => {
		assert.strictEqual(scrollTopForTrackRow(metrics, 11, 5), 50);
	});

	it("clamps rows outside the track (drag running past an edge)", () => {
		assert.strictEqual(scrollTopForTrackRow(metrics, 11, -3), 0);
		assert.strictEqual(scrollTopForTrackRow(metrics, 11, 99), 100);
	});

	it("returns 0 when there is nothing to scroll", () => {
		assert.strictEqual(scrollTopForTrackRow({ scrollTop: 0, viewport: 10, content: 10 }, 11, 5), 0);
	});
});

describe("Scrollbar state", () => {
	it("reveals on hover and hides when the pointer leaves", () => {
		const bar = new Scrollbar();
		assert.strictEqual(bar.engaged, false);
		assert.strictEqual(bar.hover(true), true, "reveal changed");
		assert.strictEqual(bar.engaged, true);
		assert.strictEqual(bar.hover(true), false, "no change → no re-render");
		assert.strictEqual(bar.hover(false), true);
		assert.strictEqual(bar.engaged, false);
	});

	it("stays revealed through a drag even off the column", () => {
		const bar = new Scrollbar();
		bar.hover(true);
		bar.press(0, { scrollTop: 0, viewport: 10, content: 110 }, 11);
		assert.strictEqual(bar.dragging, true);
		assert.strictEqual(bar.hover(false), true, "hover ends…");
		assert.strictEqual(bar.engaged, true, "…but the drag keeps the bar visible");
		bar.release();
		assert.strictEqual(bar.dragging, false);
		assert.strictEqual(bar.engaged, false);
	});

	it("track press jumps absolutely and the drag continues absolutely", () => {
		const bar = new Scrollbar();
		// scrollTop 0 → thumb (size 1) at row 0, so row 5 is the bare track.
		const metrics = { scrollTop: 0, viewport: 10, content: 110 };
		assert.strictEqual(bar.press(5, metrics, 11), 50);
		assert.strictEqual(bar.dragSession?.grabbedThumb, false);
		assert.strictEqual(bar.drag(2), 20);
		assert.strictEqual(bar.drag(10), 100);
	});

	it("thumb press holds the position and the drag tracks 1:1 from the grab", () => {
		const bar = new Scrollbar();
		// size round(10*50/100) = 5, travel 5, offset round(5*30/50) = 3 →
		// the thumb sits at rows 3..7; grabbing row 5 anchors mid-thumb.
		const metrics = { scrollTop: 30, viewport: 50, content: 100 };
		assert.strictEqual(bar.press(5, metrics, 10), 30, "no jump on a thumb grab");
		assert.strictEqual(bar.dragSession?.grabbedThumb, true);
		// Pointer row − grab offset (2) = thumb top; the inverse mapping lands
		// the scroll offset (maxScroll 50).
		assert.strictEqual(bar.drag(4), 20);
		assert.strictEqual(bar.drag(6), 40);
		assert.strictEqual(bar.drag(5), 30, "back to the grab point restores it");
	});

	it("clamps the grab-drag at the track ends", () => {
		const bar = new Scrollbar();
		const metrics = { scrollTop: 30, viewport: 50, content: 100 };
		bar.press(5, metrics, 10); // grab offset 2 (see above)
		assert.strictEqual(bar.drag(0), 0, "thumb top clamps to the track top");
		assert.strictEqual(bar.drag(99), 50, "thumb top clamps to the travel");
	});

	it("maps the whole drag against the session captured at press", () => {
		const bar = new Scrollbar();
		assert.strictEqual(bar.dragSession, null);
		const metrics = { scrollTop: 0, viewport: 10, content: 110 };
		bar.press(5, metrics, 11);
		assert.deepStrictEqual(bar.dragSession, {
			content: 110,
			viewport: 10,
			trackHeight: 11,
			grabbedThumb: false,
		});
		// drag() takes no metrics: per-motion events cannot re-derive them.
		assert.strictEqual(bar.drag(7), 70);
		bar.release();
		assert.strictEqual(bar.dragSession, null, "release drops the snapshot");
		// A new press captures a fresh session (the old one is gone).
		bar.press(0, { scrollTop: 0, viewport: 2, content: 100 }, 5);
		assert.strictEqual(bar.dragSession?.content, 100);
		bar.release();
	});
});

describe("drawScrollbar", () => {
	const thumb = { offset: 1, size: 2 };

	it("draws the track on every row and the thumb on its rows", () => {
		const out = drawScrollbar(["a", "b", "c", "d"], 10, thumb);
		assert.deepStrictEqual(
			out.map((line) => line.at(-1)),
			["░", "█", "█", "░"],
		);
	});

	it("lands the glyph on the exact column for short and ANSI-styled lines", () => {
		const out = drawScrollbar(["short", "", "\x1b[31mred\x1b[39m"], 10, thumb);
		for (const line of out) {
			assert.strictEqual(visibleWidth(line), 10, JSON.stringify(line));
		}
		assert.ok(out[2]!.startsWith("\x1b[31mred\x1b[39m"), "styling kept");
	});

	it("truncates lines longer than the column instead of overflowing", () => {
		const out = drawScrollbar(["x".repeat(30)], 10, { offset: 0, size: 1 });
		assert.strictEqual(visibleWidth(out[0]!), 10);
		assert.ok(out[0]!.endsWith("█"));
	});

	it("applies the style hook to the glyphs", () => {
		const out = drawScrollbar(["a", "b"], 2, { offset: 0, size: 1 }, {
			track: (g) => `<${g}>`,
			thumb: (g) => `[${g}]`,
		});
		assert.strictEqual(out[0], "a[█]");
		assert.strictEqual(out[1], "b<░>");
	});
});

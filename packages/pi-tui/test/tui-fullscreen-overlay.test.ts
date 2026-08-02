import assert from "node:assert";
import { describe, it } from "node:test";
import {
	type Component,
	Container,
	type Focusable,
	type MouseEvent,
	TUI,
} from "../src/tui.ts";
import type { HitZone, HitZoneId } from "../src/hit-zones.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class FocusableComponent extends TestComponent implements Focusable {
	focused = false;
	input: string[] = [];
	handleInput(data: string): void {
		this.input.push(data);
	}
}

class MouseAwareComponent extends FocusableComponent {
	mouse: MouseEvent[] = [];
	override handleMouse(event: MouseEvent): void {
		this.mouse.push(event);
	}
}

class ZoneComponent extends FocusableComponent {
	zones: HitZone[] = [];
	hits: { id: HitZoneId; row: number; col: number }[] = [];
	hovers: (HitZoneId | null)[] = [];
	hitZones(): Iterable<HitZone> {
		return this.zones;
	}
	onHitZone(id: HitZoneId, event: MouseEvent): void {
		this.hits.push({ id, row: event.row, col: event.col });
	}
	setHoveredZone(id: HitZoneId | null): void {
		this.hovers.push(id);
	}
}

/** Chrome container mirroring the editor-slot presentation: a separator row
 * above the children plus a one-column left gutter. */
class ChromeContainer extends Container {
	override rowsBeforeChild(): number {
		return 1;
	}
	override leftInset(): number {
		return 1;
	}
	override render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		const out = [" " + "▔".repeat(inner)];
		for (const child of this.children) {
			for (const line of child.render(inner)) out.push(" " + line);
		}
		return out;
	}
}

function makeLines(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);
}

async function render(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await terminal.waitForRender();
}

/** Fullscreen TUI (80x10): 30-line transcript above a fixed bottom slot. */
async function setupFullscreen(
	slot: Component,
	columns = 80,
	rows = 10,
): Promise<{ tui: TUI; terminal: VirtualTerminal; scroll: TestComponent }> {
	const terminal = new VirtualTerminal(columns, rows);
	const tui = new TUI(terminal);
	const scroll = new TestComponent();
	const root = new Container();
	root.addChild(scroll);
	root.addChild(slot);
	tui.addChild(root);
	tui.setFullscreen(true);
	tui.setLayoutRegions({ scroll, slot });
	tui.start();
	scroll.lines = makeLines("msg", 30);
	await render(tui, terminal);
	return { tui, terminal, scroll };
}

describe("fullscreen overlays", () => {
	it("anchors bottom, covers opaquely, and leaves the base frame unmoved", async () => {
		const slot = new TestComponent();
		slot.lines = ["slot-1", "slot-2"];
		const { tui, terminal } = await setupFullscreen(slot);
		const baseline = terminal.getViewport();
		// 10 rows, slot 2 → viewport rows 0..7 = msg-23..msg-30, rows 8..9 = slot.
		assert.strictEqual(baseline[0], "msg-23");
		assert.strictEqual(baseline[8], "slot-1");

		const dialog = new TestComponent();
		dialog.lines = makeLines("ov", 3);
		tui.showOverlay(dialog, { width: "100%", anchor: "bottom-left" });
		await terminal.waitForRender();
		const covered = terminal.getViewport();

		// Rows above the overlay are byte-identical: the slot never grew and the
		// transcript viewport did not shift.
		for (let i = 0; i <= 6; i++) {
			assert.strictEqual(covered[i], baseline[i], `row ${i} moved`);
		}
		// The bottom three rows are the overlay's, opaquely: no base text bleeds.
		// (Rows are padded to full width with blanks — that padding IS the opaque
		// cover replacing the base row.)
		assert.strictEqual(covered[7]!.trimEnd(), "ov-1");
		assert.strictEqual(covered[8]!.trimEnd(), "ov-2");
		assert.strictEqual(covered[9]!.trimEnd(), "ov-3");
		assert.strictEqual(covered[7]!.length, 80, "overlay row pads to full width");
		assert.ok(!covered.some((line) => line.includes("slot-1") || line.includes("msg-30")));
	});

	it("translates presses into the overlay frame and drops presses outside it", async () => {
		const slot = new TestComponent();
		slot.lines = ["slot-1"];
		const { tui, terminal } = await setupFullscreen(slot);
		const dialog = new MouseAwareComponent();
		dialog.lines = makeLines("ov", 3);
		tui.showOverlay(dialog, { width: "100%", anchor: "bottom-left" });
		await terminal.waitForRender();
		// rect: rows 7..9 (0-based), full width.

		terminal.sendInput("\x1b[<0;10;9M"); // row 9 (1-based) → overlay row 1
		await terminal.waitForRender();
		assert.strictEqual(dialog.mouse.length, 1);
		assert.strictEqual(dialog.mouse[0]!.row, 1);
		assert.strictEqual(dialog.mouse[0]!.col, 10);
		assert.strictEqual(dialog.mouse[0]!.slotRelative, false);

		// Transcript row above the overlay: modal — never reaches the dialog.
		terminal.sendInput("\x1b[<0;10;3M");
		await terminal.waitForRender();
		assert.strictEqual(dialog.mouse.length, 1, "press outside the rect must be dropped");
	});

	it("routes zone presses through container chrome (separator row + gutter)", async () => {
		const slot = new TestComponent();
		slot.lines = ["slot-1"];
		const { tui, terminal } = await setupFullscreen(slot);
		const child = new ZoneComponent();
		child.lines = makeLines("item", 2);
		child.zones = [{ id: "row0", row: 0, col: 1, width: 10, height: 1 }];
		const surface = new ChromeContainer();
		surface.addChild(child);
		tui.showOverlay(surface, { width: "100%", anchor: "bottom-left" });
		await terminal.waitForRender();
		// surface = separator + 2 items = 3 rows at 0-based rows 7..9; the
		// child's first line sits at screen row 8 (event row 9), its zone cols
		// shifted one cell right by the gutter (event cols 2..11).

		terminal.sendInput("\x1b[<0;5;9M");
		await terminal.waitForRender();
		assert.strictEqual(child.hits.length, 1);
		// Re-translated into the child's own frame (chrome stripped).
		assert.deepStrictEqual(child.hits[0], { id: "row0", row: 0, col: 4 });

		// The gutter column is chrome: no zone there, nothing dispatched.
		terminal.sendInput("\x1b[<0;1;9M");
		await terminal.waitForRender();
		assert.strictEqual(child.hits.length, 1, "gutter press must not hit a zone");

		// The separator row is chrome too.
		terminal.sendInput("\x1b[<0;5;8M");
		await terminal.waitForRender();
		assert.strictEqual(child.hits.length, 1, "separator press must not hit a zone");
	});

	it("keeps the scroll badge from firing through a covering overlay", async () => {
		const slot = new TestComponent();
		slot.lines = ["slot-1"];
		const { tui, terminal } = await setupFullscreen(slot);
		tui.scrollBy(-6);
		await terminal.waitForRender();
		assert.ok(!tui.isFollowingOutput());
		// Viewport is 9 rows: the badge sits on event row 9 — covered by the
		// 3-row overlay (0-based rows 7..9).
		const dialog = new MouseAwareComponent();
		dialog.lines = makeLines("ov", 3);
		tui.showOverlay(dialog, { width: "100%", anchor: "bottom-left" });
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;79;9M"); // on the badge, inside the overlay rect
		await terminal.waitForRender();
		assert.ok(!tui.isFollowingOutput(), "covered badge must not jump to bottom");
		assert.strictEqual(dialog.mouse.length, 1, "the overlay owns the covered row");
	});

	it("routes the wheel by hover: inside the rect to the dialog, outside to the transcript", async () => {
		const slot = new TestComponent();
		slot.lines = ["slot-1"];
		const { tui, terminal } = await setupFullscreen(slot);
		assert.strictEqual(terminal.getViewport()[0], "msg-22"); // viewport = 9 rows
		const dialog = new MouseAwareComponent();
		dialog.lines = makeLines("ov", 3);
		tui.showOverlay(dialog, { width: "100%", anchor: "bottom-left" });
		await terminal.waitForRender();

		// Inside the rect (event row 8): the dialog receives a translated event
		// and the transcript stays pinned.
		terminal.sendInput("\x1b[<64;10;8M");
		await terminal.waitForRender();
		assert.strictEqual(dialog.mouse.length, 1);
		assert.strictEqual(dialog.mouse[0]!.type, "wheel");
		assert.strictEqual(dialog.mouse[0]!.row, 0);
		assert.strictEqual(terminal.getViewport()[0], "msg-22");

		// Outside the rect (transcript row 3): transcript scrolls, dialog silent.
		terminal.sendInput("\x1b[<64;10;3M");
		await terminal.waitForRender();
		assert.strictEqual(dialog.mouse.length, 1);
		assert.strictEqual(terminal.getViewport()[0], "msg-19");
	});

	it("tracks hover zones through the overlay and clears them outside the rect", async () => {
		const slot = new TestComponent();
		slot.lines = ["slot-1"];
		const { tui, terminal } = await setupFullscreen(slot);
		const child = new ZoneComponent();
		child.lines = makeLines("item", 2);
		child.zones = [{ id: "row0", row: 0, col: 1, width: 10, height: 1 }];
		const surface = new ChromeContainer();
		surface.addChild(child);
		tui.showOverlay(surface, { width: "100%", anchor: "bottom-left" });
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<35;5;9M"); // motion over the zone
		await terminal.waitForRender();
		assert.deepStrictEqual(child.hovers, ["row0"]);

		terminal.sendInput("\x1b[<35;5;3M"); // motion above the overlay
		await terminal.waitForRender();
		assert.deepStrictEqual(child.hovers, ["row0", null]);
	});

	it("honours the visible predicate: no frame, no hits", async () => {
		const slot = new TestComponent();
		slot.lines = ["slot-1"];
		const { tui, terminal } = await setupFullscreen(slot);
		const dialog = new MouseAwareComponent();
		dialog.lines = makeLines("ov", 3);
		tui.showOverlay(dialog, { width: "100%", anchor: "bottom-left", visible: () => false });
		await terminal.waitForRender();
		const viewport = terminal.getViewport();
		assert.ok(!viewport.some((line) => line.includes("ov-1")), "hidden overlay must not render");
		assert.strictEqual(viewport[8], "msg-30");

		// A press where the overlay would be falls to the underlay, not the dialog.
		terminal.sendInput("\x1b[<0;10;9M");
		await terminal.waitForRender();
		assert.strictEqual(dialog.mouse.length, 0);
	});

	it("captures focus on show and restores it on hide", async () => {
		const editor = new FocusableComponent();
		editor.lines = ["editor"];
		const { tui, terminal } = await setupFullscreen(editor);
		tui.setFocus(editor);
		const dialog = new FocusableComponent();
		dialog.lines = makeLines("ov", 2);
		const handle = tui.showOverlay(dialog, { width: "100%", anchor: "bottom-left" });
		await terminal.waitForRender();

		terminal.sendInput("a");
		await terminal.waitForRender();
		assert.deepStrictEqual(dialog.input, ["a"]);
		assert.deepStrictEqual(editor.input, []);

		handle.hide();
		await terminal.waitForRender();
		terminal.sendInput("b");
		await terminal.waitForRender();
		assert.deepStrictEqual(editor.input, ["b"]);
		assert.deepStrictEqual(dialog.input, ["a"]);
	});
});

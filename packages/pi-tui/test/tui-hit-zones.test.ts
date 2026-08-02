import assert from "node:assert";
import { describe, it } from "node:test";
import { hasHitZones, hitZoneAt, type HitZone, type HitZoneId } from "../src/hit-zones.ts";
import { type Component, Container, type MouseEvent, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class FocusableComponent extends TestComponent {
	focused = false;
	input: string[] = [];
	handleInput(data: string): void {
		this.input.push(data);
	}
}

/**
 * Component that declares hit zones and logs every dispatch channel:
 * zone presses, zone hover changes, and the legacy handleMouse fallback.
 */
class ZoneComponent extends FocusableComponent {
	zones: HitZone[] = [];
	hits: { id: HitZoneId; row: number; col: number }[] = [];
	hovers: (HitZoneId | null)[] = [];
	mouse: MouseEvent[] = [];
	/** When false, onHitZone/setHoveredZone report "unchanged" (skip render). */
	accept = true;
	hitZones(): Iterable<HitZone> {
		return this.zones;
	}
	onHitZone(id: HitZoneId, event: MouseEvent): void | boolean {
		this.hits.push({ id, row: event.row, col: event.col });
		return this.accept ? undefined : false;
	}
	setHoveredZone(id: HitZoneId | null): void | boolean {
		this.hovers.push(id);
		return this.accept ? undefined : false;
	}
	handleMouse(event: MouseEvent): void | boolean {
		this.mouse.push(event);
		return this.accept ? undefined : false;
	}
}

function makeLines(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);
}

/** Fullscreen TUI with a 30-line transcript and `panel` as the only slot child. */
async function setupSlotPanel(
	panel: Component,
	columns = 80,
	rows = 10,
): Promise<{ tui: TUI; terminal: VirtualTerminal; scroll: TestComponent }> {
	const terminal = new VirtualTerminal(columns, rows);
	const tui = new TUI(terminal);
	const scroll = new TestComponent();
	const slot = new Container();
	slot.addChild(panel);
	const root = new Container();
	root.addChild(scroll);
	root.addChild(slot);
	tui.addChild(root);
	tui.setFullscreen(true);
	tui.setLayoutRegions({ scroll, slot });
	tui.setFocus(panel);
	tui.start();
	scroll.lines = makeLines("msg", 30);
	tui.requestRender(true);
	await terminal.waitForRender();
	return { tui, terminal, scroll };
}

describe("hit zone dispatch", () => {
	it("dispatches a press inside a declared zone to onHitZone with the zone id", async () => {
		const panel = new ZoneComponent();
		panel.lines = makeLines("panel", 3);
		panel.zones = [{ id: "approve", row: 1, col: 2, width: 10, height: 1 }];
		const { terminal } = await setupSlotPanel(panel);

		// Slot pins to rows 8-10; the panel's zone row 1 is terminal row 9.
		terminal.sendInput("\x1b[<0;5;9M");
		await terminal.waitForRender();
		assert.strictEqual(panel.hits.length, 1);
		assert.strictEqual(panel.hits[0]!.id, "approve");
		assert.strictEqual(panel.hits[0]!.row, 1);
		assert.strictEqual(panel.hits[0]!.col, 5);
		assert.strictEqual(panel.mouse.length, 0, "in-zone presses never reach handleMouse");
	});

	it("falls back to handleMouse for presses outside every zone", async () => {
		const panel = new ZoneComponent();
		panel.lines = makeLines("panel", 3);
		panel.zones = [{ id: "approve", row: 1, col: 2, width: 10, height: 1 }];
		const { terminal } = await setupSlotPanel(panel);

		// Same row, one cell left of the zone — and a different row entirely.
		terminal.sendInput("\x1b[<0;1;9M");
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;5;8M");
		await terminal.waitForRender();
		assert.strictEqual(panel.hits.length, 0);
		assert.strictEqual(panel.mouse.length, 2);
		assert.strictEqual(panel.mouse[0]!.col, 1);
		assert.strictEqual(panel.mouse[1]!.row, 0);
	});

	it("keeps the raw handleMouse path for zone-less components", async () => {
		class PlainPanel extends FocusableComponent {
			mouse: MouseEvent[] = [];
			handleMouse(event: MouseEvent): void {
				this.mouse.push(event);
			}
		}
		const panel = new PlainPanel();
		panel.lines = makeLines("panel", 3);
		const { terminal } = await setupSlotPanel(panel);

		terminal.sendInput("\x1b[<0;5;9M");
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<35;6;9M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 2);
		assert.strictEqual(panel.mouse[0]!.type, "press");
		assert.strictEqual(panel.mouse[1]!.type, "motion");
	});

	it("falls back to handleMouse when the zone owner has no onHitZone", async () => {
		class DeclareOnlyPanel extends FocusableComponent {
			zones: HitZone[] = [];
			mouse: MouseEvent[] = [];
			hitZones(): Iterable<HitZone> {
				return this.zones;
			}
			handleMouse(event: MouseEvent): void {
				this.mouse.push(event);
			}
		}
		const panel = new DeclareOnlyPanel();
		panel.lines = makeLines("panel", 3);
		panel.zones = [{ id: "approve", row: 1, col: 2, width: 10, height: 1 }];
		const { terminal } = await setupSlotPanel(panel);

		// A zone without a press handler is transparent: the press keeps the
		// legacy path instead of being swallowed by the zone lookup.
		terminal.sendInput("\x1b[<0;5;9M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 1);
		assert.strictEqual(panel.mouse[0]!.row, 1);
	});

	it("honors per-zone semantics: action:false skips dispatch, hover:false skips hover", async () => {
		const panel = new ZoneComponent();
		panel.lines = makeLines("panel", 3);
		panel.zones = [
			{ id: "pressless", row: 0, col: 1, width: 10, height: 1, semantics: { action: false } },
			{ id: "hoverless", row: 1, col: 1, width: 10, height: 1, semantics: { hover: false } },
		];
		const { terminal } = await setupSlotPanel(panel);

		terminal.sendInput("\x1b[<0;5;8M"); // press in the action:false zone
		await terminal.waitForRender();
		assert.strictEqual(panel.hits.length, 0);
		assert.strictEqual(panel.mouse.length, 1, "press fell back to handleMouse");

		terminal.sendInput("\x1b[<35;5;9M"); // motion over the hover:false zone
		await terminal.waitForRender();
		assert.strictEqual(panel.hovers.length, 0);
	});

	it("tracks hover across zones: enter, move, leave, with per-cell dedupe", async () => {
		const panel = new ZoneComponent();
		panel.lines = makeLines("panel", 3);
		panel.zones = [
			{ id: "first", row: 0, col: 1, width: 10, height: 1 },
			{ id: "second", row: 1, col: 1, width: 10, height: 1 },
		];
		const { terminal } = await setupSlotPanel(panel);

		terminal.sendInput("\x1b[<35;5;8M"); // enter "first"
		await terminal.waitForRender();
		assert.deepStrictEqual(panel.hovers, ["first"]);

		terminal.sendInput("\x1b[<35;5;8M"); // same cell again — deduped
		await terminal.waitForRender();
		assert.deepStrictEqual(panel.hovers, ["first"]);

		terminal.sendInput("\x1b[<35;5;9M"); // move to "second" (same owner: no null between)
		await terminal.waitForRender();
		assert.deepStrictEqual(panel.hovers, ["first", "second"]);

		terminal.sendInput("\x1b[<35;5;3M"); // leave to the transcript — hover clear
		await terminal.waitForRender();
		assert.deepStrictEqual(panel.hovers, ["first", "second", null]);
		assert.strictEqual(panel.mouse.length, 0, "zone-aware components never see raw motion");
	});

	it("clears the hovered zone when focus leaves the owner's subtree", async () => {
		const panel = new ZoneComponent();
		panel.lines = makeLines("panel", 3);
		panel.zones = [{ id: "first", row: 0, col: 1, width: 10, height: 1 }];
		const other = new FocusableComponent();
		const { tui, terminal } = await setupSlotPanel(panel);

		terminal.sendInput("\x1b[<35;5;8M");
		await terminal.waitForRender();
		assert.deepStrictEqual(panel.hovers, ["first"]);

		tui.setFocus(other);
		assert.deepStrictEqual(panel.hovers, ["first", null]);
	});

	it("skips the re-render when the zone handlers return false", async () => {
		class CountingZoneComponent extends ZoneComponent {
			renderCount = 0;
			override render(width: number): string[] {
				this.renderCount++;
				return super.render(width);
			}
		}
		const panel = new CountingZoneComponent();
		panel.lines = makeLines("panel", 3);
		panel.zones = [
			{ id: "first", row: 0, col: 1, width: 10, height: 1 },
			{ id: "second", row: 1, col: 1, width: 10, height: 1 },
		];
		const { terminal } = await setupSlotPanel(panel);

		panel.accept = false;
		const before = panel.renderCount;
		terminal.sendInput("\x1b[<35;5;8M"); // hover enter, reported unchanged
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;5;9M"); // press in "second", reported unchanged
		await terminal.waitForRender();
		assert.deepStrictEqual(panel.hovers, ["first"]);
		assert.strictEqual(panel.hits.length, 1);
		assert.strictEqual(panel.renderCount, before, "no render scheduled for unchanged handlers");

		panel.accept = true;
		terminal.sendInput("\x1b[<35;6;9M"); // hover moves to "second" — a real change
		await terminal.waitForRender();
		assert.ok(panel.renderCount > before, "a real change schedules a render");
	});

	it("forwards button-held motion (drags) to handleMouse even with zones", async () => {
		const panel = new ZoneComponent();
		panel.lines = makeLines("panel", 3);
		panel.zones = [{ id: "first", row: 0, col: 1, width: 10, height: 1 }];
		const { terminal } = await setupSlotPanel(panel);

		terminal.sendInput("\x1b[<35;5;8M"); // button-free motion → zone hover
		await terminal.waitForRender();
		assert.deepStrictEqual(panel.hovers, ["first"]);
		assert.strictEqual(panel.mouse.length, 0);

		terminal.sendInput("\x1b[<32;6;8M"); // left button held → a drag, not a hover
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 1);
		assert.strictEqual(panel.mouse[0]!.type, "motion");
		assert.strictEqual(panel.mouse[0]!.button, 0);
		assert.strictEqual(panel.mouse[0]!.row, 0);
		assert.deepStrictEqual(panel.hovers, ["first"], "drags do not drive zone hover");
	});

	it("forwards releases with the press translation so component drags can end", async () => {
		const panel = new ZoneComponent();
		panel.lines = makeLines("panel", 3);
		panel.zones = [{ id: "first", row: 0, col: 1, width: 10, height: 1 }];
		const { terminal } = await setupSlotPanel(panel);

		terminal.sendInput("\x1b[<0;5;8M"); // press → zone dispatch
		await terminal.waitForRender();
		assert.strictEqual(panel.hits.length, 1);
		assert.strictEqual(panel.mouse.length, 0);

		terminal.sendInput("\x1b[<0;5;8m"); // release → raw handler, press translation
		await terminal.waitForRender();
		assert.strictEqual(panel.hits.length, 1, "releases carry no zone semantics");
		assert.strictEqual(panel.mouse.length, 1);
		assert.strictEqual(panel.mouse[0]!.type, "release");
		assert.strictEqual(panel.mouse[0]!.row, 0);
		assert.strictEqual(panel.mouse[0]!.col, 5);
	});
});

describe("hit zone composition through containers", () => {
	// Mirrors the app-side GutterContainer: prefixes every child line with
	// `inset` spaces and reports that as its left inset.
	class InsetContainer extends Container {
		private readonly inset: number;
		constructor(inset: number) {
			super();
			this.inset = inset;
		}
		override leftInset(): number {
			return this.inset;
		}
		override render(width: number): string[] {
			const lead = " ".repeat(this.inset);
			return super.render(Math.max(1, width - this.inset)).map((line) => lead + line);
		}
	}

	it("composes child zones across nested chrome/gutter containers and dispatches owner-relative", async () => {
		class ChromeContainer extends Container {
			override rowsBeforeChild(): number {
				return 1;
			}
			override leftInset(): number {
				return 1;
			}
			override render(width: number): string[] {
				return [" chrome", ...super.render(Math.max(1, width - 1)).map((line) => ` ${line}`)];
			}
		}
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const panel = new ZoneComponent();
		panel.lines = makeLines("panel", 1);
		panel.zones = [{ id: "cell", row: 0, col: 1, width: 5, height: 1 }];
		const inner = new InsetContainer(2);
		inner.addChild(panel);
		const chrome = new ChromeContainer();
		chrome.addChild(inner);
		const slot = new Container();
		slot.addChild(chrome);
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.setFocus(chrome); // the focused component composes its subtree's zones
		tui.start();
		scroll.lines = makeLines("msg", 30);
		tui.requestRender(true);
		await terminal.waitForRender();

		// Slot = chrome row + panel line, pinned to rows 9-10. The panel's zone
		// composes to chrome-frame row 1, col 4 (chrome gutter 1 + inner inset 2
		// + zone col 1), so terminal col 5 is inside it — and the owner receives
		// the press re-translated to its own frame: row 0, col 2.
		terminal.sendInput("\x1b[<0;5;10M");
		await terminal.waitForRender();
		assert.strictEqual(panel.hits.length, 1);
		assert.strictEqual(panel.hits[0]!.id, "cell");
		assert.strictEqual(panel.hits[0]!.row, 0);
		assert.strictEqual(panel.hits[0]!.col, 2);

		// Hover resolves through the same composition, addressed to the owner.
		terminal.sendInput("\x1b[<35;6;10M");
		await terminal.waitForRender();
		assert.deepStrictEqual(panel.hovers, ["cell"]);
	});

	it("switches hover between zones of different owners with a clear in between", async () => {
		const top = new ZoneComponent();
		top.lines = makeLines("top", 1);
		top.zones = [{ id: "t", row: 0, col: 1, width: 5, height: 1 }];
		const bottom = new ZoneComponent();
		bottom.lines = makeLines("bottom", 1);
		bottom.zones = [{ id: "b", row: 0, col: 1, width: 5, height: 1 }];
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const dialog = new Container();
		dialog.addChild(top);
		dialog.addChild(bottom);
		const slot = new Container();
		slot.addChild(dialog);
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.setFocus(dialog);
		tui.start();
		scroll.lines = makeLines("msg", 30);
		tui.requestRender(true);
		await terminal.waitForRender();

		// Slot pins to rows 9-10: top's zone on row 9, bottom's on row 10.
		terminal.sendInput("\x1b[<35;3;9M");
		await terminal.waitForRender();
		assert.deepStrictEqual(top.hovers, ["t"]);

		terminal.sendInput("\x1b[<35;3;10M");
		await terminal.waitForRender();
		assert.deepStrictEqual(top.hovers, ["t", null], "old owner's hover clears");
		assert.deepStrictEqual(bottom.hovers, ["b"], "new owner's hover sets");

		// A press dispatches to the zone's owner, not the focused container.
		terminal.sendInput("\x1b[<0;3;10M");
		await terminal.waitForRender();
		assert.strictEqual(top.hits.length, 0);
		assert.strictEqual(bottom.hits.length, 1);
		assert.strictEqual(bottom.hits[0]!.id, "b");
	});

	it("accounts for the slot-top clip when dispatching zones", async () => {
		const panel = new ZoneComponent();
		panel.lines = makeLines("panel", 12);
		panel.zones = panel.lines.map((_, i) => ({ id: i, row: i, col: 1, width: 10, height: 1 }));
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const root = new Container();
		root.addChild(scroll);
		root.addChild(panel);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot: panel });
		tui.setFocus(panel);
		tui.start();
		scroll.lines = makeLines("msg", 30);
		tui.requestRender(true);
		await terminal.waitForRender();

		// The 12-line slot is clipped to rows 2-10, showing panel lines 4-12:
		// the first visible slot row is the panel's 0-based row 3.
		terminal.sendInput("\x1b[<0;5;2M");
		await terminal.waitForRender();
		assert.strictEqual(panel.hits.length, 1);
		assert.strictEqual(panel.hits[0]!.id, 3);

		// The transcript row above the visible slot is a clipped-away line — no hit.
		terminal.sendInput("\x1b[<0;5;1M");
		await terminal.waitForRender();
		assert.strictEqual(panel.hits.length, 1);

		// Motion over the last visible row hovers the panel's last line's zone.
		terminal.sendInput("\x1b[<35;5;10M");
		await terminal.waitForRender();
		assert.deepStrictEqual(panel.hovers, [11]);
	});
});

describe("hitZoneAt / hasHitZones", () => {
	it("matches the first declared zone containing the point", () => {
		const zones: HitZone[] = [
			{ id: "a", row: 0, col: 1, width: 4, height: 2 },
			{ id: "b", row: 1, col: 3, width: 4, height: 1 },
		];
		assert.strictEqual(hitZoneAt(zones, 0, 1, "action")?.id, "a");
		assert.strictEqual(hitZoneAt(zones, 1, 3, "action")?.id, "a", "declaration order wins on overlap");
		assert.strictEqual(hitZoneAt(zones, 2, 1, "action"), null, "below the zone");
		assert.strictEqual(hitZoneAt(zones, 0, 5, "action"), null, "right of the zone");
		assert.strictEqual(hitZoneAt(zones, 1, 3, "hover")?.id, "a");
	});

	it("hasHitZones finds zones in nested containers without rendering", () => {
		const plain = new Container();
		plain.addChild(new TestComponent());
		assert.strictEqual(hasHitZones(plain), false);
		const zoned = new ZoneComponent();
		const outer = new Container();
		const mid = new Container();
		mid.addChild(zoned);
		outer.addChild(new TestComponent());
		outer.addChild(mid);
		assert.strictEqual(hasHitZones(outer), true);
	});
});

describe("slot panel zone press (unfocused chrome)", () => {
	// Same gutter-container mirror as the composition suite above (block-scoped
	// there): prefixes every child line with `inset` spaces and reports that
	// as its left inset.
	class InsetContainer extends Container {
		private readonly inset: number;
		constructor(inset: number) {
			super();
			this.inset = inset;
		}
		override leftInset(): number {
			return this.inset;
		}
		override render(width: number): string[] {
			const lead = " ".repeat(this.inset);
			return super.render(Math.max(1, width - this.inset)).map((line) => lead + line);
		}
	}

	/**
	 * Footer analogue: a focused editor-like component above an UNFOCUSED
	 * zone-declaring chrome panel, each wrapped in a gutter container like the
	 * app's editor/footer mounts. Slot rows 6-8 = editor, rows 9-10 = chrome.
	 */
	async function setupChromePanel(options?: { chromeLines?: number; rows?: number }) {
		const terminal = new VirtualTerminal(80, options?.rows ?? 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const editor = new FocusableComponent();
		editor.lines = makeLines("editor", 3);
		const editorWrap = new InsetContainer(1);
		editorWrap.addChild(editor);
		const chrome = new ZoneComponent();
		chrome.lines = makeLines("chrome", options?.chromeLines ?? 2);
		chrome.zones = chrome.lines.map((_, i) => ({ id: `z${i}`, row: i, col: 3, width: 8, height: 1 }));
		const chromeWrap = new InsetContainer(1);
		chromeWrap.addChild(chrome);
		const slot = new Container();
		slot.addChild(editorWrap);
		slot.addChild(chromeWrap);
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.setFocus(editor);
		tui.start();
		scroll.lines = makeLines("msg", 30);
		tui.requestRender(true);
		await terminal.waitForRender();
		return { tui, terminal, editor, chrome };
	}

	it("dispatches a press over unfocused chrome to the zone owner, gutter-adjusted", async () => {
		const { terminal, chrome } = await setupChromePanel();
		// Terminal row 9 = chrome row 0; the zone sits at chrome-frame col 3,
		// composed to terminal col 4 through the wrapper's 1-cell gutter.
		terminal.sendInput("\x1b[<0;4;9M");
		await terminal.waitForRender();
		assert.strictEqual(chrome.hits.length, 1);
		assert.strictEqual(chrome.hits[0]!.id, "z0");
		// Owner-relative coordinates: chrome's own frame (row 0, col 3).
		assert.strictEqual(chrome.hits[0]!.row, 0);
		assert.strictEqual(chrome.hits[0]!.col, 3);
	});

	it("ignores presses on the chrome panel outside every zone", async () => {
		const { terminal, chrome } = await setupChromePanel();
		terminal.sendInput("\x1b[<0;1;9M"); // gutter cell, left of the zone
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;20;9M"); // right of the zone
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;5;8M"); // editor area (focused subtree)
		await terminal.waitForRender();
		assert.strictEqual(chrome.hits.length, 0);
		assert.strictEqual(chrome.mouse.length, 0, "unfocused chrome never sees raw mouse events");
	});

	it("does not intercept presses over the focused subtree", async () => {
		class MouseEditor extends FocusableComponent {
			mouse: MouseEvent[] = [];
			handleMouse(event: MouseEvent): void {
				this.mouse.push(event);
			}
		}
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const editor = new MouseEditor();
		editor.lines = makeLines("editor", 3);
		const chrome = new ZoneComponent();
		chrome.lines = makeLines("chrome", 2);
		chrome.zones = [{ id: "z", row: 0, col: 1, width: 80, height: 1 }];
		const slot = new Container();
		slot.addChild(editor);
		slot.addChild(chrome);
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.setFocus(editor);
		tui.start();
		scroll.lines = makeLines("msg", 30);
		tui.requestRender(true);
		await terminal.waitForRender();

		// Row 7 is inside the editor (focused): the focused path must see it,
		// the chrome zone one row below must not fire.
		terminal.sendInput("\x1b[<0;5;7M");
		await terminal.waitForRender();
		assert.strictEqual(editor.mouse.length, 1);
		assert.strictEqual(chrome.hits.length, 0);

		// Sanity: the chrome zone still fires for its own row (row 9).
		terminal.sendInput("\x1b[<0;5;9M");
		await terminal.waitForRender();
		assert.strictEqual(chrome.hits.length, 1);
	});

	it("accounts for the slot-top clip when pressing chrome zones", async () => {
		// 3 editor + 12 chrome rows in a 10-row terminal: the slot is capped to
		// height - 1 (the viewport keeps 1 row), so the visible slot starts at
		// slot line 6 (clip = 6) on terminal row 2.
		const { terminal, chrome } = await setupChromePanel({ chromeLines: 12 });
		terminal.sendInput("\x1b[<0;4;2M");
		await terminal.waitForRender();
		assert.strictEqual(chrome.hits.length, 1);
		// Slot line 6 = editor rows 0-2, then chrome row 3 (zone z3).
		assert.strictEqual(chrome.hits[0]!.id, "z3");
		assert.strictEqual(chrome.hits[0]!.row, 3);
	});
});

import assert from "node:assert";
import { describe, it } from "node:test";
import type { HitZone, HitZoneId } from "../src/hit-zones.ts";
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

/** Focusable slot panel logging raw mouse events. */
class PanelComponent extends FocusableComponent {
	mouse: MouseEvent[] = [];
	handleMouse(event: MouseEvent): void {
		this.mouse.push(event);
	}
}

/** Transcript card stand-in: fixed-height lines plus one full-extent zone. */
class CardComponent extends TestComponent {
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

/** Scroll container with left/right chrome gutters, like the app's. */
class InsetContainer extends Container {
	private readonly left: number;
	private readonly right: number;
	constructor(left: number, right: number) {
		super();
		this.left = left;
		this.right = right;
	}
	override leftInset(): number {
		return this.left;
	}
	override rightInset(): number {
		return this.right;
	}
}

function makeLines(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);
}

const COLUMNS = 80;
const ROWS = 10;
const LEFT_GUTTER = 2;
const RIGHT_GUTTER = 3;
const CHILD_WIDTH = COLUMNS - LEFT_GUTTER - RIGHT_GUTTER;
// Slot panel is 3 rows, so the transcript viewport is rows 1..7.
const VIEWPORT_ROWS = ROWS - 3;

function makeCard(id: string, height: number): CardComponent {
	const card = new CardComponent();
	card.lines = makeLines(`card-${id}`, height);
	card.zones = [{ id, row: 0, col: 1, width: CHILD_WIDTH, height }];
	return card;
}

async function setupTranscript(): Promise<{
	tui: TUI;
	terminal: VirtualTerminal;
	scroll: InsetContainer;
	panel: PanelComponent;
	cardA: CardComponent;
	cardB: CardComponent;
}> {
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const tui = new TUI(terminal);
	const scroll = new InsetContainer(LEFT_GUTTER, RIGHT_GUTTER);
	const cardA = makeCard("A", 5);
	const cardB = makeCard("B", 5);
	const filler = new TestComponent();
	filler.lines = makeLines("filler", 40);
	scroll.addChild(cardA);
	scroll.addChild(cardB);
	scroll.addChild(filler);
	const panel = new PanelComponent();
	panel.lines = makeLines("panel", 3);
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
	tui.requestRender(true);
	await terminal.waitForRender();
	return { tui, terminal, scroll, panel, cardA, cardB };
}

describe("transcript hit zones", () => {
	it("dispatches a press on a visible card with scroll-offset and gutter translation", async () => {
		const { tui, terminal, panel, cardA, cardB } = await setupTranscript();
		tui.scrollToTop();
		await terminal.waitForRender();

		// Viewport row 3 → transcript line 2 → card A's row 2; col 5 sits 2
		// cells past the left gutter → card col 3.
		terminal.sendInput("\x1b[<0;5;3M");
		await terminal.waitForRender();
		assert.deepStrictEqual(cardA.hits, [{ id: "A", row: 2, col: 3 }]);
		assert.deepStrictEqual(cardB.hits, []);
		assert.deepStrictEqual(panel.mouse, [], "in-zone presses never reach the focused panel");

		// Scroll down 4: the same viewport cell now maps to transcript line 6
		// (scrollTop 4 + row 2) → card B's row 1.
		tui.scrollBy(4);
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;5;3M");
		await terminal.waitForRender();
		assert.deepStrictEqual(cardB.hits, [{ id: "B", row: 1, col: 3 }]);
		assert.strictEqual(cardA.hits.length, 1);
	});

	it("ignores presses on the sticky-header row and the right gutter", async () => {
		const { tui, terminal, cardA } = await setupTranscript();
		tui.setStickyHeaderContent(() => ({ line: "HEADER" }));
		tui.scrollToTop();
		await terminal.waitForRender();

		// Row 1 is the sticky header while scrolled up: its click jumps back to
		// the bottom instead of hitting the card rendered underneath.
		terminal.sendInput("\x1b[<0;5;1M");
		await terminal.waitForRender();
		assert.deepStrictEqual(cardA.hits, []);
		assert.strictEqual(tui.isFollowingOutput(), true);

		// The right gutter is outside every card zone's width.
		tui.scrollToTop();
		await terminal.waitForRender();
		terminal.sendInput(`\x1b[<0;${COLUMNS - 1};3M`);
		await terminal.waitForRender();
		assert.deepStrictEqual(cardA.hits, []);
	});

	it("keeps the rightmost column for the transcript scrollbar", async () => {
		const { terminal, cardA, cardB } = await setupTranscript();
		// Scrolled to the bottom, so the transcript scrolls and the scrollbar
		// owns the last column even though card rows sit underneath.
		terminal.sendInput(`\x1b[<0;${COLUMNS};5M`);
		await terminal.waitForRender();
		assert.deepStrictEqual(cardA.hits, []);
		assert.deepStrictEqual(cardB.hits, []);
		terminal.sendInput(`\x1b[<0;${COLUMNS};5m`);
		await terminal.waitForRender();
	});

	it("tracks hover across cards and clears it outside the viewport", async () => {
		const { tui, terminal, cardA, cardB } = await setupTranscript();
		tui.scrollToTop();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<35;5;3M"); // over card A
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<35;5;6M"); // over card B
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<35;5;9M"); // over the slot (below the viewport)
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<35;5;2M"); // back over card A
		await terminal.waitForRender();

		assert.deepStrictEqual(cardA.hovers, ["A", null, "A"]);
		assert.deepStrictEqual(cardB.hovers, ["B", null]);
	});

	it("clears the transcript hover when the transcript scrolls", async () => {
		const { tui, terminal, cardA } = await setupTranscript();
		tui.scrollToTop();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<35;5;3M");
		await terminal.waitForRender();
		assert.deepStrictEqual(cardA.hovers, ["A"]);

		terminal.sendInput("\x1b[<65;5;3M"); // wheel down
		await terminal.waitForRender();
		assert.deepStrictEqual(cardA.hovers, ["A", null]);
	});

	it("lets a visible overlay shield transcript zones", async () => {
		const { tui, terminal, cardA } = await setupTranscript();
		tui.scrollToTop();
		await terminal.waitForRender();

		class DialogComponent extends FocusableComponent {
			mouse: MouseEvent[] = [];
			handleMouse(event: MouseEvent): void {
				this.mouse.push(event);
			}
		}
		const dialog = new DialogComponent();
		dialog.lines = makeLines("dialog", 3);
		tui.showOverlay(dialog, { anchor: "top-left", width: 20 });
		await terminal.waitForRender();

		// A cell inside the dialog rect but over card A's rows: the press and
		// the hover belong to the dialog, never to the transcript underneath.
		terminal.sendInput("\x1b[<0;5;2M");
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<35;5;2M");
		await terminal.waitForRender();
		assert.deepStrictEqual(cardA.hits, []);
		assert.deepStrictEqual(cardA.hovers, []);
	});

	it("ignores presses on zone-less transcript content", async () => {
		const { tui, terminal, panel, cardA, cardB } = await setupTranscript();
		tui.scrollToTop();
		tui.scrollBy(4);
		await terminal.waitForRender();
		// The viewport's last row now shows transcript line 10 — filler without
		// zones. The press misses every zone and must not reach the focused
		// panel either (a slot-focused component declines transcript rows).
		terminal.sendInput(`\x1b[<0;5;${VIEWPORT_ROWS}M`);
		await terminal.waitForRender();
		assert.deepStrictEqual(cardA.hits, []);
		assert.deepStrictEqual(cardB.hits, []);
		assert.deepStrictEqual(panel.mouse, []);
	});
});

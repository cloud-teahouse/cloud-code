import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { HitZone, HitZoneId } from "../src/hit-zones.ts";
import { TranscriptRowIndex, type TranscriptIndexEntry } from "../src/transcript-index.ts";
import { type Component, Container, type MouseEvent, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class StubComponent implements Component {
	lines: string[] = [];
	renderCalls = 0;
	render(_width: number): string[] {
		this.renderCalls++;
		return this.lines;
	}
	invalidate(): void {}
}

function stubbed(label: string, height: number): StubComponent {
	const component = new StubComponent();
	component.lines = Array.from({ length: height }, (_, i) => `${label}-${i + 1}`);
	return component;
}

function entriesOf(index: TranscriptRowIndex): TranscriptIndexEntry[] {
	return (index as unknown as { entries: TranscriptIndexEntry[] }).entries;
}

describe("TranscriptRowIndex", () => {
	it("builds prefix sums and locates lines by binary search", () => {
		const container = new Container();
		const a = stubbed("a", 3);
		const b = stubbed("b", 0);
		const c = stubbed("c", 4);
		container.addChild(a);
		container.addChild(b);
		container.addChild(c);
		const index = new TranscriptRowIndex();
		assert.strictEqual(index.syncFull(container, 80), true);
		assert.strictEqual(index.totalLines, 7);
		assert.deepStrictEqual(
			[0, 1, 2].map((line) => index.locate(line)?.child),
			[a, a, a],
		);
		// The zero-height child owns no line; line 3 belongs to c.
		assert.strictEqual(index.locate(3)?.child, c);
		assert.strictEqual(index.locate(3)?.base, 3);
		assert.strictEqual(index.locate(6)?.child, c);
		assert.strictEqual(index.locate(7), null);
		assert.strictEqual(index.locate(100), null);
	});

	it("reuses unchanged entries across dirty and append syncs", () => {
		const container = new Container();
		const children = [stubbed("a", 2), stubbed("b", 2), stubbed("c", 2)];
		for (const child of children) container.addChild(child);
		const index = new TranscriptRowIndex();
		index.syncFull(container, 80);
		const entries = entriesOf(index);
		const entryRefs = entries.slice();

		index.syncFull(container, 80);
		assert.strictEqual(entriesOf(index), entries, "steady sync must not allocate entries");
		assert.deepStrictEqual(entries, entryRefs);

		children[0]!.lines = [...children[0]!.lines, "a-3"];
		index.syncFull(container, 80);
		assert.strictEqual(entriesOf(index), entries, "dirty sync must reuse the entries array");
		assert.strictEqual(entries[1], entryRefs[1], "unchanged suffix entry must be reused");
		assert.strictEqual(entries[2], entryRefs[2], "unchanged suffix entry must be reused");
		assert.strictEqual(entries[1]!.base, 3, "prefix must be rebuilt after the changed child");
		assert.strictEqual(index.totalLines, 7);

		const appended = stubbed("d", 1);
		container.addChild(appended);
		index.syncFull(container, 80);
		assert.strictEqual(entriesOf(index), entries, "append sync must extend in place");
		assert.strictEqual(entries[0], entryRefs[0], "unchanged prefix entry must be reused");
		assert.strictEqual(entries[2], entryRefs[2], "unchanged suffix entry must be reused");
		assert.strictEqual(entries[3]!.child, appended);
		assert.strictEqual(entries[3]!.base, 7);
		assert.strictEqual(index.totalLines, 8);
	});

	it("tracks warmth across structural and width changes", () => {
		const container = new Container();
		const a = stubbed("a", 2);
		container.addChild(a);
		const index = new TranscriptRowIndex();
		index.syncFull(container, 80);
		assert.strictEqual(index.isWarmFor(container, 80), true);
		assert.strictEqual(index.isWarmFor(container, 60), false, "width change must cool the index");

		const b = stubbed("b", 1);
		container.addChild(b);
		assert.strictEqual(index.isWarmFor(container, 80), false, "append must cool the index");
		index.syncFull(container, 80);
		assert.strictEqual(index.totalLines, 3);
		assert.strictEqual(index.locate(2)?.child, b);

		const c = stubbed("c", 5);
		container.children[0] = c;
		assert.strictEqual(index.isWarmFor(container, 80), false, "in-place replace must cool the index");
		index.syncFull(container, 80);
		assert.strictEqual(index.totalLines, 6);
		assert.strictEqual(index.locate(4)?.child, c);

		container.clear();
		assert.strictEqual(index.isWarmFor(container, 80), false, "clear must cool the index");
	});

	it("declines containers with per-child chrome rows", () => {
		class ChromeContainer extends Container {
			override rowsBeforeChild(_child: Component): number {
				return 1;
			}
		}
		const container = new ChromeContainer();
		container.addChild(stubbed("a", 2));
		const index = new TranscriptRowIndex();
		assert.strictEqual(index.syncFull(container, 80), false);
		assert.strictEqual(index.isDeclinedFor(container), true);
		assert.strictEqual(index.isWarmFor(container, 80), false);
	});

	it("iterates exactly the children intersecting a window", () => {
		const container = new Container();
		const heights = [3, 5, 0, 2, 4];
		const children = heights.map((height, i) => stubbed(`c${i}`, height));
		for (const child of children) container.addChild(child);
		const index = new TranscriptRowIndex();
		index.syncFull(container, 80);
		const windowed = [...index.windowEntries(4, 11)];
		assert.deepStrictEqual(
			windowed.map((entry) => entry.child),
			[children[1], children[2], children[3], children[4]],
		);
		assert.deepStrictEqual(
			windowed.map((entry) => entry.base),
			[3, 8, 8, 10],
		);
		assert.deepStrictEqual([...index.windowEntries(14, 20)], [], "past the end yields nothing");
	});
});

// === TUI-level: indexed composition and hit-testing =====================

const COLUMNS = 80;
const ROWS = 10;
const LEFT_GUTTER = 2;
const RIGHT_GUTTER = 3;
const CHILD_WIDTH = COLUMNS - LEFT_GUTTER - RIGHT_GUTTER;
// Slot panel is 3 rows, so the transcript viewport is rows 1..7.
const VIEWPORT_ROWS = ROWS - 3;

/** Same layout contract as the app's transcript GutterContainer. */
class GutterContainer extends Container {
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
	override render(width: number): string[] {
		const inner = Math.max(1, width - this.left - this.right);
		const lead = " ".repeat(this.left);
		const out: string[] = [];
		for (const child of this.children) {
			for (const line of child.render(inner)) out.push(lead + line);
		}
		return out;
	}
}

class CountingChild extends StubComponent {
	constructor(label: string, height: number) {
		super();
		this.lines = Array.from({ length: height }, (_, i) => `${label}-${i + 1}`);
	}
}

/** Transcript card stand-in: fixed-height lines plus one full-extent zone. */
class ZoneCard extends CountingChild {
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

class StableHoverZoneCard extends ZoneCard {
	override setHoveredZone(id: HitZoneId | null): boolean {
		super.setHoveredZone(id);
		return false;
	}
}

class FocusableComponent extends StubComponent {
	focused = false;
}

/** Focused slot panel; declines every event without visual change. */
class PanelComponent extends FocusableComponent {
	override handleMouse(_event: MouseEvent): boolean {
		return false;
	}
}

async function setupIndexedTranscript(children: CountingChild[]): Promise<{
	tui: TUI;
	terminal: VirtualTerminal;
	scroll: GutterContainer;
	slotChild: StubComponent;
	panel: PanelComponent;
}> {
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const tui = new TUI(terminal);
	const scroll = new GutterContainer(LEFT_GUTTER, RIGHT_GUTTER);
	for (const child of children) scroll.addChild(child);
	const panel = new PanelComponent();
	panel.lines = Array.from({ length: 3 }, (_, i) => `panel-${i + 1}`);
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
	return { tui, terminal, scroll, slotChild: panel, panel };
}

function makeChildren(count: number, height: number): CountingChild[] {
	return Array.from({ length: count }, (_, i) => new CountingChild(`child-${i}`, height));
}

/** The transcript rows the legacy whole-render layout would produce. */
function expectedTranscriptLines(children: CountingChild[]): string[] {
	const lead = " ".repeat(LEFT_GUTTER);
	const out: string[] = [];
	for (const child of children) for (const line of child.lines) out.push(lead + line);
	return out;
}

function resetRenderCalls(children: CountingChild[]): void {
	for (const child of children) child.renderCalls = 0;
}

function totalRenderCalls(children: CountingChild[]): number {
	return children.reduce((total, child) => total + child.renderCalls, 0);
}

/**
 * Compare the viewport's transcript rows to the expected legacy-layout slice.
 * While content is hidden below the fold, the scroll badge overlays the
 * viewport's bottom row — TUI chrome drawn over the same underlying rows —
 * so that row is compared as a stripped prefix.
 */
function assertTranscriptRows(
	terminal: VirtualTerminal,
	expected: string[],
	badgeCoversBottomRow: boolean,
): void {
	const rows = terminal.getViewport().slice(0, VIEWPORT_ROWS);
	if (!badgeCoversBottomRow) {
		assert.deepStrictEqual(rows, expected);
		return;
	}
	assert.deepStrictEqual(rows.slice(0, -1), expected.slice(0, -1));
	const badgeRow = stripVTControlCharacters(rows[rows.length - 1] ?? "");
	const expectedTail = expected[expected.length - 1]!;
	assert.ok(
		badgeRow.startsWith(expectedTail),
		`badge row ${JSON.stringify(badgeRow)} should start with ${JSON.stringify(expectedTail)}`,
	);
}

describe("indexed transcript composition", () => {
	it("composes byte-identical viewport rows at every scroll position", async () => {
		const children = makeChildren(50, 3);
		const { tui, terminal } = await setupIndexedTranscript(children);
		const transcriptLines = (): string[] => expectedTranscriptLines(children);

		// Following the output: the viewport shows the transcript's tail.
		assertTranscriptRows(terminal, transcriptLines().slice(-VIEWPORT_ROWS), false);

		tui.scrollToTop();
		await terminal.waitForRender();
		assertTranscriptRows(terminal, transcriptLines().slice(0, VIEWPORT_ROWS), true);

		tui.scrollBy(10);
		await terminal.waitForRender();
		assertTranscriptRows(terminal, transcriptLines().slice(10, 10 + VIEWPORT_ROWS), true);

		// A scroll offset that splits a child mid-body.
		tui.scrollBy(1);
		await terminal.waitForRender();
		assertTranscriptRows(terminal, transcriptLines().slice(11, 11 + VIEWPORT_ROWS), true);

		tui.scrollToBottom();
		await terminal.waitForRender();
		assertTranscriptRows(terminal, transcriptLines().slice(-VIEWPORT_ROWS), false);
	});

	it("revalidates geometry after mutations, including off-viewport growth", async () => {
		const children = makeChildren(50, 3);
		const { tui, terminal } = await setupIndexedTranscript(children);

		tui.scrollToTop();
		await terminal.waitForRender();
		tui.scrollBy(10);
		await terminal.waitForRender();

		// Grow an above-viewport child: everything below shifts down by two.
		children[0]!.lines = [...children[0]!.lines, "child-0-4", "child-0-5"];
		tui.requestRender();
		await terminal.waitForRender();
		assertTranscriptRows(terminal, expectedTranscriptLines(children).slice(10, 10 + VIEWPORT_ROWS), true);

		// Grow a below-viewport child: the total (and therefore the scroll
		// clamp) must absorb it — scroll to the absolute bottom lands exactly
		// on the new tail.
		children[49]!.lines = [...children[49]!.lines, "child-49-4"];
		tui.requestRender();
		await terminal.waitForRender();
		tui.scrollBy(10000);
		await terminal.waitForRender();
		assertTranscriptRows(terminal, expectedTranscriptLines(children).slice(-VIEWPORT_ROWS), false);
	});

	it("rekeys cached geometry on terminal resize", async () => {
		class WrappingChild extends StubComponent {
			private readonly text: string;
			constructor(text: string) {
				super();
				this.text = text;
			}
			override render(width: number): string[] {
				this.renderCalls++;
				const lines: string[] = [];
				for (let i = 0; i < this.text.length; i += Math.max(1, width)) {
					lines.push(this.text.slice(i, i + Math.max(1, width)));
				}
				this.lines = lines;
				return lines;
			}
		}
		const wrapped = new WrappingChild("x".repeat(CHILD_WIDTH * 2));
		const children: CountingChild[] = [wrapped as unknown as CountingChild, ...makeChildren(20, 2)];
		const { tui, terminal } = await setupIndexedTranscript(children);
		const viewportTranscriptRows = (): string[] => terminal.getViewport().slice(0, VIEWPORT_ROWS);

		tui.scrollToTop();
		await terminal.waitForRender();
		assert.strictEqual(viewportTranscriptRows()[0], `${" ".repeat(LEFT_GUTTER)}${"x".repeat(CHILD_WIDTH)}`);
		assert.strictEqual(wrapped.lines.length, 2);

		terminal.resize(40, ROWS);
		await terminal.waitForRender();
		const narrowWidth = 40 - LEFT_GUTTER - RIGHT_GUTTER;
		assert.strictEqual(wrapped.lines.length, Math.ceil((CHILD_WIDTH * 2) / narrowWidth));
		assert.strictEqual(
			viewportTranscriptRows()[0],
			`${" ".repeat(LEFT_GUTTER)}${"x".repeat(narrowWidth)}`,
		);
		void tui;
	});
});

describe("transcript row index counters", () => {
	it("materializes scroll-driven frames without rendering transcript children", async () => {
		const children = makeChildren(2000, 2);
		const { tui, terminal } = await setupIndexedTranscript(children);

		resetRenderCalls(children);
		tui.scrollBy(-10);
		await terminal.waitForRender();
		assert.strictEqual(totalRenderCalls(children), 0, "scroll frame re-rendered transcript children");
		assertTranscriptRows(terminal, expectedTranscriptLines(children).slice(-VIEWPORT_ROWS - 10, -10), true);

		tui.scrollBy(5);
		await terminal.waitForRender();
		assert.strictEqual(totalRenderCalls(children), 0, "second scroll frame re-rendered children");

		tui.scrollToTop();
		await terminal.waitForRender();
		tui.scrollToBottom();
		await terminal.waitForRender();
		assert.strictEqual(totalRenderCalls(children), 0, "top/bottom jumps re-rendered children");

		// A mutation latches a revalidation: the next frame touches every child
		// exactly once, proving the zero-render frames above were the index's
		// doing and not a frozen transcript.
		children[7]!.lines = [...children[7]!.lines, "child-7-3"];
		tui.requestRender();
		await terminal.waitForRender();
		assert.strictEqual(totalRenderCalls(children), 2000);
		assertTranscriptRows(terminal, expectedTranscriptLines(children).slice(-VIEWPORT_ROWS), false);
	});

	it("hit-tests motions and presses without rendering children", async () => {
		const card = new ZoneCard("card-0", 3);
		card.zones = [{ id: "A", row: 0, col: 1, width: CHILD_WIDTH, height: 3 }];
		const children: CountingChild[] = [card, ...makeChildren(1999, 2)];
		const { tui, terminal } = await setupIndexedTranscript(children);
		tui.scrollToTop();
		await terminal.waitForRender();

		// First hover: the hit-test itself is synchronous — count renders before
		// any frame could run.
		resetRenderCalls(children);
		terminal.sendInput("\x1b[<35;5;2M");
		assert.deepStrictEqual(card.hovers, ["A"]);
		assert.strictEqual(totalRenderCalls(children), 0, "hover hit-test re-rendered children");
		await terminal.waitForRender();

		// Same-cell repeats: the raw-cell dedupe runs ahead of the hit-test, so
		// the transcript is never even probed.
		resetRenderCalls(children);
		for (let i = 0; i < 5; i++) terminal.sendInput("\x1b[<35;5;2M");
		assert.strictEqual(totalRenderCalls(children), 0, "repeated motions re-rendered children");
		assert.deepStrictEqual(card.hovers, ["A"], "no duplicate hover notifications");

		// Another cell inside the same zone: binary-search hit-test, still free.
		terminal.sendInput("\x1b[<35;6;3M");
		assert.strictEqual(totalRenderCalls(children), 0, "motion hit-test re-rendered children");
		assert.deepStrictEqual(card.hovers, ["A"]);

		// Press: zone dispatch via the index renders nothing either.
		terminal.sendInput("\x1b[<0;6;3M");
		assert.deepStrictEqual(card.hits, [{ id: "A", row: 2, col: 4 }]);
		assert.strictEqual(totalRenderCalls(children), 0, "press hit-test re-rendered children");
		void tui;
	});

	it("syncs a dirty hit index once before repeated motions", async () => {
		const card = new StableHoverZoneCard("card-last", 3);
		card.zones = [{ id: "A", row: 0, col: 1, width: CHILD_WIDTH, height: 3 }];
		const children: CountingChild[] = [...makeChildren(1999, 2), card];
		const { tui, terminal } = await setupIndexedTranscript(children);
		tui.scrollToBottom();
		await terminal.waitForRender();

		children[0]!.lines = [...children[0]!.lines, "child-0-3"];
		tui.requestRender();
		resetRenderCalls(children);
		for (let i = 0; i < 5; i++) terminal.sendInput(`\x1b[<35;6;${i + 2}M`);

		assert.deepStrictEqual(card.hovers, ["A"]);
		assert.strictEqual(
			totalRenderCalls(children),
			children.length,
			"dirty motions should sync the index once, not linearly walk once per cell",
		);
		await terminal.waitForRender();
		assert.strictEqual(totalRenderCalls(children), children.length, "the scheduled frame should reuse the synced index");
	});
});

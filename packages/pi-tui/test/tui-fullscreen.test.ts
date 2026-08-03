import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Editor } from "../src/components/editor.ts";
import type { HitZone } from "../src/hit-zones.ts";
import { type Component, Container, CURSOR_MARKER, TUI } from "../src/tui.ts";
import { defaultEditorTheme } from "./test-themes.ts";
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
	override handleInput(data: string): void {
		this.input.push(data);
	}
}

class MouseAwareComponent extends FocusableComponent {
	mouse: import("../src/tui.ts").MouseEvent[] = [];
	override handleMouse(event: import("../src/tui.ts").MouseEvent): void {
		this.mouse.push(event);
	}
}

function makeLines(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);
}

async function render(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await terminal.waitForRender();
}

async function setupFullscreen(
	columns = 80,
	rows = 24,
): Promise<{ tui: TUI; terminal: VirtualTerminal; scroll: TestComponent; slot: TestComponent }> {
	const terminal = new VirtualTerminal(columns, rows);
	const tui = new TUI(terminal);
	const scroll = new TestComponent();
	const slot = new TestComponent();
	const root = new Container();
	root.addChild(scroll);
	root.addChild(slot);
	tui.addChild(root);
	tui.setFullscreen(true);
	tui.setLayoutRegions({ scroll, slot });
	tui.start();
	await terminal.waitForRender();
	return { tui, terminal, scroll, slot };
}

describe("TUI fullscreen rendering", () => {
	it("pins the slot at the bottom and top-aligns a short transcript", async () => {
		const { tui, terminal, scroll, slot } = await setupFullscreen(80, 10);
		scroll.lines = makeLines("msg", 3);
		slot.lines = makeLines("slot", 2);
		await render(tui, terminal);
		const viewport = terminal.getViewport();
		assert.strictEqual(viewport.length, 10);
		assert.strictEqual(viewport[0], "msg-1");
		assert.strictEqual(viewport[2], "msg-3");
		assert.strictEqual(viewport[3], "");
		assert.strictEqual(viewport[7], "");
		assert.strictEqual(viewport[8], "slot-1");
		assert.strictEqual(viewport[9], "slot-2");
	});

	it("shows the last viewport-height lines when the transcript overflows (follow)", async () => {
		const { tui, terminal, scroll, slot } = await setupFullscreen(80, 10);
		scroll.lines = makeLines("msg", 30);
		slot.lines = ["slot"];
		await render(tui, terminal);
		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "msg-22");
		assert.strictEqual(viewport[8], "msg-30");
		assert.strictEqual(viewport[9], "slot");
	});

	it("keeps the window pinned when scrolled up and new content arrives; shows badge", async () => {
		const { tui, terminal, scroll, slot } = await setupFullscreen(80, 10);
		scroll.lines = makeLines("msg", 30);
		slot.lines = ["slot"];
		await render(tui, terminal);

		tui.scrollBy(-5);
		await terminal.waitForRender();
		let viewport = terminal.getViewport();
		assert.strictEqual(viewport[8]!.slice(0, 20).trimEnd().startsWith("msg-25"), true);
		assert.ok(viewport[8]!.includes("↓"), `expected badge on viewport bottom row: ${JSON.stringify(viewport[8])}`);

		// New content arrives while scrolled up: window must not move
		scroll.lines = makeLines("msg", 35);
		await render(tui, terminal);
		viewport = terminal.getViewport();
		assert.ok(viewport[8]!.startsWith("msg-25"), `window moved unexpectedly: ${JSON.stringify(viewport[8])}`);
	});

	it("re-enters follow mode when scrolled back to the bottom", async () => {
		const { tui, terminal, scroll, slot } = await setupFullscreen(80, 10);
		scroll.lines = makeLines("msg", 30);
		slot.lines = ["slot"];
		await render(tui, terminal);

		tui.scrollBy(-5);
		await terminal.waitForRender();
		assert.ok(!tui.isFollowingOutput());
		tui.scrollToBottom();
		await terminal.waitForRender();
		assert.ok(tui.isFollowingOutput());

		scroll.lines = makeLines("msg", 32);
		await render(tui, terminal);
		assert.strictEqual(terminal.getViewport()[8], "msg-32");
	});

	it("scrolls via mouse wheel SGR events", async () => {
		const { tui, terminal, scroll, slot } = await setupFullscreen(80, 10);
		scroll.lines = makeLines("msg", 30);
		slot.lines = ["slot"];
		await render(tui, terminal);

		terminal.sendInput("\x1b[<64;10;5M"); // wheel up = 3 lines
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[8]!.startsWith("msg-27"), true);
		terminal.sendInput("\x1b[<65;10;5M"); // wheel down
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[8], "msg-30");
		// release events are ignored
		terminal.sendInput("\x1b[<64;10;5m");
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[8], "msg-30");
	});

	it("pages via Shift+PageUp/Down and leaves plain PageUp to the focused component", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const editor = new FocusableComponent();
		const root = new Container();
		root.addChild(scroll);
		root.addChild(editor);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot: editor });
		tui.setFocus(editor);
		tui.start();
		scroll.lines = makeLines("msg", 30);
		editor.lines = ["editor"];
		await render(tui, terminal);

		terminal.sendInput("\x1b[5~"); // plain PageUp -> editor
		await terminal.waitForRender();
		assert.deepStrictEqual(editor.input, ["\x1b[5~"]);
		assert.strictEqual(terminal.getViewport()[8], "msg-30"); // did not scroll

		terminal.sendInput("\x1b[5;2~"); // Shift+PageUp -> page scroll
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[8]!.startsWith("msg-22"), true); // paged up by viewport-1 = 8

		terminal.sendInput("\x1b[6;2~"); // Shift+PageDown -> back to bottom
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[8], "msg-30");
	});

	it("renders a full frame on resize with no stale rows", async () => {
		const { tui, terminal, scroll, slot } = await setupFullscreen(80, 10);
		scroll.lines = makeLines("msg", 5);
		slot.lines = ["slot"];
		await render(tui, terminal);

		terminal.resize(60, 14);
		await terminal.waitForRender();
		const viewport = terminal.getViewport();
		assert.strictEqual(viewport.length, 14);
		assert.strictEqual(viewport[13], "slot");
		assert.strictEqual(viewport[4], "msg-5");
		assert.strictEqual(viewport[0], "msg-1");
		assert.strictEqual(viewport[5], "");
	});

	it("falls back to a top-aligned whole-tree frame when regions are unmounted (takeover)", async () => {
		const { tui, terminal, scroll, slot } = await setupFullscreen(80, 10);
		scroll.lines = ["msg"];
		slot.lines = ["slot"];
		await render(tui, terminal);

		// Takeover: swap children
		const takeover = new TestComponent();
		takeover.lines = makeLines("takeover", 4);
		tui.clear();
		tui.addChild(takeover);
		await render(tui, terminal);
		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "takeover-1");
		assert.strictEqual(viewport[3], "takeover-4");
		assert.strictEqual(viewport[4], "");
	});

	it("positions the hardware cursor at the slot's cursor marker", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const editor = new FocusableComponent();
		editor.lines = [`> ab${CURSOR_MARKER}`, "footer"];
		const root = new Container();
		root.addChild(scroll);
		root.addChild(editor);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot: editor });
		tui.setFocus(editor);
		tui.start();
		scroll.lines = makeLines("msg", 4);
		await render(tui, terminal);
		const pos = terminal.getCursorPosition();
		assert.strictEqual(pos.y, 8); // slot first line (0-indexed row 8)
		assert.strictEqual(pos.x, 4); // after "> ab"
	});

	it("composites overlays over the fullscreen frame", async () => {
		const { tui, terminal, scroll, slot } = await setupFullscreen(80, 10);
		scroll.lines = makeLines("msg", 5);
		slot.lines = ["slot"];
		await render(tui, terminal);

		const overlay = new TestComponent();
		overlay.lines = ["OVERLAY"];
		const handle = tui.showOverlay(overlay, { anchor: "center", width: 20 });
		await render(tui, terminal);
		let viewport = terminal.getViewport();
		assert.ok(
			viewport.some((line) => line.includes("OVERLAY")),
			`overlay should be visible: ${JSON.stringify(viewport)}`,
		);
		assert.strictEqual(viewport[9], "slot"); // slot still pinned

		handle.hide();
		await render(tui, terminal);
		viewport = terminal.getViewport();
		assert.ok(!viewport.some((line) => line.includes("OVERLAY")));
	});

	it("draws the sticky header at the viewport top while scrolled up", async () => {
		const { tui, terminal, scroll, slot } = await setupFullscreen(80, 10);
		tui.setStickyHeaderContent(() => ({ line: " ⏺ latest prompt summary" }));
		scroll.lines = makeLines("msg", 30);
		slot.lines = ["slot"];
		await render(tui, terminal);
		// At the bottom: no header.
		assert.strictEqual(terminal.getViewport()[0], "msg-22");
		assert.ok(!tui.isStickyHeaderVisible());

		tui.scrollBy(-6);
		await terminal.waitForRender();
		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], " ⏺ latest prompt summary");
		assert.ok(tui.isStickyHeaderVisible());
		assert.strictEqual(viewport[1], "msg-17");

		tui.scrollToBottom();
		await terminal.waitForRender();
		assert.ok(!tui.isStickyHeaderVisible());
		assert.strictEqual(terminal.getViewport()[0], "msg-22");
	});

	it("jumps to the bottom when the sticky header row is left-clicked", async () => {
		const { tui, terminal, scroll, slot } = await setupFullscreen(80, 10);
		tui.setStickyHeaderContent(() => ({ line: " ⏺ summary" }));
		scroll.lines = makeLines("msg", 30);
		slot.lines = ["slot"];
		await render(tui, terminal);

		tui.scrollBy(-6);
		await terminal.waitForRender();
		assert.ok(!tui.isFollowingOutput());

		terminal.sendInput("\x1b[<0;5;1M"); // left-click on row 1 (the header)
		await terminal.waitForRender();
		assert.ok(tui.isFollowingOutput());
		assert.strictEqual(terminal.getViewport()[8], "msg-30");

		// Click elsewhere: ignored (no crash, no state change)
		tui.scrollBy(-4);
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;5;7M");
		await terminal.waitForRender();
		assert.ok(!tui.isFollowingOutput());
	});

	it("jumps to the header's jumpTo position instead of the bottom when set", async () => {
		const { tui, terminal, scroll, slot } = await setupFullscreen(80, 10);
		tui.setStickyHeaderContent(() => ({ line: " ⏺ anchored", jumpTo: 5 }));
		scroll.lines = makeLines("msg", 30);
		slot.lines = ["slot"];
		await render(tui, terminal);

		tui.scrollBy(-6);
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;5;1M");
		await terminal.waitForRender();
		// scrollTop becomes 5: the header covers slice line 1 (msg-6), so the
		// viewport shows msg-7..msg-14 below it — not the bottom.
		assert.ok(!tui.isFollowingOutput());
		assert.strictEqual(terminal.getViewport()[1]!.startsWith("msg-7"), true);
		assert.strictEqual(terminal.getViewport()[8]!.startsWith("msg-14"), true);
	});

	it("jumps to the bottom when the scroll badge row is clicked", async () => {
		const { tui, terminal, scroll, slot } = await setupFullscreen(80, 10);
		scroll.lines = makeLines("msg", 30);
		slot.lines = ["slot"];
		await render(tui, terminal);

		tui.scrollBy(-6);
		await terminal.waitForRender();
		assert.ok(!tui.isFollowingOutput());
		// Badge sits right-aligned on the viewport bottom row (row 9, 1-based)
		terminal.sendInput("\x1b[<0;79;9M");
		await terminal.waitForRender();
		assert.ok(tui.isFollowingOutput());
		assert.strictEqual(terminal.getViewport()[8], "msg-30");
	});

	it("blocks renders before start() and repaints fully on start", async () => {
		class LoggingTerminal extends VirtualTerminal {
			writes: string[] = [];
			override write(data: string): void {
				this.writes.push(data);
				super.write(data);
			}
		}
		const terminal = new LoggingTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const slot = new TestComponent();
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		scroll.lines = ["msg"];
		slot.lines = ["slot"];
		tui.requestRender(true);
		await terminal.waitForRender();
		assert.strictEqual(terminal.writes.length, 0, "pre-start renders must be blocked");

		tui.start();
		await terminal.waitForRender();
		const out = terminal.writes.join("");
		assert.ok(out.includes("\x1b[?1049h"), "start enters alt-screen before painting");
		assert.strictEqual(terminal.getViewport()[9], "slot");
	});

	it("re-enters follow when content shrinks onto the current scroll position", async () => {
		const { tui, terminal, scroll, slot } = await setupFullscreen(80, 10);
		scroll.lines = makeLines("msg", 30);
		slot.lines = ["slot"];
		await render(tui, terminal);

		tui.scrollBy(-5);
		await terminal.waitForRender();
		assert.ok(!tui.isFollowingOutput());

		// Content shrinks so the current position becomes the bottom.
		scroll.lines = makeLines("msg", 12);
		await render(tui, terminal);
		assert.ok(tui.isFollowingOutput());

		// New output anchors to the bottom again.
		scroll.lines = makeLines("msg", 20);
		await render(tui, terminal);
		assert.strictEqual(terminal.getViewport()[8], "msg-20");
	});

	it("survives a 1-row terminal without crashing the badge path", async () => {
		const { tui, terminal, scroll, slot } = await setupFullscreen(80, 10);
		scroll.lines = makeLines("msg", 30);
		slot.lines = ["slot"];
		await render(tui, terminal);
		tui.scrollBy(-5);
		await terminal.waitForRender();

		terminal.resize(80, 1);
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport().length, 1);
	});

	it("renders again after a stop -> start cycle", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const slot = new TestComponent();
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.start();
		scroll.lines = ["msg"];
		slot.lines = ["slot"];
		await render(tui, terminal);
		assert.strictEqual(terminal.getViewport()[9], "slot");

		tui.stop();
		// A render request lands while stopped (external editor / reload race).
		tui.requestRender();
		tui.start();
		scroll.lines = ["msg-2"];
		await terminal.waitForRender();
		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "msg-2");
		assert.strictEqual(viewport[9], "slot");
	});

	it("does not re-send unchanged kitty image lines every frame", async () => {
		class LoggingTerminal extends VirtualTerminal {
			writes: string[] = [];
			override write(data: string): void {
				this.writes.push(data);
				super.write(data);
			}
		}
		const terminal = new LoggingTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const slot = new TestComponent();
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.start();
		const imageLine = "\x1b_Ga=T,f=100,i=42,r=3;AAAA\x1b\\";
		scroll.lines = [...makeLines("msg", 10), imageLine, "", "", ...makeLines("tail", 10)];
		slot.lines = ["slot"];
		await render(tui, terminal);
		terminal.writes = [];

		// Second frame with unrelated change in the slot; the image is unchanged.
		slot.lines = ["slot-2"];
		await render(tui, terminal);
		const out = terminal.writes.join("");
		assert.ok(!out.includes("i=42"), "unchanged image must not be re-sent");
	});

	it("suppresses the sticky header while the anchored message is visible (dedup)", async () => {
		const { tui, terminal, scroll, slot } = await setupFullscreen(80, 10);
		// Message at transcript line 8 (of 30); provider anchors to it.
		tui.setStickyHeaderContent(() => ({ line: " ⏺ anchored", jumpTo: 8 }));
		scroll.lines = makeLines("msg", 30);
		slot.lines = ["slot"];
		await render(tui, terminal);
		// viewportHeight = 9; scrollTop = 5 → message line 8 is visible in the
		// viewport (jumpTo >= scrollTop) → header suppressed.
		tui.scrollBy(-16);
		await terminal.waitForRender();
		assert.ok(!tui.isStickyHeaderVisible());
		assert.strictEqual(terminal.getViewport()[3], "msg-9");
		// Scroll down past the message's start line (scrollTop = 9 > jumpTo):
		// it leaves the viewport at the top → header appears.
		tui.scrollBy(4);
		await terminal.waitForRender();
		assert.ok(tui.isStickyHeaderVisible());
		assert.strictEqual(terminal.getViewport()[0], " ⏺ anchored");
	});

	it("isolates the scroll badge from the row's background colour", async () => {
		class LoggingTerminal extends VirtualTerminal {
			writes: string[] = [];
			override write(data: string): void {
				this.writes.push(data);
				super.write(data);
			}
		}
		const terminal = new LoggingTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const slot = new TestComponent();
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.start();
		scroll.lines = makeLines("msg", 30);
		slot.lines = ["slot"];
		await render(tui, terminal);

		tui.scrollBy(-6);
		await terminal.waitForRender();
		const writes = terminal.writes.join("");
		// The badge must be preceded by a segment reset so a background colour
		// carried by the row's own content cannot bleed into the badge padding.
		const badgeIndex = writes.indexOf("\x1b[97;48;5;240m ↓");
		assert.ok(badgeIndex > 0, "badge should be written while scrolled up");
		const rowStart = writes.lastIndexOf("msg-24", badgeIndex);
		assert.ok(rowStart >= 0, "badge row should carry the msg-24 content");
		const between = writes.slice(rowStart, badgeIndex);
		assert.ok(
			between.includes("\x1b[0m"),
			`expected a reset between row content and badge, got: ${JSON.stringify(between.slice(0, 60))}`,
		);
	});

	it("draws the scroll badge white-on-gray and lifts the fill on pointer hover", async () => {
		class LoggingTerminal extends VirtualTerminal {
			writes: string[] = [];
			override write(data: string): void {
				this.writes.push(data);
				super.write(data);
			}
		}
		const terminal = new LoggingTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const slot = new TestComponent();
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.start();
		scroll.lines = makeLines("msg", 30);
		slot.lines = ["slot"];
		await render(tui, terminal);

		tui.scrollBy(-6);
		await terminal.waitForRender();
		assert.ok(
			terminal.writes.join("").includes("\x1b[97;48;5;240m ↓"),
			"default badge is bright-white on gray",
		);

		// Hover the badge (right-aligned on the viewport bottom row, row 9).
		terminal.writes = [];
		terminal.sendInput("\x1b[<35;79;9M");
		await terminal.waitForRender();
		assert.ok(
			terminal.writes.join("").includes("\x1b[97;48;5;244m ↓"),
			"hovered badge lifts to the lighter gray",
		);

		// Move the pointer off the badge: the base shade returns.
		terminal.writes = [];
		terminal.sendInput("\x1b[<35;10;9M");
		await terminal.waitForRender();
		const out = terminal.writes.join("");
		assert.ok(out.includes("\x1b[97;48;5;240m ↓"), "leaving the badge restores the base gray");
		assert.ok(!out.includes("\x1b[97;48;5;244m ↓"), "no stale hover shade after leaving");
	});

	it("lets the app re-theme the scroll badge, hover state included", async () => {
		const { tui, terminal, scroll, slot } = await setupFullscreen(80, 10);
		// The hook receives the padded label; its output must keep the same
		// visible width (5 cells here) or the row overflows.
		tui.setScrollIndicatorStyle((text, hovered) => (hovered ? `[${text.trim()}]` : `(${text.trim()})`));
		scroll.lines = makeLines("msg", 30);
		slot.lines = ["slot"];
		await render(tui, terminal);

		tui.scrollBy(-6);
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[8]!.includes("(↓ 6)"), "custom style renders the badge");

		terminal.sendInput("\x1b[<35;79;9M");
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[8]!.includes("[↓ 6]"), "custom style sees the hover flag");

		// Passing null restores the built-in default.
		tui.setScrollIndicatorStyle(null);
		await render(tui, terminal);
		assert.ok(!terminal.getViewport()[8]!.includes("[↓ 6]"), "null style clears the hook");
	});

	it("jumps to the bottom via Ctrl+End and to the top via Ctrl+Home", async () => {
		const { tui, terminal, scroll, slot } = await setupFullscreen(80, 10);
		scroll.lines = makeLines("msg", 30);
		slot.lines = ["slot"];
		await render(tui, terminal);

		tui.scrollBy(-6);
		await terminal.waitForRender();
		assert.ok(!tui.isFollowingOutput());

		terminal.sendInput("\x1b[8^"); // Ctrl+End (rxvt legacy sequence)
		await terminal.waitForRender();
		assert.ok(tui.isFollowingOutput(), "Ctrl+End returns to the bottom");
		assert.strictEqual(terminal.getViewport()[8], "msg-30");

		terminal.sendInput("\x1b[7^"); // Ctrl+Home (rxvt legacy sequence)
		await terminal.waitForRender();
		assert.ok(!tui.isFollowingOutput(), "Ctrl+Home leaves follow mode at the top");
		assert.strictEqual(terminal.getViewport()[0], "msg-1");
		// The badge reappears on the viewport bottom row: 21 lines are hidden below.
		assert.ok(terminal.getViewport()[8]!.startsWith("msg-9"), "top jump shows the oldest lines");
		assert.ok(terminal.getViewport()[8]!.includes("↓ 21"), "badge counts the lines below");
	});

	it("forwards wheel events to a takeover component with coordinates", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const slot = new TestComponent();
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.start();
		scroll.lines = makeLines("msg", 30);
		slot.lines = ["slot"];
		await render(tui, terminal);

		// Takeover: regions unmounted — wheel goes to the focused component.
		const takeover = new MouseAwareComponent();
		takeover.lines = ["takeover"];
		tui.clear();
		tui.addChild(takeover);
		tui.setFocus(takeover);
		await render(tui, terminal);

		terminal.sendInput("\x1b[<64;30;5M"); // wheel up at col=30 row=5
		await terminal.waitForRender();
		assert.strictEqual(takeover.mouse.length, 1);
		assert.strictEqual(takeover.mouse[0]!.type, "wheel");
		assert.strictEqual(takeover.mouse[0]!.button, 64);
		assert.strictEqual(takeover.mouse[0]!.col, 30);
		assert.strictEqual(takeover.mouse[0]!.row, 5);
		assert.strictEqual(takeover.mouse[0]!.slotRelative, false);
		// Transcript did not scroll (no regions mounted).
		assert.strictEqual(terminal.getViewport()[0], "takeover");
	});

	it("forwards wheel to a slot dialog with slot-relative rows", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const editor = new FocusableComponent();
		const dialog = new MouseAwareComponent();
		const slot = new Container();
		slot.addChild(editor);
		slot.addChild(dialog);
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.start();
		scroll.lines = makeLines("msg", 30);
		editor.lines = ["editor"];
		dialog.lines = ["dialog-1", "dialog-2"];
		tui.setFocus(dialog);
		await render(tui, terminal);
		// slot = editor(1) + dialog(2) = 3 rows → viewportHeight = 7
		terminal.sendInput("\x1b[<65;10;9M"); // wheel down at terminal row 9
		await terminal.waitForRender();
		assert.strictEqual(dialog.mouse.length, 1);
		assert.strictEqual(dialog.mouse[0]!.button, 65);
		assert.strictEqual(dialog.mouse[0]!.row, 2); // 9 - 7
		assert.strictEqual(dialog.mouse[0]!.slotRelative, true);
		// Transcript stayed put.
		assert.strictEqual(terminal.getViewport()[6], "msg-30");

		// While the editor (inside the scroll region... actually slot) — the
		// editor has no handleMouse, so the wheel falls back to transcript scroll.
		tui.setFocus(editor);
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<64;10;5M");
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[6]!.startsWith("msg-27"), true);
	});

	it("wheel over the viewport scrolls the transcript even when a slot dialog is focused", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const editor = new FocusableComponent();
		const dialog = new MouseAwareComponent();
		const slot = new Container();
		slot.addChild(editor);
		slot.addChild(dialog);
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.start();
		scroll.lines = makeLines("msg", 30);
		editor.lines = ["editor"];
		dialog.lines = ["dialog-1", "dialog-2"];
		tui.setFocus(dialog);
		await render(tui, terminal);
		// slot = 3 rows → viewportHeight = 7; wheel over row 5 (viewport area)
		terminal.sendInput("\x1b[<64;10;5M");
		await terminal.waitForRender();
		assert.strictEqual(dialog.mouse.length, 0, "dialog must not get viewport-area wheels");
		assert.strictEqual(terminal.getViewport()[6]!.startsWith("msg-27"), true);
		// Wheel over the slot (row 9) still goes to the dialog.
		terminal.sendInput("\x1b[<64;10;9M");
		await terminal.waitForRender();
		assert.strictEqual(dialog.mouse.length, 1);
	});

	it("wheel over a mouseScroll editor pans it; wheel over the viewport keeps scrolling the transcript", async () => {
		const terminal = new VirtualTerminal(80, 12);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const editor = new Editor(tui, defaultEditorTheme, { mouseScroll: true });
		const slot = new Container();
		slot.addChild(editor);
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.start();
		scroll.lines = makeLines("msg", 30);
		// 12 terminal rows → editor shows 5 content rows; 20 input lines overflow.
		editor.setText(makeLines("input", 20).join("\n"));
		tui.setFocus(editor);
		await render(tui, terminal);
		// slot = editor(7 rows) → viewportHeight = 5. Editor follows the cursor
		// at the end: 15 lines hidden above.
		assert.strictEqual(terminal.getViewport()[4], "msg-30");
		const editorTop = (): string => stripVTControlCharacters(terminal.getViewport()[5] ?? "");
		assert.ok(editorTop().includes("↑ 15 more"), editorTop());

		// Pointer over the transcript viewport (row 3 ≤ 5): transcript scrolls,
		// the editor window does not move.
		terminal.sendInput("\x1b[<64;10;3M");
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[4]!.startsWith("msg-27"), true);
		assert.ok(editorTop().includes("↑ 15 more"), editorTop());

		// Pointer over the editor (row 8 > 5): the editor pans three rows per
		// tick; the transcript stays where it was scrolled to.
		terminal.sendInput("\x1b[<64;10;8M");
		await terminal.waitForRender();
		assert.ok(editorTop().includes("↑ 12 more"), editorTop());
		assert.strictEqual(terminal.getViewport()[4]!.startsWith("msg-27"), true);
	});

	it("jumps to the bottom only when the click lands on the badge itself", async () => {
		const { tui, terminal, scroll, slot } = await setupFullscreen(80, 10);
		scroll.lines = makeLines("msg", 30);
		slot.lines = ["slot"];
		await render(tui, terminal);

		tui.scrollBy(-6);
		await terminal.waitForRender();
		assert.ok(!tui.isFollowingOutput());
		// Click the same row but far from the badge (left side): no jump.
		terminal.sendInput("\x1b[<0;10;9M");
		await terminal.waitForRender();
		assert.ok(!tui.isFollowingOutput());
		// Click on the badge (right-aligned, inside its width): jumps to bottom.
		terminal.sendInput("\x1b[<0;79;9M");
		await terminal.waitForRender();
		assert.ok(tui.isFollowingOutput());
	});

	it("declines forwarding when wantsMouseEvent returns false", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const picky = new MouseAwareComponent();
		(picky as { wantsMouseEvent?: () => boolean }).wantsMouseEvent = () => false;
		const slot = new Container();
		slot.addChild(picky);
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.start();
		scroll.lines = makeLines("msg", 30);
		picky.lines = ["picky"];
		tui.setFocus(picky);
		await render(tui, terminal);
		terminal.sendInput("\x1b[<64;10;9M");
		await terminal.waitForRender();
		assert.strictEqual(picky.mouse.length, 0, "declined events must not be forwarded");
		assert.strictEqual(terminal.getViewport()[8]!.startsWith("msg-27"), true);
	});

	it("swallows SGR mouse events instead of leaking them to components", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const editor = new FocusableComponent();
		const root = new Container();
		root.addChild(scroll);
		root.addChild(editor);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot: editor });
		tui.setFocus(editor);
		tui.start();
		scroll.lines = makeLines("msg", 5);
		editor.lines = ["editor"];
		await render(tui, terminal);

		terminal.sendInput("\x1b[<0;10;5M"); // left-click press mid-screen
		terminal.sendInput("\x1b[<0;10;5m"); // release
		terminal.sendInput("\x1b[<32;10;5M"); // drag-motion event
		await terminal.waitForRender();
		assert.deepStrictEqual(editor.input, []);
	});

	it("forwards left-press to the focused slot component with a component-relative row", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const panel = new MouseAwareComponent();
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
		panel.lines = makeLines("panel", 3);
		await render(tui, terminal);
		// The slot pins the panel's 3 lines to terminal rows 8-10; a click on
		// the panel's second line (row 9) arrives 0-based relative to it.
		terminal.sendInput("\x1b[<0;5;9M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 1);
		assert.strictEqual(panel.mouse[0]!.type, "press");
		assert.strictEqual(panel.mouse[0]!.row, 1);
		// A click on the transcript viewport is out of the panel's range.
		terminal.sendInput("\x1b[<0;5;3M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 1);
	});

	it("press row translation counts container chrome via rowsBeforeChild", async () => {
		class ChromeContainer extends Container {
			override rowsBeforeChild(): number {
				return 1;
			}
			override render(width: number): string[] {
				return ["chrome", ...super.render(width)];
			}
		}
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const panel = new MouseAwareComponent();
		const chrome = new ChromeContainer();
		chrome.addChild(panel);
		const slot = new Container();
		slot.addChild(chrome);
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.setFocus(panel);
		tui.start();
		scroll.lines = makeLines("msg", 30);
		panel.lines = makeLines("panel", 2);
		await render(tui, terminal);
		// Chrome renders one extra row above the panel: the panel's first line
		// sits one row below the slot top, so a click on the slot's first row
		// is chrome (dropped) and the next row is panel row 0.
		const slotTop = 10 - 3; // viewport shrinks by chrome(1) + panel(2)
		terminal.sendInput(`\x1b[<0;5;${slotTop + 1}M`);
		await terminal.waitForRender();
		terminal.sendInput(`\x1b[<0;5;${slotTop + 2}M`);
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 1);
		assert.strictEqual(panel.mouse[0]!.row, 0);
	});

	it("does not forward left-press when the focused component declines it", async () => {
		class DecliningComponent extends MouseAwareComponent {
			override wantsMouseEvent(): boolean {
				return false;
			}
		}
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const panel = new DecliningComponent();
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
		panel.lines = makeLines("panel", 2);
		await render(tui, terminal);
		terminal.sendInput("\x1b[<0;5;10M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 0);
	});

	it("routes wheel over a slot display panel to that panel (hover), not the focused editor", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const display = new MouseAwareComponent();
		const editorHolder = new Container();
		const editor = new MouseAwareComponent();
		editorHolder.addChild(editor);
		const slot = new Container();
		slot.addChild(display);
		slot.addChild(editorHolder);
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.setFocus(editor);
		tui.start();
		scroll.lines = makeLines("msg", 30);
		display.lines = makeLines("display", 2);
		editor.lines = makeLines("editor", 2);
		await render(tui, terminal);
		// Slot = display(2) + editor(2) pinned to rows 7-10: display rows 7-8,
		// editor rows 9-10. Wheel down over the display goes to the display with
		// a component-relative row.
		terminal.sendInput("\x1b[<65;5;8M");
		await terminal.waitForRender();
		assert.strictEqual(display.mouse.length, 1);
		assert.strictEqual(display.mouse[0]!.type, "wheel");
		assert.strictEqual(display.mouse[0]!.row, 1);
		// Wheel over the editor subtree goes to the focused editor (unchanged).
		terminal.sendInput("\x1b[<65;5;9M");
		await terminal.waitForRender();
		assert.strictEqual(display.mouse.length, 1);
		assert.strictEqual(editor.mouse.length, 1);
		// Wheel over the transcript viewport keeps scrolling the transcript.
		terminal.sendInput("\x1b[<65;5;3M");
		await terminal.waitForRender();
		assert.strictEqual(display.mouse.length, 1);
		assert.strictEqual(editor.mouse.length, 1);
		assert.strictEqual(terminal.getViewport()[2]!.startsWith("msg-"), true);
	});

	it("ignores wheel over a display panel that declines it", async () => {
		class DecliningPanel extends MouseAwareComponent {
			override wantsMouseEvent(): boolean {
				return false;
			}
		}
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const display = new DecliningPanel();
		const editor = new MouseAwareComponent();
		const slot = new Container();
		slot.addChild(display);
		slot.addChild(editor);
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.setFocus(editor);
		tui.start();
		scroll.lines = makeLines("msg", 30);
		display.lines = makeLines("display", 2);
		editor.lines = makeLines("editor", 2);
		await render(tui, terminal);
		terminal.sendInput("\x1b[<65;5;8M");
		await terminal.waitForRender();
		assert.strictEqual(display.mouse.length, 0);
	});

	it("enters alt-screen + mouse on start and restores on stop", async () => {
		class LoggingTerminal extends VirtualTerminal {
			writes: string[] = [];
			override write(data: string): void {
				this.writes.push(data);
				super.write(data);
			}
		}
		const terminal = new LoggingTerminal(80, 10);
		const tui = new TUI(terminal);
		tui.setFullscreen(true);
		tui.start();
		const startWrites = terminal.writes.join("");
		assert.ok(startWrites.includes("\x1b[?1049h"), "should enter alt-screen");
		assert.ok(startWrites.includes("\x1b[?1000h"), "should enable mouse reporting");
		assert.ok(startWrites.includes("\x1b[?1006h"), "should enable SGR mouse mode");
		assert.ok(startWrites.includes("\x1b[?1003h"), "should enable any-motion tracking");

		tui.stop();
		const stopWrites = terminal.writes.join("");
		assert.ok(stopWrites.includes("\x1b[?1003l"), "should disable any-motion tracking");
		assert.ok(stopWrites.includes("\x1b[?1000l"), "should disable mouse reporting");
		assert.ok(stopWrites.includes("\x1b[?1049l"), "should leave alt-screen");
	});
});

describe("TUI mouse motion (hover) routing", () => {
	async function setupSlotPanel() {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const panel = new MouseAwareComponent();
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
		panel.lines = makeLines("panel", 3);
		tui.requestRender(true);
		await terminal.waitForRender();
		return { tui, terminal, panel };
	}

	it("forwards motion with component-relative rows, deduped per cell", async () => {
		const { terminal, panel } = await setupSlotPanel();
		// The panel's 3 lines pin to terminal rows 8-10; row 9 → panel row 1.
		terminal.sendInput("\x1b[<35;5;9M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 1);
		assert.strictEqual(panel.mouse[0]!.type, "motion");
		assert.strictEqual(panel.mouse[0]!.row, 1);
		assert.strictEqual(panel.mouse[0]!.button, 3); // motion bit stripped, no button held

		// Same cell again: deduped, not forwarded.
		terminal.sendInput("\x1b[<35;5;9M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 1);

		// Same row, new column: forwarded (hover cells are per-position).
		terminal.sendInput("\x1b[<35;6;9M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 2);
		assert.strictEqual(panel.mouse[1]!.row, 1);

		// Drag motion (button held, bit 32 set) is motion with the held button.
		terminal.sendInput("\x1b[<32;7;9M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 3);
		assert.strictEqual(panel.mouse[2]!.type, "motion");
		assert.strictEqual(panel.mouse[2]!.button, 0);
	});

	it("delivers a hover-clear (row -1) when the pointer moves to the transcript", async () => {
		const { terminal, panel } = await setupSlotPanel();
		terminal.sendInput("\x1b[<35;5;9M"); // over the panel
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 1);

		terminal.sendInput("\x1b[<35;5;3M"); // over the transcript viewport
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 2);
		assert.strictEqual(panel.mouse[1]!.type, "motion");
		assert.strictEqual(panel.mouse[1]!.row, -1);
	});

	it("re-delivers the same cell after a focus change", async () => {
		const { tui, terminal, panel } = await setupSlotPanel();
		terminal.sendInput("\x1b[<35;5;9M");
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<35;5;9M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 1);

		// The dedupe key resets on focus change: the hover target under the
		// unchanged pointer cell is new and must be told.
		tui.setFocus(null);
		tui.setFocus(panel);
		terminal.sendInput("\x1b[<35;5;9M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 2);
	});

	it("skips the re-render when the handler returns false", async () => {
		class HoverTrackingComponent extends MouseAwareComponent {
			renderCount = 0;
			accept = true;
			override render(width: number): string[] {
				this.renderCount++;
				return super.render(width);
			}
			override handleMouse(event: import("../src/tui.ts").MouseEvent): void | boolean {
				super.handleMouse(event);
				return this.accept ? undefined : false;
			}
		}
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const panel = new HoverTrackingComponent();
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
		panel.lines = makeLines("panel", 3);
		tui.requestRender(true);
		await terminal.waitForRender();

		panel.accept = false;
		const before = panel.renderCount;
		terminal.sendInput("\x1b[<35;5;9M");
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<35;6;9M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 2, "both cells were delivered");
		assert.strictEqual(panel.renderCount, before, "no render scheduled for unchanged hover");

		panel.accept = true;
		terminal.sendInput("\x1b[<35;7;9M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 3);
		assert.ok(panel.renderCount > before, "a real change schedules a render");
	});

	it("does not forward motion when wantsMouseEvent declines it", async () => {
		class DecliningPanel extends MouseAwareComponent {
			override wantsMouseEvent(): boolean {
				return false;
			}
		}
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const panel = new DecliningPanel();
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
		panel.lines = makeLines("panel", 3);
		tui.requestRender(true);
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<35;5;9M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 0);
	});
});

describe("TUI transcript scrollbar", () => {
	// 80x10, 30-line transcript, 1-line slot: viewport rows 1-9, maxScroll 21,
	// thumb size round(9*9/30)=3.
	async function setupScrollable() {
		const { tui, terminal, scroll, slot } = await setupFullscreen(80, 10);
		scroll.lines = makeLines("msg", 30);
		slot.lines = ["slot"];
		await render(tui, terminal);
		return { tui, terminal, scroll };
	}

	it("reveals on the rightmost viewport column and hides off it", async () => {
		const { terminal } = await setupScrollable();
		assert.ok(!terminal.getViewport().some((line) => line.includes("░") || line.includes("█")));

		terminal.sendInput("\x1b[<35;80;5M"); // hover the bar's column
		await terminal.waitForRender();
		const shown = terminal.getViewport();
		// Following the bottom: thumb (size 3) sits at track rows 6-8.
		for (let row = 0; row < 9; row++) {
			const expected = row >= 6 ? "█" : "░";
			assert.ok(shown[row]!.endsWith(expected), `row ${row + 1}: ${JSON.stringify(shown[row])}`);
		}
		assert.ok(!shown[9]!.includes("░"), "slot row has no bar");

		terminal.sendInput("\x1b[<35;79;5M"); // move off the column
		await terminal.waitForRender();
		assert.ok(!terminal.getViewport().some((line) => line.includes("░") || line.includes("█")));
	});

	it("track press jumps to the pointed fraction; bottom re-engages follow", async () => {
		const { tui, terminal } = await setupScrollable();
		// The press starts a drag, so the bar is revealed while asserting — the
		// content check matches the line start; the last cell is the thumb.
		terminal.sendInput("\x1b[<0;80;1M"); // track top → transcript top
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[0]!.startsWith("msg-1"));
		assert.ok(!tui.isFollowingOutput());

		terminal.sendInput("\x1b[<0;80;5M"); // f = 4/8 → scrollTop round(10.5) = 11
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[0]!.startsWith("msg-12"));

		terminal.sendInput("\x1b[<0;80;9M"); // track bottom → bottom + follow
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[0]!.startsWith("msg-22"));
		assert.ok(tui.isFollowingOutput());
		terminal.sendInput("\x1b[<0;80;9m"); // release
		await terminal.waitForRender();
	});

	it("track press drags absolutely until the release", async () => {
		const { terminal } = await setupScrollable();
		terminal.sendInput("\x1b[<0;80;1M"); // press the bare track top → transcript top
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[0]!.startsWith("msg-1"));
		terminal.sendInput("\x1b[<32;80;5M"); // drag to the middle: scrollTop 11
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[0]!.startsWith("msg-12"));
		terminal.sendInput("\x1b[<32;80;2M"); // drag near the top: f = 1/8 → scrollTop 3
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[0]!.startsWith("msg-4"));
		// The bar stays revealed mid-drag even with the pointer off-column.
		terminal.sendInput("\x1b[<32;40;2M");
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[1]!.endsWith("█"));
		terminal.sendInput("\x1b[<0;40;2m"); // release off-column
		await terminal.waitForRender();
		// Plain motion afterwards does not scroll (hover only).
		terminal.sendInput("\x1b[<35;80;9M");
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[0]!.startsWith("msg-4"));
	});

	it("thumb press anchors the pointer and drags 1:1 from the grab", async () => {
		const { tui, terminal } = await setupScrollable();
		// Following the bottom: the thumb (size 3) sits at track rows 6-8.
		// Pressing row 8 grabs it 2 rows from its top — no jump.
		terminal.sendInput("\x1b[<0;80;9M");
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[0]!.startsWith("msg-22"), "grab holds the position");
		assert.ok(tui.isFollowingOutput(), "still following");
		// Drag up two rows: the thumb top follows 6→4 → scrollTop round(4/6*21) = 14.
		terminal.sendInput("\x1b[<32;80;7M");
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[0]!.startsWith("msg-15"));
		// Drag past the track top: the thumb clamps to row 0 → scrollTop 0.
		terminal.sendInput("\x1b[<32;80;1M");
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[0]!.startsWith("msg-1"));
		// The grab survives the pointer leaving the column.
		terminal.sendInput("\x1b[<32;40;9M");
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[0]!.startsWith("msg-22"), "drag continues off-column");
		terminal.sendInput("\x1b[<0;40;9m"); // release
		await terminal.waitForRender();
	});

	it("wheel scrolling keeps working with the bar revealed", async () => {
		const { terminal } = await setupScrollable();
		terminal.sendInput("\x1b[<35;80;5M"); // reveal
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<64;10;5M"); // wheel up over the transcript
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[0]!.startsWith("msg-19"));
		// The thumb followed the scroll: scrollTop 18 of 21 → offset 5 of 6.
		assert.ok(terminal.getViewport()[7]!.endsWith("█"));
		assert.ok(terminal.getViewport()[4]!.endsWith("░"));
	});

	it("stays hidden when the transcript fits the viewport", async () => {
		const { tui, terminal, scroll } = await setupScrollable();
		scroll.lines = makeLines("msg", 5);
		await render(tui, terminal);
		terminal.sendInput("\x1b[<35;80;3M");
		await terminal.waitForRender();
		assert.ok(!terminal.getViewport().some((line) => line.includes("░") || line.includes("█")));
	});

	it("leaves the scroll badge clickable off the bar's column", async () => {
		const { terminal } = await setupScrollable();
		terminal.sendInput("\x1b[<64;10;5M"); // scroll up → ↓N badge on row 9
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[8]!.includes("↓"));
		terminal.sendInput("\x1b[<0;77;9M"); // on the badge (cols 76-80), off the bar column
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[0]!.startsWith("msg-22"));
	});

	it("is shielded by an overlay covering the column", async () => {
		const { tui, terminal } = await setupScrollable();
		const dialog = new TestComponent();
		dialog.lines = makeLines("ov", 3); // covers screen rows 8-10, full width
		tui.showOverlay(dialog, { width: "100%", anchor: "bottom-left" });
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<35;80;9M"); // covered viewport row → no bar
		await terminal.waitForRender();
		assert.ok(!terminal.getViewport().some((line) => line.includes("░") || line.includes("█")));

		terminal.sendInput("\x1b[<35;80;3M"); // uncovered viewport row → bar
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[2]!.endsWith("░"));
	});
});


describe("TUI mouse coordinate translation (gutter inset + slot clip)", () => {
	// Mirrors the app-side GutterContainer: every child line is prefixed with
	// `inset` plain spaces, and the container reports that as its left inset.
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

	it("translates press and motion columns past a gutter container's left inset", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const panel = new MouseAwareComponent();
		const gutter = new InsetContainer(1);
		gutter.addChild(panel);
		const slot = new Container();
		slot.addChild(gutter);
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.setFocus(panel);
		tui.start();
		scroll.lines = makeLines("msg", 30);
		panel.lines = makeLines("panel", 3);
		tui.requestRender(true);
		await terminal.waitForRender();

		// The gutter renders one space before the panel, so terminal col 6 is
		// the panel's own col 5. Rows pin to 8-10 as without the gutter.
		terminal.sendInput("\x1b[<0;6;9M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 1);
		assert.strictEqual(panel.mouse[0]!.type, "press");
		assert.strictEqual(panel.mouse[0]!.row, 1);
		assert.strictEqual(panel.mouse[0]!.col, 5);

		// A press on the gutter column itself arrives as col 0 — the component
		// decides (its 1-based hit math cannot match it).
		terminal.sendInput("\x1b[<0;1;9M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 2);
		assert.strictEqual(panel.mouse[1]!.col, 0);

		// Motion gets the same column translation as presses.
		terminal.sendInput("\x1b[<35;8;9M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 3);
		assert.strictEqual(panel.mouse[2]!.type, "motion");
		assert.strictEqual(panel.mouse[2]!.col, 7);
	});

	it("translates rows past the clip when the slot is taller than the screen", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const panel = new MouseAwareComponent();
		const root = new Container();
		root.addChild(scroll);
		root.addChild(panel);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot: panel });
		tui.setFocus(panel);
		tui.start();
		scroll.lines = makeLines("msg", 30);
		panel.lines = makeLines("panel", 12);
		tui.requestRender(true);
		await terminal.waitForRender();

		// The slot's 12 lines exceed the screen: the top 3 are clipped, the
		// viewport keeps row 1, and visible slot rows 2-10 show lines 4-12.
		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[1], "panel-4");
		assert.strictEqual(viewport[9], "panel-12");

		// A click on the first visible slot row lands on the panel's clipped
		// line 3 (0-based), not on row 0.
		terminal.sendInput("\x1b[<0;5;2M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 1);
		assert.strictEqual(panel.mouse[0]!.type, "press");
		assert.strictEqual(panel.mouse[0]!.row, 3);

		// A click on the transcript viewport row above the visible slot maps to
		// a clipped-away line — not a panel hit.
		terminal.sendInput("\x1b[<0;5;1M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 1);

		// Motion over the last visible row lands on the panel's last line.
		terminal.sendInput("\x1b[<35;5;10M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 2);
		assert.strictEqual(panel.mouse[1]!.type, "motion");
		assert.strictEqual(panel.mouse[1]!.row, 11);

		// Motion on the viewport row is hover-clear, not a clipped line.
		terminal.sendInput("\x1b[<35;5;1M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 3);
		assert.strictEqual(panel.mouse[2]!.row, -1);
	});

	it("accumulates row chrome and col inset through nested containers", async () => {
		class ChromeContainer extends Container {
			override rowsBeforeChild(): number {
				return 1;
			}
			override leftInset(): number {
				return 1;
			}
			override render(width: number): string[] {
				return [
					" chrome",
					...super.render(Math.max(1, width - 1)).map((line) => ` ${line}`),
				];
			}
		}
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const panel = new MouseAwareComponent();
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
		tui.setFocus(panel);
		tui.start();
		scroll.lines = makeLines("msg", 30);
		panel.lines = makeLines("panel", 2);
		tui.requestRender(true);
		await terminal.waitForRender();

		// Slot = chrome(1) + panel(2) pinned to rows 8-10; the panel's first
		// line sits at row 9. Cols: chrome gutter 1 + inner inset 2 = 3, so
		// terminal col 9 is the panel's col 6.
		terminal.sendInput("\x1b[<0;9;9M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 1);
		assert.strictEqual(panel.mouse[0]!.row, 0);
		assert.strictEqual(panel.mouse[0]!.col, 6);

		// The chrome row above the panel is not a panel hit.
		terminal.sendInput("\x1b[<0;9;8M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 1);

		// Motion accumulates the same insets.
		terminal.sendInput("\x1b[<35;9;10M");
		await terminal.waitForRender();
		assert.strictEqual(panel.mouse.length, 2);
		assert.strictEqual(panel.mouse[1]!.type, "motion");
		assert.strictEqual(panel.mouse[1]!.row, 1);
		assert.strictEqual(panel.mouse[1]!.col, 6);
	});
});

describe("TUI inline mode (fullscreen off)", () => {
	class LoggingTerminal extends VirtualTerminal {
		writes: string[] = [];
		override write(data: string): void {
			this.writes.push(data);
			super.write(data);
		}
	}

	it("never enters alt-screen or enables mouse reporting", async () => {
		const terminal = new LoggingTerminal(80, 10);
		const tui = new TUI(terminal);
		const child = new TestComponent();
		child.lines = ["hello"];
		tui.addChild(child);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.getFullscreen(), false);
		const startWrites = terminal.writes.join("");
		assert.ok(!startWrites.includes("\x1b[?1049h"), "inline mode must not enter alt-screen");
		assert.ok(!startWrites.includes("\x1b[?1000h"), "inline mode must not enable mouse reporting");
		assert.ok(!startWrites.includes("\x1b[?1003h"), "inline mode must not enable any-motion tracking");
		assert.ok(!startWrites.includes("\x1b[?1006h"), "inline mode must not enable SGR mouse mode");
		assert.strictEqual(terminal.getViewport()[0], "hello");

		tui.stop();
		const stopWrites = terminal.writes.join("");
		assert.ok(!stopWrites.includes("\x1b[?1000l"), "mouse reporting was never enabled — nothing to disable");
		assert.ok(!stopWrites.includes("\x1b[?1003l"), "any-motion tracking was never enabled — nothing to disable");
		assert.ok(!stopWrites.includes("\x1b[?1049l"), "alt-screen was never entered — nothing to leave");
	});

	it("does not consume SGR mouse sequences — bytes reach the focused component", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const editor = new FocusableComponent();
		editor.lines = ["editor"];
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<64;10;5M");
		await terminal.waitForRender();
		assert.deepStrictEqual(editor.input, ["\x1b[<64;10;5M"]);
	});

	it("live-switching to inline mid-session disables mouse reporting and exits alt-screen", async () => {
		const terminal = new LoggingTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new TestComponent();
		const slot = new FocusableComponent();
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.setFocus(slot);
		tui.start();
		scroll.lines = makeLines("msg", 30);
		slot.lines = ["slot"];
		await render(tui, terminal);
		assert.strictEqual(tui.getFullscreen(), true);

		tui.setFullscreen(false);
		await terminal.waitForRender();
		assert.strictEqual(tui.getFullscreen(), false);
		const switchWrites = terminal.writes.join("");
		assert.ok(switchWrites.includes("\x1b[?1003l"), "should disable any-motion tracking");
		assert.ok(switchWrites.includes("\x1b[?1000l"), "should disable mouse reporting");
		assert.ok(switchWrites.includes("\x1b[?1006l"), "should disable SGR mouse mode");
		assert.ok(switchWrites.includes("\x1b[?1049l"), "should leave alt-screen");

		// A wheel event is no longer routed as a transcript scroll: the bytes
		// fall through to the focused component like any other input.
		terminal.sendInput("\x1b[<64;10;5M");
		await terminal.waitForRender();
		assert.deepStrictEqual(slot.input, ["\x1b[<64;10;5M"]);

		// The inline render path draws the whole tree into the normal buffer
		// (no viewport windowing): 31 content lines on 10 rows leave the
		// transcript tail and the slot at the bottom of the screen.
		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[8], "msg-30");
		assert.strictEqual(viewport[9], "slot");
	});
});

describe("TUI zone-less transcript child hover", () => {
	async function setupZonelessHover(): Promise<{
		tui: TUI;
		terminal: VirtualTerminal;
		scroll: Container;
	}> {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new Container();
		const slot = new TestComponent();
		slot.lines = ["slot"];
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.setTranscriptChildHoverStyle((row) => `\x1b[7m${row}\x1b[27m`);
		tui.start();
		await terminal.waitForRender();
		return { tui, terminal, scroll };
	}

	it("paints the hovered zone-less child's rows and clears on leave", async () => {
		const { tui, terminal, scroll } = await setupZonelessHover();
		const plain = new TestComponent();
		plain.lines = ["alpha", "beta"];
		scroll.addChild(plain);
		const other = new TestComponent();
		other.lines = ["gamma"];
		scroll.addChild(other);
		await render(tui, terminal);

		// Hover the second row of the first child (terminal row 2, 1-based).
		terminal.sendInput("\x1b[<35;5;2M");
		await terminal.waitForRender();
		const buffer = (terminal as unknown as { xterm: { buffer: { active: { getLine: (n: number) => { getCell: (c: number) => { isInverse: () => number } } | undefined } } } }).xterm.buffer.active;
		const inverseAt = (row: number): boolean => (buffer.getLine(row)?.getCell(0)?.isInverse() ?? 0) !== 0;
		assert.strictEqual(inverseAt(0), true);
		assert.strictEqual(inverseAt(1), true);
		assert.strictEqual(inverseAt(2), false);

		// Leaving the transcript clears the paint.
		terminal.sendInput("\x1b[<35;5;10M");
		await terminal.waitForRender();
		assert.strictEqual(inverseAt(0), false);
		assert.strictEqual(inverseAt(1), false);
	});

	it("does not paint when no style is registered", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const scroll = new Container();
		const slot = new TestComponent();
		slot.lines = ["slot"];
		const root = new Container();
		root.addChild(scroll);
		root.addChild(slot);
		tui.addChild(root);
		tui.setFullscreen(true);
		tui.setLayoutRegions({ scroll, slot });
		tui.start();
		const plain = new TestComponent();
		plain.lines = ["alpha"];
		scroll.addChild(plain);
		await render(tui, terminal);

		terminal.sendInput("\x1b[<35;5;1M");
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[0], "alpha");
	});
});

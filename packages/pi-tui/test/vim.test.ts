import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TUI } from "../src/tui.ts";
import { Cursor, MeasuredText } from "../src/vim/cursor.ts";
import type { VimMode } from "../src/vim/types.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Create a TUI with a virtual terminal for testing */
function createTestTUI(cols = 80, rows = 24): TUI {
	return new TUI(new VirtualTerminal(cols, rows));
}

const ESC = "\x1b";
const BACKSPACE = "\x7f";
const DELETE = "\x1b[3~";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const ENTER = "\r";

function createVimEditor(): Editor {
	const editor = new Editor(createTestTUI(), defaultEditorTheme);
	editor.setVimEnabled(true);
	return editor;
}

/** Type printable text into the editor one key at a time. */
function type(editor: Editor, text: string): void {
	for (const ch of text) {
		editor.handleInput(ch);
	}
}

/** Type text in INSERT mode, then switch to NORMAL with Escape. */
function typeThenNormal(editor: Editor, text: string): void {
	type(editor, text);
	editor.handleInput(ESC);
}

describe("Vim mode", () => {
	describe("mode switching", () => {
		it("starts in INSERT mode and fires onVimModeChange on transitions", () => {
			const editor = createVimEditor();
			const modes: VimMode[] = [];
			editor.onVimModeChange = (mode) => modes.push(mode);

			assert.strictEqual(editor.getVimMode(), "INSERT");
			editor.handleInput(ESC);
			assert.strictEqual(editor.getVimMode(), "NORMAL");
			type(editor, "i");
			assert.strictEqual(editor.getVimMode(), "INSERT");
			assert.deepStrictEqual(modes, ["NORMAL", "INSERT"]);
		});

		it("moves the cursor one char left when leaving INSERT (vim semantics)", () => {
			const editor = createVimEditor();
			type(editor, "abc");
			assert.strictEqual(editor.getCursorOffset(), 3);
			editor.handleInput(ESC);
			assert.strictEqual(editor.getCursorOffset(), 2);
		});

		it("does not move the cursor left at buffer start or after a newline", () => {
			const editor = createVimEditor();
			editor.handleInput(ESC);
			assert.strictEqual(editor.getCursorOffset(), 0);

			const editor2 = createVimEditor();
			type(editor2, "ab");
			editor2.handleInput("\n"); // INSERT-mode newline
			assert.strictEqual(editor2.getCursorOffset(), 3);
			editor2.handleInput(ESC);
			assert.strictEqual(editor2.getCursorOffset(), 3);
		});

		it("disabling vim mid-NORMAL drops back to INSERT and notifies", () => {
			const editor = createVimEditor();
			const modes: VimMode[] = [];
			editor.onVimModeChange = (mode) => modes.push(mode);
			editor.handleInput(ESC);
			assert.strictEqual(editor.getVimMode(), "NORMAL");
			editor.setVimEnabled(false);
			assert.strictEqual(editor.getVimMode(), null);
			assert.deepStrictEqual(modes, ["NORMAL", "INSERT"]);
		});
	});

	describe("NORMAL motions", () => {
		it("h/l/0/$/w/b/e move the cursor", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "hello world");
			// After Escape the cursor sits on the last char (offset 10).
			assert.strictEqual(editor.getCursorOffset(), 10);
			type(editor, "h");
			assert.strictEqual(editor.getCursorOffset(), 9);
			type(editor, "l");
			assert.strictEqual(editor.getCursorOffset(), 10);
			type(editor, "0");
			assert.strictEqual(editor.getCursorOffset(), 0);
			type(editor, "w");
			assert.strictEqual(editor.getCursorOffset(), 6);
			type(editor, "e");
			assert.strictEqual(editor.getCursorOffset(), 10);
			type(editor, "b");
			assert.strictEqual(editor.getCursorOffset(), 6);
			type(editor, "$");
			assert.strictEqual(editor.getCursorOffset(), 11);
		});

		it("w treats punctuation as its own word", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "foo.bar baz");
			type(editor, "0");
			type(editor, "w");
			assert.strictEqual(editor.getCursorOffset(), 3); // the '.'
			type(editor, "w");
			assert.strictEqual(editor.getCursorOffset(), 4); // 'bar'
		});

		it("j/k move by logical line, gg/G jump to first/last line", () => {
			const editor = createVimEditor();
			type(editor, "abc");
			editor.handleInput("\n");
			type(editor, "def");
			editor.handleInput("\n");
			type(editor, "ghi");
			editor.handleInput(ESC);

			type(editor, "gg");
			assert.strictEqual(editor.getCursorOffset(), 0);
			type(editor, "j");
			assert.strictEqual(editor.getCursorOffset(), 4);
			type(editor, "j");
			assert.strictEqual(editor.getCursorOffset(), 8);
			type(editor, "k");
			assert.strictEqual(editor.getCursorOffset(), 4);
			type(editor, "G");
			assert.strictEqual(editor.getCursorOffset(), 8);
			// j on the last logical line moves to the end of the text
			// (reference implementation semantics).
			type(editor, "2"); // count prefix
			type(editor, "j");
			assert.strictEqual(editor.getCursorOffset(), 11);
		});

		it("f/F/t find characters and ; repeats the last find", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "abcabc");
			type(editor, "0");
			type(editor, "f");
			type(editor, "c");
			assert.strictEqual(editor.getCursorOffset(), 2);
			type(editor, ";");
			assert.strictEqual(editor.getCursorOffset(), 5);
			type(editor, "F");
			type(editor, "c");
			assert.strictEqual(editor.getCursorOffset(), 2);
			type(editor, "0");
			type(editor, "t");
			type(editor, "c");
			assert.strictEqual(editor.getCursorOffset(), 1); // till = one before the match
		});

		it("arrow keys map to hjkl while a command is pending", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "ab");
			assert.strictEqual(editor.getCursorOffset(), 1);
			editor.handleInput(LEFT);
			assert.strictEqual(editor.getCursorOffset(), 0);
			editor.handleInput(RIGHT);
			assert.strictEqual(editor.getCursorOffset(), 1);
		});
	});

	describe("NORMAL operators", () => {
		it("dw deletes to the next word and stores it in the register", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "hello world");
			type(editor, "0");
			type(editor, "dw");
			assert.strictEqual(editor.getText(), "world");
			assert.strictEqual(editor.getCursorOffset(), 0);
		});

		it("cw changes to the end of the word and enters INSERT", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "hello world");
			type(editor, "0");
			type(editor, "cw");
			assert.strictEqual(editor.getText(), " world");
			assert.strictEqual(editor.getVimMode(), "INSERT");
			type(editor, "bye");
			assert.strictEqual(editor.getText(), "bye world");
		});

		it("dd deletes the current line, 2dd deletes two", () => {
			const editor = createVimEditor();
			type(editor, "abc");
			editor.handleInput("\n");
			type(editor, "def");
			editor.handleInput("\n");
			type(editor, "ghi");
			editor.handleInput(ESC);

			type(editor, "gg");
			type(editor, "dd");
			assert.strictEqual(editor.getText(), "def\nghi");

			type(editor, "2");
			type(editor, "dd");
			assert.strictEqual(editor.getText(), "");
		});

		it("d2w applies the count to the motion", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "one two three");
			type(editor, "0");
			type(editor, "d");
			type(editor, "2");
			type(editor, "w");
			assert.strictEqual(editor.getText(), "three");
		});

		it("x deletes the char under the cursor", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "abc");
			type(editor, "0");
			type(editor, "x");
			assert.strictEqual(editor.getText(), "bc");
		});

		it("r replaces the char under the cursor", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "abc");
			type(editor, "0");
			type(editor, "r");
			type(editor, "x");
			assert.strictEqual(editor.getText(), "xbc");
			assert.strictEqual(editor.getCursorOffset(), 0);
		});

		it("~ toggles case", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "aBc");
			type(editor, "0");
			type(editor, "~");
			assert.strictEqual(editor.getText(), "ABc");
		});

		it("J joins lines", () => {
			const editor = createVimEditor();
			type(editor, "abc");
			editor.handleInput("\n");
			type(editor, "def");
			editor.handleInput(ESC);
			type(editor, "k");
			type(editor, "J");
			assert.strictEqual(editor.getText(), "abc def");
		});

		it(">> indents and << dedents the current line", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "abc");
			type(editor, ">");
			type(editor, ">");
			assert.strictEqual(editor.getText(), "  abc");
			assert.strictEqual(editor.getCursorOffset(), 2);
			type(editor, "<");
			type(editor, "<");
			assert.strictEqual(editor.getText(), "abc");
		});

		it("A appends at end of line, o opens a line below", () => {
			const editor = createVimEditor();
			type(editor, "abc");
			editor.handleInput("\n");
			type(editor, "def");
			editor.handleInput(ESC);
			type(editor, "k");
			type(editor, "A");
			assert.strictEqual(editor.getVimMode(), "INSERT");
			assert.strictEqual(editor.getCursorOffset(), 3);
			editor.handleInput(ESC);
			type(editor, "o");
			assert.strictEqual(editor.getVimMode(), "INSERT");
			assert.strictEqual(editor.getText(), "abc\n\ndef");
		});

		it("diw deletes the inner word (text objects come with the core)", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "foo bar");
			type(editor, "0");
			type(editor, "w"); // on 'b'
			type(editor, "d");
			type(editor, "i");
			type(editor, "w");
			assert.strictEqual(editor.getText(), "foo ");
		});
	});

	describe("register, paste and dot-repeat", () => {
		it("yy followed by p duplicates the line below", () => {
			const editor = createVimEditor();
			type(editor, "abc");
			editor.handleInput("\n");
			type(editor, "def");
			editor.handleInput(ESC);
			type(editor, "k");
			type(editor, "yy");
			type(editor, "p");
			assert.strictEqual(editor.getText(), "abc\nabc\ndef");
		});

		it("dw followed by p pastes the deleted word after the cursor", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "hello world");
			type(editor, "0");
			type(editor, "dw");
			assert.strictEqual(editor.getText(), "world");
			type(editor, "$");
			type(editor, "p");
			assert.strictEqual(editor.getText(), "worldhello ");
		});

		it(". repeats the last operator change", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "hello world foo");
			type(editor, "0");
			type(editor, "dw");
			assert.strictEqual(editor.getText(), "world foo");
			type(editor, ".");
			assert.strictEqual(editor.getText(), "foo");
		});

		it(". repeats the last insert", () => {
			const editor = createVimEditor();
			type(editor, "abc");
			editor.handleInput(ESC);
			type(editor, ".");
			assert.strictEqual(editor.getText(), "ababcc");
		});
	});

	describe("undo and escape routing", () => {
		it("u undoes the last vim operation", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "hello world");
			type(editor, "0");
			type(editor, "dw");
			assert.strictEqual(editor.getText(), "world");
			type(editor, "u");
			assert.strictEqual(editor.getText(), "hello world");
		});

		it("INSERT Escape is consumed, NORMAL Escape falls through and cancels pending commands", () => {
			const editor = createVimEditor();
			type(editor, "ab");
			// INSERT: consumed by vim (mode switch).
			assert.strictEqual(editor.vimRouteInput(ESC), true);
			assert.strictEqual(editor.getVimMode(), "NORMAL");

			// Start a pending operator, then cancel it with Escape.
			type(editor, "d");
			assert.strictEqual(editor.vimRouteInput(ESC), false);
			// The pending operator is gone: 'w' now moves instead of deleting.
			type(editor, "w");
			assert.strictEqual(editor.getText(), "ab");
			assert.strictEqual(editor.getCursorOffset(), 2);
		});

		it("ctrl chords and Enter fall through in both modes", () => {
			const editor = createVimEditor();
			assert.strictEqual(editor.vimRouteInput("\x03"), false); // ctrl+c
			editor.handleInput(ESC); // NORMAL
			assert.strictEqual(editor.vimRouteInput("\x03"), false);
			assert.strictEqual(editor.vimRouteInput(ENTER), false);
			assert.strictEqual(editor.vimRouteInput("\x1b[200~pasted"), false); // paste stream
		});

		it("NORMAL mode submits through Enter with the vim state intact", () => {
			const editor = createVimEditor();
			let submitted: string | undefined;
			editor.onSubmit = (text) => {
				submitted = text;
			};
			typeThenNormal(editor, "hi");
			editor.handleInput(ENTER);
			assert.strictEqual(submitted, "hi");
			assert.strictEqual(editor.getVimMode(), "NORMAL");
		});
	});

	describe("redo (Ctrl-R)", () => {
		const CTRL_R = "\x12";

		it("Ctrl-R in NORMAL redoes what u undid", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "hello world");
			type(editor, "0");
			type(editor, "dw");
			assert.strictEqual(editor.getText(), "world");
			type(editor, "u");
			assert.strictEqual(editor.getText(), "hello world");
			editor.handleInput(CTRL_R);
			assert.strictEqual(editor.getText(), "world");
		});

		it("is consumed in NORMAL and falls through in INSERT and when disabled", () => {
			const editor = createVimEditor();
			assert.strictEqual(editor.vimRouteInput(CTRL_R), false); // INSERT
			editor.handleInput(ESC); // NORMAL
			assert.strictEqual(editor.vimRouteInput(CTRL_R), true);

			const plain = new Editor(createTestTUI(), defaultEditorTheme);
			assert.strictEqual(plain.vimRouteInput(CTRL_R), false);
		});

		it("is a no-op when there is nothing to redo", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "ab");
			editor.handleInput(CTRL_R);
			assert.strictEqual(editor.getText(), "ab");
			assert.strictEqual(editor.getVimMode(), "NORMAL");
		});

		it("a fresh edit clears the redo future", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "hello world");
			type(editor, "0");
			type(editor, "dw");
			type(editor, "u");
			assert.strictEqual(editor.getText(), "hello world");
			// Insert new text: the undone dw can no longer be redone.
			type(editor, "i");
			type(editor, "X");
			editor.handleInput(ESC);
			editor.handleInput(CTRL_R);
			assert.strictEqual(editor.getText(), "Xhello world");
		});

		it("cancels a pending command instead of executing it", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "ab");
			type(editor, "d"); // pending delete operator
			editor.handleInput(CTRL_R);
			// 'w' now moves instead of deleting: the operator was cancelled.
			type(editor, "w");
			assert.strictEqual(editor.getText(), "ab");
		});
	});

	describe("lines <-> offset adapter", () => {
		it("round-trips positions on multi-line text", () => {
			const editor = createVimEditor();
			editor.setText("abc\ndef\nghi");
			const cases: Array<[number, number, number]> = [
				[0, 0, 0],
				[0, 3, 3],
				[1, 0, 4],
				[1, 2, 6],
				[2, 3, 11],
			];
			for (const [line, col, offset] of cases) {
				editor.setCursorOffset(offset);
				assert.deepStrictEqual(editor.getCursor(), { line, col });
				assert.strictEqual(editor.getCursorOffset(), offset);
			}
		});

		it("clamps out-of-range offsets to the end of the buffer", () => {
			const editor = createVimEditor();
			editor.setText("ab\ncd");
			editor.setCursorOffset(999);
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 2 });
			assert.strictEqual(editor.getCursorOffset(), 5);
		});
	});

	describe("vim disabled", () => {
		it("passes every key through unchanged (zero behavior change)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			assert.strictEqual(editor.getVimMode(), null);
			assert.strictEqual(editor.vimRouteInput("h"), false);
			assert.strictEqual(editor.vimRouteInput(ESC), false);

			type(editor, "hjkl");
			assert.strictEqual(editor.getText(), "hjkl");

			// Escape does nothing editor-level (host handles it), text stays.
			editor.handleInput(ESC);
			assert.strictEqual(editor.getText(), "hjkl");
			assert.strictEqual(editor.getVimMode(), null);
		});
	});

	describe("rendering", () => {
		it("renders without crashing in NORMAL mode", () => {
			const editor = createVimEditor();
			typeThenNormal(editor, "hello world");
			const lines = editor.render(80);
			assert.ok(lines.length >= 3);
		});
	});
});

describe("Vim Cursor chip snapping", () => {
	function cursorAt(text: string, offset: number): Cursor {
		return new Cursor(new MeasuredText(text, 80), offset);
	}

	it("snaps offsets out of [paste #N ...] markers", () => {
		const text = "[paste #1 +2 lines] x";
		assert.strictEqual(cursorAt(text, 5).snapOutOfImageRef(5, "start"), 0);
		assert.strictEqual(cursorAt(text, 5).snapOutOfImageRef(5, "end"), 19);
	});

	it("snaps offsets out of [image #N (WxH)] placeholders", () => {
		const text = "[image #1 (640×480)] x";
		assert.strictEqual(cursorAt(text, 8).snapOutOfImageRef(8, "start"), 0);
		assert.strictEqual(cursorAt(text, 8).snapOutOfImageRef(8, "end"), 20);
	});

	it("left/right hop over chips instead of stepping into them", () => {
		const text = "a[paste #1 3 chars]b";
		// The marker spans offsets 1..19; right from 'a' (offset 1) hops past it.
		assert.strictEqual(cursorAt(text, 1).right().offset, 19);
		assert.strictEqual(cursorAt(text, 19).left().offset, 1);
	});
});

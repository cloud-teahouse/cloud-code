import assert from "node:assert";
import { describe, it } from "node:test";
import {
	type KeybindingDefinitions,
	KeybindingsManager,
	TUI_KEYBINDINGS,
} from "../src/keybindings.ts";

describe("KeybindingsManager", () => {
	it("binds Ctrl+J as a default newline alias", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		assert.deepStrictEqual(keybindings.getKeys("tui.input.newLine"), ["shift+enter", "ctrl+j"]);
		assert.strictEqual(keybindings.matches("\n", "tui.input.newLine"), true);
		assert.strictEqual(keybindings.matches("\x1b[106;5u", "tui.input.newLine"), true);
	});

	it("binds Ctrl+Home/End as transcript top/bottom jumps", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		assert.deepStrictEqual(keybindings.getKeys("tui.scroll.top"), ["ctrl+home"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.scroll.bottom"), ["ctrl+end"]);
		// rxvt legacy sequences.
		assert.strictEqual(keybindings.matches("\x1b[7^", "tui.scroll.top"), true);
		assert.strictEqual(keybindings.matches("\x1b[8^", "tui.scroll.bottom"), true);
		// Plain Home/End must not trigger the transcript jumps.
		assert.strictEqual(keybindings.matches("\x1b[H", "tui.scroll.top"), false);
		assert.strictEqual(keybindings.matches("\x1b[F", "tui.scroll.bottom"), false);
	});

	it("does not evict selector confirm when input submit is rebound", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": ["enter", "ctrl+enter"],
		});

		assert.deepStrictEqual(keybindings.getKeys("tui.input.submit"), ["enter", "ctrl+enter"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.select.confirm"), ["enter"]);
	});

	it("does not evict cursor bindings when another action reuses the same key", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.select.up": ["up", "ctrl+p"],
		});

		assert.deepStrictEqual(keybindings.getKeys("tui.select.up"), ["up", "ctrl+p"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorUp"), ["up"]);
	});

	it("still reports direct user binding conflicts without evicting defaults", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": "ctrl+x",
			"tui.select.confirm": "ctrl+x",
		});

		assert.deepStrictEqual(keybindings.getConflicts(), [
			{
				key: "ctrl+x",
				keybindings: ["tui.input.submit", "tui.select.confirm"],
			},
		]);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorLeft"), ["left", "ctrl+b"]);
	});
});

declare module "../src/keybindings.ts" {
	interface Keybindings {
		"test.global": true;
		"test.chatOnly": true;
		"test.appWide": true;
	}
}

const CONTEXT_DEFINITIONS = {
	"test.global": { defaultKeys: "ctrl+g" },
	"test.chatOnly": { defaultKeys: "ctrl+o", context: "app/chat" },
	"test.appWide": { defaultKeys: "ctrl+b", context: "app" },
} as const satisfies KeybindingDefinitions;

describe("KeybindingsManager contexts", () => {
	it("matches context-less bindings regardless of active contexts", () => {
		const keybindings = new KeybindingsManager(CONTEXT_DEFINITIONS);
		assert.strictEqual(keybindings.matches("\x07", "test.global"), true);

		keybindings.setActiveContexts(["app/chat"]);
		assert.strictEqual(keybindings.matches("\x07", "test.global"), true);
	});

	it("does not match a context binding while its context is inactive", () => {
		const keybindings = new KeybindingsManager(CONTEXT_DEFINITIONS);
		assert.strictEqual(keybindings.matches("\x0f", "test.chatOnly"), false);

		keybindings.setActiveContexts(["app/dialog"]);
		assert.strictEqual(keybindings.matches("\x0f", "test.chatOnly"), false);
	});

	it("matches a context binding once its context is active", () => {
		const keybindings = new KeybindingsManager(CONTEXT_DEFINITIONS);
		keybindings.setActiveContexts(["app/chat"]);
		assert.strictEqual(keybindings.matches("\x0f", "test.chatOnly"), true);
	});

	it("activates ancestor contexts by prefix", () => {
		const keybindings = new KeybindingsManager(CONTEXT_DEFINITIONS);
		assert.strictEqual(keybindings.matches("\x02", "test.appWide"), false);

		keybindings.setActiveContexts(["app/chat"]);
		assert.strictEqual(keybindings.matches("\x02", "test.appWide"), true);
	});

	it("returns the active contexts via getActiveContexts", () => {
		const keybindings = new KeybindingsManager(CONTEXT_DEFINITIONS);
		assert.deepStrictEqual(keybindings.getActiveContexts(), []);

		keybindings.setActiveContexts(["app/chat"]);
		assert.deepStrictEqual(keybindings.getActiveContexts(), ["app/chat"]);
	});

	it("applies user overrides to context bindings without changing their context", () => {
		const keybindings = new KeybindingsManager(CONTEXT_DEFINITIONS, {
			"test.chatOnly": "ctrl+p",
		});
		assert.strictEqual(keybindings.matches("\x10", "test.chatOnly"), false);

		keybindings.setActiveContexts(["app/chat"]);
		assert.strictEqual(keybindings.matches("\x10", "test.chatOnly"), true);
		assert.strictEqual(keybindings.matches("\x0f", "test.chatOnly"), false);
	});

	it("hasDefinition reports known ids", () => {
		const keybindings = new KeybindingsManager(CONTEXT_DEFINITIONS);
		assert.strictEqual(keybindings.hasDefinition("test.chatOnly"), true);
		assert.strictEqual(keybindings.hasDefinition("test.unknown"), false);
	});
});

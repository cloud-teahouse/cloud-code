/**
 * Property tests for the Markdown component's incremental streaming renderer.
 *
 * Streaming assistant messages call setText() with a growing buffer and render
 * after every delta. The incremental path caches rendered lines of "stable"
 * regions (split at safe blank-run boundaries) and re-renders only the live
 * tail. The observable contract is that at every single point of the stream —
 * every prefix of the document — the rendered lines are exactly those of a
 * fresh component rendering that prefix in one shot.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

const CORPUS: Record<string, string> = {
	"plain paragraphs with blank runs":
		"First paragraph here.\n\n\nSecond paragraph after a long blank run.\n   \nThird after whitespace-only line.\n",
	"headings and hr":
		"# Title\n\nSome text\n\n## Sub\n\nsetext\n===\n\n---\n\nafter hr\n",
	"inline styles":
		"Text with **bold**, *italic*, `code`, ~~strike~~ and [a link](https://example.com) inline.\n\nMore **bold _nested_ styles** here.\n",
	"fenced code closed":
		"Before\n\n```ts\nconst a = 1;\nconst b = a[0]: string;\n```\n\nAfter the block.\n",
	"fenced code unclosed then closed":
		"Text\n\n```python\ndef f():\n    return 1\n\nmore code after blank\n```\n\ntail\n",
	"tilde fence": "Intro\n\n~~~\nraw `backticks` inside\n~~~\n\noutro\n",
	"fence with blank lines inside":
		"```\nline1\n\nline2\n\n\nline3\n```\n\ndone\n",
	"lists tight and ordered":
		"Shopping:\n\n- apples\n- oranges\n  - nested\n\n1. one\n2. two\n10. ten\n",
	"loose list": "- first\n\n- second\n\n- third\n",
	"list with indented continuation": "- item one\n\n  continuation paragraph\n\nafter\n",
	"task list": "- [ ] todo\n- [x] done\n\nplain\n",
	"blockquotes": "> quoted line\n\n> second quote\n\nplain text\n",
	"blockquote lazy": "> quote\nlazy continuation\n\nafter\n",
	"blockquote with fence": "> ```\n> code\n> ```\n\nafter quote\n",
	"table": "| Name | Value |\n| ---- | ----- |\n| a    | 1     |\n| b    | 2     |\n\nafter table\n",
	"link reference definition":
		"See [the docs][docs] for details.\n\n[docs]: https://example.com/docs\n\nafter def\n",
	"raw html block": "Text before\n\n<div class=\"x\">\nhtml content\n\nmore html\n</div>\n\nafter html\n",
	"html-looking code fence":
		"```html\n<div>\n  <span>x</span>\n</div>\n\nafter\n",
	"crlf endings": "line one\r\n\r\nline two\r\n- item\r\n- item2\r\n",
	"tabs and cjk": "\tindented with tab\n\n中文内容的一行文字需要换行测试一下下\n\nemoji 🎉🎉 text\n",
	"long unbroken token":
		"Before\n\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n\nafter\n",
	"ends with blank run": "content line\n\n",
	"list ends before blank at eof": "- a\n- b\n\n",
	"setext underline after blank": "some text\n\n---\n\nmore\n",
	"ordered list big marker": "1. first\n\n10. tenth\n\nafter\n",
	"quote then indented": "> quote\n\n  indented para\n",
};

function fresh(prefix: string, width: number, paddingY = 0): string[] {
	return new Markdown(prefix, 0, paddingY, defaultMarkdownTheme).render(width);
}

function checkpoints(length: number, stride: number): number[] {
	const points = new Set<number>();
	for (let i = 1; i <= length; i += 1) points.add(i);
	if (stride > 1) {
		points.clear();
		for (let i = stride; i <= length; i += stride) points.add(i);
		points.add(length);
	}
	return [...points].sort((a, b) => a - b);
}

describe("Markdown incremental streaming renderer", () => {
	for (const [name, doc] of Object.entries(CORPUS)) {
		it(`matches fresh renders for every prefix: ${name} (char-by-char @ 40,80)`, () => {
			for (const width of [40, 80]) {
				const streaming = new Markdown("", 0, 0, defaultMarkdownTheme);
				for (let i = 1; i <= doc.length; i += 1) {
					const prefix = doc.slice(0, i);
					streaming.setText(prefix);
					assert.deepStrictEqual(
						streaming.render(width),
						fresh(prefix, width),
						`${name}: prefix ${String(i)}/${String(doc.length)} @ width ${String(width)}: ${JSON.stringify(prefix)}`,
					);
				}
			}
		});

		it(`matches fresh renders at strided prefixes: ${name} (widths 10,20,120)`, () => {
			for (const width of [10, 20, 120]) {
				const streaming = new Markdown("", 0, 0, defaultMarkdownTheme);
				const stride = Math.max(1, Math.floor(doc.length / 60));
				for (const i of checkpoints(doc.length, stride)) {
					const prefix = doc.slice(0, i);
					streaming.setText(prefix);
					assert.deepStrictEqual(
						streaming.render(width),
						fresh(prefix, width),
						`${name}: prefix ${String(i)}/${String(doc.length)} @ width ${String(width)}: ${JSON.stringify(prefix)}`,
					);
				}
			}
		});
	}

	it("matches fresh renders with vertical padding", () => {
		const doc = CORPUS["headings and hr"]!;
		const streaming = new Markdown("", 0, 1, defaultMarkdownTheme);
		for (let i = 1; i <= doc.length; i += 1) {
			const prefix = doc.slice(0, i);
			streaming.setText(prefix);
			assert.deepStrictEqual(streaming.render(60), fresh(prefix, 60, 1), `prefix ${String(i)}`);
		}
	});

	it("matches fresh renders after width changes mid-stream", () => {
		const doc = CORPUS["lists tight and ordered"]! + CORPUS["table"]!;
		const streaming = new Markdown("", 0, 0, defaultMarkdownTheme);
		let width = 30;
		for (let i = 1; i <= doc.length; i += 1) {
			const prefix = doc.slice(0, i);
			if (i % 17 === 0) width = width === 30 ? 90 : 30;
			streaming.setText(prefix);
			assert.deepStrictEqual(streaming.render(width), fresh(prefix, width), `prefix ${String(i)}`);
		}
	});

	it("matches fresh renders after invalidate() (theme-change path)", () => {
		const doc = CORPUS["fenced code unclosed then closed"]!;
		const streaming = new Markdown(doc.slice(0, 40), 0, 0, defaultMarkdownTheme);
		streaming.render(50);
		streaming.invalidate();
		assert.deepStrictEqual(streaming.render(50), fresh(doc.slice(0, 40), 50));
		streaming.setText(doc);
		assert.deepStrictEqual(streaming.render(50), fresh(doc, 50));
	});

	it("matches fresh renders after a non-append setText", () => {
		const streaming = new Markdown("", 0, 0, defaultMarkdownTheme);
		streaming.setText(CORPUS["loose list"]!);
		streaming.render(50);
		streaming.setText("completely different\n\ntext");
		assert.deepStrictEqual(streaming.render(50), fresh("completely different\n\ntext", 50));
		streaming.setText("short");
		assert.deepStrictEqual(streaming.render(50), fresh("short", 50));
	});

	it("actually reuses stable regions once a boundary is confirmed (perf guard)", () => {
		const streaming = new Markdown("", 0, 0, defaultMarkdownTheme);
		streaming.setText("para one\n\npara two\n");
		streaming.render(80);
		const inc = (streaming as unknown as { inc: { stableLen: number; fallback: boolean } }).inc;
		assert.ok(inc.stableLen > 0, "expected a stabilized region");
		assert.strictEqual(inc.fallback, false);
	});

	it("falls back to full render on link reference definitions", () => {
		const streaming = new Markdown("", 0, 0, defaultMarkdownTheme);
		streaming.setText(CORPUS["link reference definition"]!);
		streaming.render(80);
		const inc = (streaming as unknown as { inc: { fallback: boolean } }).inc;
		assert.strictEqual(inc.fallback, true);
	});

	it("falls back to full render on raw html blocks", () => {
		const streaming = new Markdown("", 0, 0, defaultMarkdownTheme);
		streaming.setText(CORPUS["raw html block"]!);
		streaming.render(80);
		const inc = (streaming as unknown as { inc: { fallback: boolean } }).inc;
		assert.strictEqual(inc.fallback, true);
	});

	it("does not fall back for def/html-looking lines inside code fences", () => {
		const streaming = new Markdown("", 0, 0, defaultMarkdownTheme);
		streaming.setText(CORPUS["html-looking code fence"]!);
		streaming.render(80);
		const inc = (streaming as unknown as { inc: { fallback: boolean } }).inc;
		assert.strictEqual(inc.fallback, false);
	});
});

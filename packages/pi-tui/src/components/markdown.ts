import { Marked, type Token, Tokenizer, type Tokens } from "marked";
import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.ts";
import type { Component } from "../tui.ts";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.ts";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2]!;
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

function trimPartialClosingFences(tokens: readonly Token[]): void {
	const token = tokens[tokens.length - 1];
	if (token?.type === "list") {
		trimPartialClosingFences(token.items[token.items.length - 1]?.tokens ?? []);
		return;
	}
	if (token?.type === "blockquote") {
		trimPartialClosingFences(token.tokens ?? []);
		return;
	}
	if (token?.type !== "code") {
		return;
	}

	// Trim streamed partial closing fences so code blocks do not shrink/flicker
	// when the final fence character arrives. See https://github.com/earendil-works/pi/issues/5825.
	const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
	const lastLine = token.raw.split("\n").pop();
	if (!marker || !lastLine || lastLine.length >= marker.length || lastLine !== marker[0]?.repeat(lastLine.length)) {
		return;
	}

	token.text = token.text.slice(0, -lastLine.length).replace(/\n$/, "");
}

const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});

// ── Incremental streaming state ─────────────────────────────────────────
//
// Assistant messages stream in token by token; re-lexing and re-wrapping the
// whole growing buffer on every delta is O(n²). The renderer therefore splits
// the normalized text into regions at "safe" blank-run boundaries: a region
// whose tokens can no longer be affected by text arriving later is rendered
// once and its final lines are cached (keyed by width); only the live tail
// region is re-rendered per delta.
//
// A boundary at the start of a blank run is SAFE only when no markdown
// construct can span it:
// - fenced code blocks can cross blank lines -> fence state is tracked line
//   by line and boundaries are only confirmed while outside a fence;
// - loose lists and list-item continuations can cross blank lines -> a
//   boundary is rejected when the first line after the blank run is indented,
//   starts with a list marker, or starts a blockquote (blockquote lazily
//   carrying an unclosed fence is the quote hazard);
// - link reference definitions are document-scoped and raw HTML blocks can
//   cross blank lines -> seeing either anywhere outside a fence switches the
//   component to the plain full-render path permanently (both are rare in
//   streamed assistant output).
//
// Blank runs themselves always live at the START of the following region, so
// the single space token each run produces is rendered inside that region and
// the concatenation of region outputs is token-for-token identical to a full
// document render. `trimPartialClosingFences` runs only on the live tail (it
// only ever affects the document's last token chain, which lives there).

/** A blank line (tabs are expanded to spaces during normalization). */
const BLANK_LINE_RE = /^ *$/;
/** List item opener, conservative superset of CommonMark markers. */
const LIST_MARKER_RE = /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:\s|$)/;
/** Blockquote opener. */
const QUOTE_RE = /^ {0,3}>/;
/** Possible link reference definition, incl. quote/list-prefixed ones. */
const REF_DEF_RE = /^ {0,3}(?:(?:> ?)*|(?:[-+*]|\d{1,9}[.)]) +)\[[^\]]*\]:/;
/** Possible raw HTML block start, incl. quote/list-prefixed ones. */
const HTML_BLOCK_RE = /^ {0,3}(?:(?:> ?)*|(?:[-+*]|\d{1,9}[.)]) +)<[A-Za-z!?/]/;
/** Fence opener. Backtick fences may not have a backtick in the info string. */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

function countLeadingSpaces(line: string): number {
	let i = 0;
	while (line[i] === " ") i++;
	return i;
}

/**
 * Whether `line` closes a fence opened with `len` markers of `char`: up to 3
 * leading spaces, a run of at least `len` markers, nothing but whitespace
 * after (a closing fence cannot carry an info string).
 */
function isFenceClose(line: string, char: string, len: number): boolean {
	const start = countLeadingSpaces(line);
	if (start > 3) return false;
	let run = 0;
	while (line[start + run] === char) run++;
	if (run < len) return false;
	return /^[ \t]*$/.test(line.slice(start + run));
}

interface IncrementalState {
	/** Raw text the state was built from (append detection). */
	raw: string;
	/** Full normalized text (tabs expanded). */
	normalized: string;
	/** Width `stableLines` were rendered at; regions re-render on change. */
	width: number;
	/** Length of the normalized prefix rendered into `stableLines`. */
	stableLen: number;
	/** Confirmed safe boundary offsets (blank-run starts), ascending. */
	boundaries: number[];
	/** How many boundaries have been rendered into `stableLines`. */
	stableBoundaryCount: number;
	/** Final rendered lines of the stable prefix (paddingY excluded). */
	stableLines: string[];
	/** Scanner cursor: offset up to which complete lines were scanned. */
	scanPos: number;
	/** Open fence marker char (` or ~) at scanPos, "" when outside a fence. */
	fenceChar: string;
	/** Open fence marker length (close needs >= this many). */
	fenceLen: number;
	/** Blank-run start awaiting after-side confirmation, -1 when none. */
	pendingBoundary: number;
	/**
	 * Whether a non-blank line was scanned since the last confirmed boundary.
	 * A boundary is only worth confirming when its region contains content:
	 * splitting a blank run across two regions would render the run's single
	 * space token twice.
	 */
	hasContentSinceBoundary: boolean;
	/** Content of the most recent non-blank complete line (EOF checks). */
	lastContentLine: string;
	/** True once a ref-def / raw HTML line is seen: permanent full render. */
	fallback: boolean;
}

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	/** Foreground color function */
	color?: (text: string) => string;
	/** Background color function */
	bgColor?: (text: string) => string;
	/** Bold text */
	bold?: boolean;
	/** Italic text */
	italic?: boolean;
	/** Strikethrough text */
	strikethrough?: boolean;
	/** Underline text */
	underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	/** Prefix applied to each rendered code block line (default: "  ") */
	codeBlockIndent?: string;
}

export interface MarkdownOptions {
	/** Preserve source list markers instead of normalizing them. */
	preserveOrderedListMarkers?: boolean;
	/** Preserve source backslash escapes instead of normalizing escaped punctuation. */
	preserveBackslashEscapes?: boolean;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

export class Markdown implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private defaultTextStyle?: DefaultTextStyle;
	private theme: MarkdownTheme;
	private options: MarkdownOptions;
	private defaultStylePrefix?: string;

	// Cache for rendered output
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	// Incremental streaming state; undefined until the first render.
	private inc?: IncrementalState;

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
		this.options = options ? { ...options } : {};
	}

	setText(text: string): void {
		this.text = text;
		// Soft reset: keep the incremental state. render() detects append-only
		// growth and reuses the stable regions; a non-append change rebuilds
		// the state from scratch.
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.inc = undefined;
	}

	render(width: number): string[] {
		// Check cache
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// Don't render anything if there's no actual text
		if (!this.text || this.text.trim() === "") {
			const result: string[] = [];
			// Update cache
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		const contentLines = this.renderContentLines(width);

		// Add top/bottom padding (empty lines)
		const bgFn = this.defaultTextStyle?.bgColor;
		const emptyLine = " ".repeat(Math.max(0, width));
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
			emptyLines.push(line);
		}

		// Combine top padding, content, and bottom padding
		const result = emptyLines.concat(contentLines, emptyLines);

		// Update cache
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}

	/**
	 * The content lines for the current text: stable cached regions plus a
	 * freshly rendered live tail, or a plain full render when the incremental
	 * path is disabled by a fallback trigger.
	 */
	private renderContentLines(width: number): string[] {
		const inc = this.syncIncremental(width);
		if (inc.fallback) {
			return this.renderRegion(inc.normalized, width, true);
		}

		// Stabilize newly confirmed regions.
		while (inc.stableBoundaryCount < inc.boundaries.length) {
			const boundary = inc.boundaries[inc.stableBoundaryCount]!;
			const region = inc.normalized.slice(inc.stableLen, boundary);
			const lines = this.renderRegion(region, width, false);
			for (const line of lines) inc.stableLines.push(line);
			inc.stableLen = boundary;
			inc.stableBoundaryCount += 1;
		}

		const tail = inc.normalized.slice(inc.stableLen);
		const tailLines = this.renderRegion(tail, width, true);
		return inc.stableLines.concat(tailLines);
	}

	/**
	 * Brings the incremental state up to date with `this.text`: rebuilds on
	 * non-append changes, extends the normalized text on append, re-renders
	 * stable regions on width changes, and advances the boundary scanner.
	 */
	private syncIncremental(width: number): IncrementalState {
		if (this.inc === undefined || !this.text.startsWith(this.inc.raw)) {
			this.inc = {
				raw: this.text,
				normalized: this.text.replace(/\t/g, "   "),
				width,
				stableLen: 0,
				boundaries: [],
				stableBoundaryCount: 0,
				stableLines: [],
				scanPos: 0,
				fenceChar: "",
				fenceLen: 0,
				pendingBoundary: -1,
				hasContentSinceBoundary: false,
				lastContentLine: "",
				fallback: false,
			};
		} else if (this.text.length > this.inc.raw.length) {
			// Tab expansion is context-free per character, so appending the
			// normalized delta is exact.
			this.inc.normalized += this.text.slice(this.inc.raw.length).replace(/\t/g, "   ");
			this.inc.raw = this.text;
		}

		const inc = this.inc;
		if (inc.width !== width) {
			// Region boundaries and the scanner are width-independent; only the
			// rendered lines must be rebuilt at the new width.
			inc.width = width;
			inc.stableLen = 0;
			inc.stableLines = [];
			inc.stableBoundaryCount = 0;
		}

		if (!inc.fallback) this.scanBoundaries(inc);
		return inc;
	}

	/**
	 * Advances the line scanner over newly completed lines, tracking fence
	 * state, fallback triggers, and confirming safe region boundaries.
	 */
	private scanBoundaries(inc: IncrementalState): void {
		const text = inc.normalized;
		while (!inc.fallback) {
			const nl = text.indexOf("\n", inc.scanPos);
			if (nl === -1) break; // partial line: rescan next render
			const lineStart = inc.scanPos;
			inc.scanPos = nl + 1;
			let content = text.slice(lineStart, nl);
			if (content.endsWith("\r")) content = content.slice(0, -1);

			const isBlank = BLANK_LINE_RE.test(content);

			if (!isBlank && inc.pendingBoundary >= 0 && inc.fenceChar === "") {
				// This line is the after-side of a pending blank run. Confirm
				// the boundary unless the line could continue a construct from
				// before the blank: list item (marker or indented
				// continuation) or a blockquote (may lazily carry an unclosed
				// fence across the blank).
				if (
					inc.hasContentSinceBoundary &&
					!content.startsWith(" ") &&
					!LIST_MARKER_RE.test(content) &&
					!QUOTE_RE.test(content)
				) {
					inc.boundaries.push(inc.pendingBoundary);
					inc.hasContentSinceBoundary = false;
				}
				inc.pendingBoundary = -1;
			} else if (inc.pendingBoundary >= 0 && !isBlank) {
				// Inside a fence: the blank run is fence content, no boundary.
				inc.pendingBoundary = -1;
			}

			if (isBlank) {
				if (inc.fenceChar === "" && inc.pendingBoundary === -1) {
					inc.pendingBoundary = lineStart;
				}
				continue;
			}

			inc.lastContentLine = content;
			inc.hasContentSinceBoundary = true;

			if (inc.fenceChar !== "") {
				// Inside a fence: only a matching closing fence matters.
				if (isFenceClose(content, inc.fenceChar, inc.fenceLen)) {
					inc.fenceChar = "";
					inc.fenceLen = 0;
				}
				continue;
			}

			// Outside a fence: fallback triggers first (permanent, so the
			// order vs. fence tracking does not matter once set).
			if (REF_DEF_RE.test(content) || HTML_BLOCK_RE.test(content)) {
				inc.fallback = true;
				return;
			}

			const fenceMatch = FENCE_OPEN_RE.exec(content);
			if (fenceMatch !== null) {
				const marker = fenceMatch[1]!;
				// CommonMark: a backtick fence's info string may not contain a
				// backtick (such a line is a paragraph, not a fence).
				if (marker[0] === "`" && content.slice(countLeadingSpaces(content) + marker.length).includes("`")) {
					// Not a fence — fall through.
				} else {
					inc.fenceChar = marker[0]!;
					inc.fenceLen = marker.length;
				}
			}
		}

		// The partial tail line gets the same fallback triggers: a link
		// reference definition or HTML block affects rendering of the whole
		// document as soon as its line starts arriving, before it completes.
		if (!inc.fallback && inc.scanPos < text.length) {
			let partial = text.slice(inc.scanPos);
			if (partial.endsWith("\r")) partial = partial.slice(0, -1);
			if (REF_DEF_RE.test(partial) || HTML_BLOCK_RE.test(partial)) {
				inc.fallback = true;
				return;
			}
		}

		// EOF with a trailing blank run: confirm the boundary if the line
		// before the run cannot be continued by later text (not a list item
		// and not indented, so an arriving line cannot attach to it).
		if (
			!inc.fallback &&
			inc.pendingBoundary >= 0 &&
			inc.fenceChar === "" &&
			inc.scanPos === text.length &&
			inc.hasContentSinceBoundary &&
			!inc.lastContentLine.startsWith(" ") &&
			!LIST_MARKER_RE.test(inc.lastContentLine)
		) {
			inc.boundaries.push(inc.pendingBoundary);
			inc.hasContentSinceBoundary = false;
			inc.pendingBoundary = -1;
		}
	}

	/**
	 * Render one region of normalized text to final lines (wrap + margins +
	 * padding applied, paddingY excluded). `trim` enables
	 * trimPartialClosingFences and must be set only for the document's live
	 * tail region (or a full render), never for stabilized regions.
	 */
	private renderRegion(regionText: string, width: number, trim: boolean): string[] {
		const contentWidth = Math.max(1, width - this.paddingX * 2);

		const tokens = markdownParser.lexer(regionText);
		if (trim) trimPartialClosingFences(tokens);

		// Convert tokens to styled terminal output
		const renderedLines: string[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i]!;
			const nextToken = tokens[i + 1];
			const tokenLines = this.renderToken(token, contentWidth, nextToken?.type);
			for (const tokenLine of tokenLines) {
				renderedLines.push(tokenLine);
			}
		}

		// Wrap lines (NO padding, NO background yet)
		const wrappedLines: string[] = [];
		for (const line of renderedLines) {
			if (isImageLine(line)) {
				wrappedLines.push(line);
			} else {
				for (const wrappedLine of wrapTextWithAnsi(line, contentWidth)) {
					wrappedLines.push(wrappedLine);
				}
			}
		}

		// Add margins and background to each wrapped line
		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const bgFn = this.defaultTextStyle?.bgColor;
		const contentLines: string[] = [];

		for (const line of wrappedLines) {
			if (isImageLine(line)) {
				contentLines.push(line);
				continue;
			}

			const lineWithMargins = leftMargin + line + rightMargin;

			if (bgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
			} else {
				// No background - just pad to width
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
			}
		}

		return contentLines;
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	private applyDefaultStyle(text: string): string {
		if (!this.defaultTextStyle) {
			return text;
		}

		let styled = text;

		// Apply foreground color (NOT background - that's applied at padding stage)
		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		// Apply text decorations using this.theme
		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		return styled;
	}

	private getDefaultStylePrefix(): string {
		if (!this.defaultTextStyle) {
			return "";
		}

		if (this.defaultStylePrefix !== undefined) {
			return this.defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.defaultStylePrefix;
	}

	private getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	private getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.applyDefaultStyle(text),
			stylePrefix: this.getDefaultStylePrefix(),
		};
	}

	private renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;
				const headingPrefix = `${"#".repeat(headingLevel)} `;

				// Build a heading-specific style context so inline tokens (codespan, bold, etc.)
				// restore heading styling after their own ANSI resets instead of falling back to
				// the default text style.
				let headingStyleFn: (text: string) => string;
				if (headingLevel === 1) {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(this.theme.underline(text)));
				} else {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(text));
				}

				const headingStyleContext: InlineStyleContext = {
					applyText: headingStyleFn,
					stylePrefix: this.getStylePrefix(headingStyleFn),
				};

				const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext);
				const styledHeading = headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText;
				lines.push(styledHeading);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after headings (unless space token follows)
				}
				break;
			}

			case "paragraph": {
				const paragraphText = this.renderInlineTokens(token.tokens || [], styleContext);
				lines.push(paragraphText);
				// Don't add spacing if next token is space or list
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "text":
				lines.push(this.renderInlineTokens([token], styleContext));
				break;

			case "code": {
				const indent = this.theme.codeBlockIndent ?? "  ";
				lines.push(this.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`));
				if (this.theme.highlightCode) {
					const highlightedLines = this.theme.highlightCode(token.text, token.lang);
					for (const hlLine of highlightedLines) {
						lines.push(`${indent}${hlLine}`);
					}
				} else {
					// Split code by newlines and style each line
					const codeLines = token.text.split("\n");
					for (const codeLine of codeLines) {
						lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
					}
				}
				lines.push(this.theme.codeBlockBorder("```"));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after code blocks (unless space token follows)
				}
				break;
			}

			case "list": {
				const listLines = this.renderList(token as Tokens.List, 0, width, styleContext);
				lines.push(...listLines);
				// Don't add spacing after lists if a space token follows
				// (the space token will handle it)
				break;
			}

			case "table": {
				const tableLines = this.renderTable(token as Tokens.Table, width, nextTokenType, styleContext);
				lines.push(...tableLines);
				break;
			}

			case "blockquote": {
				const quoteStyle = (text: string) => this.theme.quote(this.theme.italic(text));
				const quoteStylePrefix = this.getStylePrefix(quoteStyle);
				const applyQuoteStyle = (line: string): string => {
					if (!quoteStylePrefix) {
						return quoteStyle(line);
					}
					const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
					return quoteStyle(lineWithReappliedStyle);
				};

				// Calculate available width for quote content (subtract border "│ " = 2 chars)
				const quoteContentWidth = Math.max(1, width - 2);

				// Blockquotes contain block-level tokens (paragraph, list, code, etc.), so render
				// children with renderToken() instead of renderInlineTokens().
				// Default message style should not apply inside blockquotes.
				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text: string) => text,
					stylePrefix: quoteStylePrefix,
				};
				const quoteTokens = token.tokens || [];
				const renderedQuoteLines: string[] = [];
				for (let i = 0; i < quoteTokens.length; i++) {
					const quoteToken = quoteTokens[i]!;
					const nextQuoteToken = quoteTokens[i + 1];
					renderedQuoteLines.push(
						...this.renderToken(quoteToken, quoteContentWidth, nextQuoteToken?.type, quoteInlineStyleContext),
					);
				}

				// Avoid rendering an extra empty quote line before the outer blockquote spacing.
				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
					renderedQuoteLines.pop();
				}

				for (const quoteLine of renderedQuoteLines) {
					const styledLine = applyQuoteStyle(quoteLine);
					const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
					for (const wrappedLine of wrappedLines) {
						lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
					}
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after blockquotes (unless space token follows)
				}
				break;
			}

			case "hr":
				lines.push(this.theme.hr("─".repeat(Math.max(0, Math.min(width, 80)))));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after horizontal rules (unless space token follows)
				}
				break;

			case "html":
				// Render HTML as plain text (escaped for terminal)
				if ("raw" in token && typeof token.raw === "string") {
					lines.push(this.applyDefaultStyle(token.raw.trim()));
				}
				break;

			case "space":
				// Space tokens represent blank lines in markdown
				lines.push("");
				break;

			default:
				// Handle any other token types as plain text
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}

		return lines;
	}

	private renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		const applyTextWithNewlines = (text: string): string => {
			const segments: string[] = text.split("\n");
			return segments.map((segment: string) => applyText(segment)).join("\n");
		};

		for (const token of tokens) {
			switch (token.type) {
				case "escape":
					result += applyTextWithNewlines(this.options.preserveBackslashEscapes ? token.raw : token.text);
					break;

				case "text":
					// Text tokens in list items can have nested tokens for inline formatting
					if (token.tokens && token.tokens.length > 0) {
						result += this.renderInlineTokens(token.tokens, resolvedStyleContext);
					} else {
						result += applyTextWithNewlines(token.text);
					}
					break;

				case "paragraph":
					// Paragraph tokens contain nested inline tokens
					result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					break;

				case "strong": {
					const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.bold(boldContent) + stylePrefix;
					break;
				}

				case "em": {
					const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.italic(italicContent) + stylePrefix;
					break;
				}

				case "codespan":
					result += this.theme.code(token.text) + stylePrefix;
					break;

				case "link": {
					const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					const styledLink = this.theme.link(this.theme.underline(linkText));
					if (getCapabilities().hyperlinks) {
						// OSC 8: render as a clickable hyperlink. The URL is not printed inline,
						// so we always show only the link text regardless of whether it matches href.
						result += hyperlink(styledLink, token.href) + stylePrefix;
					} else {
						// Fallback: print URL in parentheses when text differs from href.
						// Compare raw token.text (not styled) against href for the equality check.
						// For mailto: links strip the prefix (autolinked emails use text="foo@bar.com"
						// but href="mailto:foo@bar.com").
						const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
						if (token.text === token.href || token.text === hrefForComparison) {
							result += styledLink + stylePrefix;
						} else {
							result += styledLink + this.theme.linkUrl(` (${token.href})`) + stylePrefix;
						}
					}
					break;
				}

				case "br":
					result += "\n";
					break;

				case "del": {
					const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.strikethrough(delContent) + stylePrefix;
					break;
				}

				case "html":
					// Render inline HTML as plain text
					if ("raw" in token && typeof token.raw === "string") {
						result += applyTextWithNewlines(token.raw);
					}
					break;

				default:
					// Handle any other inline token types as plain text
					if ("text" in token && typeof token.text === "string") {
						result += applyTextWithNewlines(token.text);
					}
			}
		}

		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}

		return result;
	}

	private getOrderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = /^(?: {0,3})(\d{1,9}[.)])[ \t]+/.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	private getUnorderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = /^(?: {0,3})([-+*])(?:[ \t]+|(?=\r?\n|$))/.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	/**
	 * Render a list with proper nesting support
	 */
	private renderList(token: Tokens.List, depth: number, width: number, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];
		const indent = "    ".repeat(depth);
		// Use the list's start property (defaults to 1 for ordered lists)
		const startNumber = typeof token.start === "number" ? token.start : 1;

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i]!;
			const isLastItem = i === token.items.length - 1;
			const bullet = token.ordered
				? this.options.preserveOrderedListMarkers
					? (this.getOrderedListMarker(item) ?? `${startNumber + i}. `)
					: `${startNumber + i}. `
				: this.options.preserveOrderedListMarkers
					? (this.getUnorderedListMarker(item) ?? "- ")
					: "- ";
			const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
			const marker = bullet + taskMarker;
			const firstPrefix = indent + this.theme.listBullet(marker);
			const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
			const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
			let renderedAnyLine = false;

			for (const itemToken of item.tokens) {
				if (itemToken.type === "list") {
					lines.push(...this.renderList(itemToken as Tokens.List, depth + 1, width, styleContext));
					renderedAnyLine = true;
					continue;
				}

				const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext);
				for (const line of itemLines) {
					for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
						const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
						lines.push(linePrefix + wrappedLine);
						renderedAnyLine = true;
					}
				}
			}

			if (!renderedAnyLine) {
				lines.push(firstPrefix);
			}

			if (token.loose && !isLastItem) {
				lines.push("");
			}
		}

		return lines;
	}

	/**
	 * Get the visible width of the longest word in a string.
	 */
	private getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter((word) => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	/**
	 * Wrap a table cell to fit into a column.
	 *
	 * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
	 * consistently with the rest of the renderer.
	 */
	private wrapCellText(text: string, maxWidth: number): string[] {
		return wrapTextWithAnsi(text, Math.max(1, maxWidth));
	}

	/**
	 * Render a table with width-aware cell wrapping.
	 * Cells that don't fit are wrapped to multiple lines.
	 */
	private renderTable(
		token: Tokens.Table,
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		// Calculate border overhead: "│ " + (n-1) * " │ " + " │"
		// = 2 + (n-1) * 3 + 2 = 3n + 1
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			// Too narrow to render a stable table. Fall back to raw markdown.
			const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
			if (nextTokenType && nextTokenType !== "space") {
				fallbackLines.push("");
			}
			return fallbackLines;
		}

		const maxUnbrokenWordWidth = 30;

		// Calculate natural column widths (what each column needs without constraints)
		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.renderInlineTokens(token.header[i]!.tokens || [], styleContext);
			naturalWidths[i] = visibleWidth(headerText);
			minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (const row of token.rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.renderInlineTokens(row[i]!.tokens || [], styleContext);
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map((width) => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i]! += growth[i] ?? 0;
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]!++;
					leftover--;
				}
			}

			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		// Calculate column widths that fit within available width
		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			// Everything fits naturally
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]!));
		} else {
			// Need to shrink columns to fit
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]!);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index]!;
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				return minWidth + grow;
			});

			// Adjust for rounding errors - distribute remaining space
			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i]! < naturalWidths[i]!) {
						columnWidths[i]!++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		// Render top border
		const topBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`┌─${topBorderCells.join("─┬─")}─┐`);

		// Render header with wrapping
		const headerCellLines: string[][] = token.header.map((cell, i) => {
			const text = this.renderInlineTokens(cell.tokens || [], styleContext);
			return this.wrapCellText(text, columnWidths[i]!);
		});
		const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCellLines.map((cellLines, colIdx) => {
				const text = cellLines[lineIdx] || "";
				const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx]! - visibleWidth(text)));
				return this.theme.bold(padded);
			});
			lines.push(`│ ${rowParts.join(" │ ")} │`);
		}

		// Render separator
		const separatorCells = columnWidths.map((w) => "─".repeat(w));
		const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
		lines.push(separatorLine);

		// Render rows with wrapping
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex]!;
			const rowCellLines: string[][] = row.map((cell, i) => {
				const text = this.renderInlineTokens(cell.tokens || [], styleContext);
				return this.wrapCellText(text, columnWidths[i]!);
			});
			const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCellLines.map((cellLines, colIdx) => {
					const text = cellLines[lineIdx] || "";
					return text + " ".repeat(Math.max(0, columnWidths[colIdx]! - visibleWidth(text)));
				});
				lines.push(`│ ${rowParts.join(" │ ")} │`);
			}

			if (rowIndex < token.rows.length - 1) {
				lines.push(separatorLine);
			}
		}

		// Render bottom border
		const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`└─${bottomBorderCells.join("─┴─")}─┘`);

		if (nextTokenType && nextTokenType !== "space") {
			lines.push(""); // Add spacing after table
		}
		return lines;
	}
}

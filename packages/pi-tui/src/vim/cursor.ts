/**
 * Flat-offset cursor model for the vim engine.
 *
 * Ported from Claude Code's src/utils/Cursor.ts with these adaptations:
 * - ink's `stringWidth` is replaced by pi-tui's `visibleWidth`.
 * - ink's `wrapAnsi(text, columns, { hard: true, trim: false })` is replaced
 *   by the local `hardWrapToWidth`, which wraps at the column limit on
 *   grapheme boundaries while preserving every input character (the wrapped
 *   lines must stay exact substrings of the source text for offset mapping).
 *   Unlike the original it does not prefer word boundaries, so display-line
 *   motions (gj/gk) may wrap at slightly different points.
 * - The kill-ring and ink rendering (`render`, viewport helpers) and the
 *   Emacs-style deletion helpers are dropped: pi-tui's Editor has its own
 *   kill ring and rendering pipeline.
 * - The "image ref" chip detection is generalized from Claude's `[Image #N]`
 *   to also cover Cloud Code's `[image #N (W×H)]` placeholders and pi-tui's
 *   `[paste #N ...]` markers, so word motions and operators never leave a
 *   partial placeholder behind.
 */

import { getGraphemeSegmenter, getWordSegmenter, visibleWidth } from "../utils.ts";

/**
 * Text Processing Flow for Unicode Normalization:
 *
 * User Input (raw text, potentially mixed NFD/NFC)
 *     ↓
 * MeasuredText (normalizes to NFC + builds grapheme info)
 *     ↓
 * All cursor operations use normalized text/offsets
 *     ↓
 * Display uses normalized text from wrappedLines
 *
 * This flow ensures consistent Unicode handling:
 * - NFD/NFC normalization differences don't break cursor movement
 * - Grapheme clusters (like 👨‍👩‍👧‍👦) are treated as single units
 * - Display width calculations are accurate for CJK characters
 *
 * RULE: Once text enters MeasuredText, all operations
 * work on the normalized version.
 */

// Pre-compiled regex patterns for Vim word detection (avoid creating in hot loops)
export const VIM_WORD_CHAR_REGEX = /^[\p{L}\p{N}\p{M}_]$/u;
export const WHITESPACE_REGEX = /\s/;

// Exported helper functions for Vim character classification
export const isVimWordChar = (ch: string): boolean =>
	VIM_WORD_CHAR_REGEX.test(ch);
export const isVimWhitespace = (ch: string): boolean =>
	WHITESPACE_REGEX.test(ch);
export const isVimPunctuation = (ch: string): boolean =>
	ch.length > 0 && !isVimWhitespace(ch) && !isVimWordChar(ch);

/**
 * Atomic text chips the cursor hops over instead of stepping into. Covers
 * Claude's `[Image #N]`, Cloud Code's `[image #N (640×480)]` (and a
 * dimension-less variant), and pi-tui's `[paste #N +M lines]` /
 * `[paste #N M chars]` paste markers.
 */
const CHIP_REGEX_SOURCE =
	"\\[(?:Image #\\d+|image #\\d+(?: \\([^)]*\\))?|paste #\\d+(?: (?:\\+\\d+ lines|\\d+ chars))?)\\]";

/**
 * Hard-wrap text to `columns` visible cells, breaking only between graphemes
 * and preserving every input character (including whitespace). Each logical
 * line is wrapped independently and the result is joined back with "\n", so
 * every produced line is an exact substring of the input — the invariant
 * `MeasuredText.measureWrappedText` relies on for offset mapping.
 */
function hardWrapToWidth(text: string, columns: number): string {
	if (columns <= 0) return text;
	const out: string[] = [];
	for (const logicalLine of text.split("\n")) {
		if (visibleWidth(logicalLine) <= columns) {
			out.push(logicalLine);
			continue;
		}
		let current = "";
		let width = 0;
		for (const { segment } of getGraphemeSegmenter().segment(logicalLine)) {
			const segmentWidth = visibleWidth(segment);
			if (width + segmentWidth > columns && current !== "") {
				out.push(current);
				current = "";
				width = 0;
			}
			current += segment;
			width += segmentWidth;
		}
		out.push(current);
	}
	return out.join("\n");
}

type WrappedText = string[];
type Position = {
	line: number;
	column: number;
};

export class Cursor {
	readonly offset: number;
	readonly measuredText: MeasuredText;
	readonly selection: number;

	constructor(measuredText: MeasuredText, offset: number = 0, selection: number = 0) {
		this.measuredText = measuredText;
		this.selection = selection;
		// it's ok for the cursor to be 1 char beyond the end of the string
		this.offset = Math.max(0, Math.min(this.text.length, offset));
	}

	static fromText(
		text: string,
		columns: number,
		offset: number = 0,
		selection: number = 0,
	): Cursor {
		// make MeasuredText on less than columns width, to account for cursor
		return new Cursor(new MeasuredText(text, columns - 1), offset, selection);
	}

	left(): Cursor {
		if (this.offset === 0) return this;

		const chip = this.imageRefEndingAt(this.offset);
		if (chip) return new Cursor(this.measuredText, chip.start);

		const prevOffset = this.measuredText.prevOffset(this.offset);
		return new Cursor(this.measuredText, prevOffset);
	}

	right(): Cursor {
		if (this.offset >= this.text.length) return this;

		const chip = this.imageRefStartingAt(this.offset);
		if (chip) return new Cursor(this.measuredText, chip.end);

		const nextOffset = this.measuredText.nextOffset(this.offset);
		return new Cursor(this.measuredText, Math.min(nextOffset, this.text.length));
	}

	/**
	 * If a chip ends at `offset`, return its bounds. Used by left()
	 * to hop the cursor over the chip instead of stepping into it.
	 */
	imageRefEndingAt(offset: number): { start: number; end: number } | null {
		const m = this.text.slice(0, offset).match(new RegExp(`${CHIP_REGEX_SOURCE}$`));
		return m ? { start: offset - m[0].length, end: offset } : null;
	}

	imageRefStartingAt(offset: number): { start: number; end: number } | null {
		const m = this.text.slice(offset).match(new RegExp(`^${CHIP_REGEX_SOURCE}`));
		return m ? { start: offset, end: offset + m[0].length } : null;
	}

	/**
	 * If offset lands strictly inside a chip, snap it to the given
	 * boundary. Used by word-movement methods so operators never leave a
	 * partial chip.
	 */
	snapOutOfImageRef(offset: number, toward: "start" | "end"): number {
		const re = new RegExp(CHIP_REGEX_SOURCE, "g");
		let m;
		while ((m = re.exec(this.text)) !== null) {
			const start = m.index;
			const end = start + m[0].length;
			if (offset > start && offset < end) {
				return toward === "start" ? start : end;
			}
		}
		return offset;
	}

	up(): Cursor {
		const { line, column } = this.getPosition();
		if (line === 0) {
			return this;
		}

		const prevLine = this.measuredText.getWrappedText()[line - 1];
		if (prevLine === undefined) {
			return this;
		}

		const prevLineDisplayWidth = visibleWidth(prevLine);
		if (column > prevLineDisplayWidth) {
			const newOffset = this.getOffset({
				line: line - 1,
				column: prevLineDisplayWidth,
			});
			return new Cursor(this.measuredText, newOffset, 0);
		}

		const newOffset = this.getOffset({ line: line - 1, column });
		return new Cursor(this.measuredText, newOffset, 0);
	}

	down(): Cursor {
		const { line, column } = this.getPosition();
		if (line >= this.measuredText.lineCount - 1) {
			return this;
		}

		// If there is no next line, stay on the current line,
		// and let the caller handle it (e.g. for prompt input,
		// we move to the next history entry)
		const nextLine = this.measuredText.getWrappedText()[line + 1];
		if (nextLine === undefined) {
			return this;
		}

		const nextLineDisplayWidth = visibleWidth(nextLine);
		if (column > nextLineDisplayWidth) {
			const newOffset = this.getOffset({
				line: line + 1,
				column: nextLineDisplayWidth,
			});
			return new Cursor(this.measuredText, newOffset, 0);
		}

		const newOffset = this.getOffset({
			line: line + 1,
			column,
		});
		return new Cursor(this.measuredText, newOffset, 0);
	}

	/**
	 * Move to the start of the current line (column 0).
	 * This is the raw version used internally by startOfLine.
	 */
	private startOfCurrentLine(): Cursor {
		const { line } = this.getPosition();
		return new Cursor(
			this.measuredText,
			this.getOffset({
				line,
				column: 0,
			}),
			0,
		);
	}

	startOfLine(): Cursor {
		const { line, column } = this.getPosition();

		if (column === 0 && line > 0) {
			return new Cursor(
				this.measuredText,
				this.getOffset({
					line: line - 1,
					column: 0,
				}),
				0,
			);
		}

		return this.startOfCurrentLine();
	}

	firstNonBlankInLine(): Cursor {
		const { line } = this.getPosition();
		const lineText = this.measuredText.getWrappedText()[line] || "";

		const match = lineText.match(/^\s*\S/);
		const column = match?.index ? match.index + match[0].length - 1 : 0;
		const offset = this.getOffset({ line, column });

		return new Cursor(this.measuredText, offset, 0);
	}

	endOfLine(): Cursor {
		const { line } = this.getPosition();
		const column = this.measuredText.getLineLength(line);
		const offset = this.getOffset({ line, column });
		return new Cursor(this.measuredText, offset, 0);
	}

	private findLogicalLineStart(fromOffset: number = this.offset): number {
		const prevNewline = this.text.lastIndexOf("\n", fromOffset - 1);
		return prevNewline === -1 ? 0 : prevNewline + 1;
	}

	private findLogicalLineEnd(fromOffset: number = this.offset): number {
		const nextNewline = this.text.indexOf("\n", fromOffset);
		return nextNewline === -1 ? this.text.length : nextNewline;
	}

	private getLogicalLineBounds(): { start: number; end: number } {
		return {
			start: this.findLogicalLineStart(),
			end: this.findLogicalLineEnd(),
		};
	}

	// Snaps to grapheme boundary to avoid landing mid-grapheme
	private createCursorWithColumn(
		lineStart: number,
		lineEnd: number,
		targetColumn: number,
	): Cursor {
		const lineLength = lineEnd - lineStart;
		const clampedColumn = Math.min(targetColumn, lineLength);
		const rawOffset = lineStart + clampedColumn;
		const offset = this.measuredText.snapToGraphemeBoundary(rawOffset);
		return new Cursor(this.measuredText, offset, 0);
	}

	endOfLogicalLine(): Cursor {
		return new Cursor(this.measuredText, this.findLogicalLineEnd(), 0);
	}

	startOfLogicalLine(): Cursor {
		return new Cursor(this.measuredText, this.findLogicalLineStart(), 0);
	}

	firstNonBlankInLogicalLine(): Cursor {
		const { start, end } = this.getLogicalLineBounds();
		const lineText = this.text.slice(start, end);
		const match = lineText.match(/\S/);
		const offset = start + (match?.index ?? 0);
		return new Cursor(this.measuredText, offset, 0);
	}

	upLogicalLine(): Cursor {
		const { start: currentStart } = this.getLogicalLineBounds();

		if (currentStart === 0) {
			return new Cursor(this.measuredText, 0, 0);
		}

		const currentColumn = this.offset - currentStart;

		const prevLineEnd = currentStart - 1;
		const prevLineStart = this.findLogicalLineStart(prevLineEnd);

		return this.createCursorWithColumn(
			prevLineStart,
			prevLineEnd,
			currentColumn,
		);
	}

	downLogicalLine(): Cursor {
		const { start: currentStart, end: currentEnd } = this.getLogicalLineBounds();

		if (currentEnd >= this.text.length) {
			return new Cursor(this.measuredText, this.text.length, 0);
		}

		const currentColumn = this.offset - currentStart;

		const nextLineStart = currentEnd + 1;
		const nextLineEnd = this.findLogicalLineEnd(nextLineStart);

		return this.createCursorWithColumn(
			nextLineStart,
			nextLineEnd,
			currentColumn,
		);
	}

	// Vim word vs WORD movements:
	// - word (lowercase w/b/e): sequences of letters, digits, and underscores
	// - WORD (uppercase W/B/E): sequences of non-whitespace characters
	// For example, in "hello-world!", word movements see 3 words: "hello", "world", and nothing
	// But WORD movements see 1 WORD: "hello-world!"

	nextWord(): Cursor {
		if (this.isAtEnd()) {
			return this;
		}

		// Use Intl.Segmenter for proper word boundary detection (including CJK)
		const wordBoundaries = this.measuredText.getWordBoundaries();

		for (const boundary of wordBoundaries) {
			if (boundary.isWordLike && boundary.start > this.offset) {
				return new Cursor(this.measuredText, boundary.start);
			}
		}

		return new Cursor(this.measuredText, this.text.length);
	}

	endOfWord(): Cursor {
		if (this.isAtEnd()) {
			return this;
		}

		// Use Intl.Segmenter for proper word boundary detection (including CJK)
		const wordBoundaries = this.measuredText.getWordBoundaries();

		for (const boundary of wordBoundaries) {
			if (!boundary.isWordLike) continue;

			if (this.offset >= boundary.start && this.offset < boundary.end - 1) {
				return new Cursor(this.measuredText, boundary.end - 1);
			}

			if (this.offset === boundary.end - 1) {
				for (const nextBoundary of wordBoundaries) {
					if (nextBoundary.isWordLike && nextBoundary.start > this.offset) {
						return new Cursor(this.measuredText, nextBoundary.end - 1);
					}
				}
				return this;
			}
		}

		for (const boundary of wordBoundaries) {
			if (boundary.isWordLike && boundary.start > this.offset) {
				return new Cursor(this.measuredText, boundary.end - 1);
			}
		}

		return this;
	}

	prevWord(): Cursor {
		if (this.isAtStart()) {
			return this;
		}

		// Use Intl.Segmenter for proper word boundary detection (including CJK)
		const wordBoundaries = this.measuredText.getWordBoundaries();

		let prevWordStart: number | null = null;

		for (const boundary of wordBoundaries) {
			if (!boundary.isWordLike) continue;

			if (boundary.start < this.offset) {
				if (this.offset > boundary.start && this.offset <= boundary.end) {
					return new Cursor(this.measuredText, boundary.start);
				}
				prevWordStart = boundary.start;
			}
		}

		if (prevWordStart !== null) {
			return new Cursor(this.measuredText, prevWordStart);
		}

		return new Cursor(this.measuredText, 0);
	}

	// Vim-specific word methods
	// In Vim, a "word" is either:
	// 1. A sequence of word characters (letters, digits, underscore) - including Unicode
	// 2. A sequence of non-blank, non-word characters (punctuation/symbols)

	nextVimWord(): Cursor {
		if (this.isAtEnd()) {
			return this;
		}

		let pos = this.offset;
		const advance = (p: number): number => this.measuredText.nextOffset(p);

		const currentGrapheme = this.graphemeAt(pos);
		if (!currentGrapheme) {
			return this;
		}

		if (isVimWordChar(currentGrapheme)) {
			while (pos < this.text.length && isVimWordChar(this.graphemeAt(pos))) {
				pos = advance(pos);
			}
		} else if (isVimPunctuation(currentGrapheme)) {
			while (pos < this.text.length && isVimPunctuation(this.graphemeAt(pos))) {
				pos = advance(pos);
			}
		}

		while (
			pos < this.text.length &&
			WHITESPACE_REGEX.test(this.graphemeAt(pos))
		) {
			pos = advance(pos);
		}

		return new Cursor(this.measuredText, pos);
	}

	endOfVimWord(): Cursor {
		if (this.isAtEnd()) {
			return this;
		}

		const text = this.text;
		let pos = this.offset;
		const advance = (p: number): number => this.measuredText.nextOffset(p);

		if (this.graphemeAt(pos) === "") {
			return this;
		}

		pos = advance(pos);

		while (pos < text.length && WHITESPACE_REGEX.test(this.graphemeAt(pos))) {
			pos = advance(pos);
		}

		if (pos >= text.length) {
			return new Cursor(this.measuredText, text.length);
		}

		const charAtPos = this.graphemeAt(pos);
		if (isVimWordChar(charAtPos)) {
			while (pos < text.length) {
				const nextPos = advance(pos);
				if (nextPos >= text.length || !isVimWordChar(this.graphemeAt(nextPos)))
					break;
				pos = nextPos;
			}
		} else if (isVimPunctuation(charAtPos)) {
			while (pos < text.length) {
				const nextPos = advance(pos);
				if (
					nextPos >= text.length ||
					!isVimPunctuation(this.graphemeAt(nextPos))
				)
					break;
				pos = nextPos;
			}
		}

		return new Cursor(this.measuredText, pos);
	}

	prevVimWord(): Cursor {
		if (this.isAtStart()) {
			return this;
		}

		let pos = this.offset;
		const retreat = (p: number): number => this.measuredText.prevOffset(p);

		pos = retreat(pos);

		while (pos > 0 && WHITESPACE_REGEX.test(this.graphemeAt(pos))) {
			pos = retreat(pos);
		}

		if (pos === 0 && WHITESPACE_REGEX.test(this.graphemeAt(0))) {
			return new Cursor(this.measuredText, 0);
		}

		const charAtPos = this.graphemeAt(pos);
		if (isVimWordChar(charAtPos)) {
			while (pos > 0) {
				const prevPos = retreat(pos);
				if (!isVimWordChar(this.graphemeAt(prevPos))) break;
				pos = prevPos;
			}
		} else if (isVimPunctuation(charAtPos)) {
			while (pos > 0) {
				const prevPos = retreat(pos);
				if (!isVimPunctuation(this.graphemeAt(prevPos))) break;
				pos = prevPos;
			}
		}

		return new Cursor(this.measuredText, pos);
	}

	nextWORD(): Cursor {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		let nextCursor: Cursor = this;
		while (!nextCursor.isOverWhitespace() && !nextCursor.isAtEnd()) {
			nextCursor = nextCursor.right();
		}
		while (nextCursor.isOverWhitespace() && !nextCursor.isAtEnd()) {
			nextCursor = nextCursor.right();
		}
		return nextCursor;
	}

	endOfWORD(): Cursor {
		if (this.isAtEnd()) {
			return this;
		}

		// eslint-disable-next-line @typescript-eslint/no-this-alias
		let cursor: Cursor = this;

		const atEndOfWORD =
			!cursor.isOverWhitespace() &&
			(cursor.right().isOverWhitespace() || cursor.right().isAtEnd());

		if (atEndOfWORD) {
			cursor = cursor.right();
			return cursor.endOfWORD();
		}

		if (cursor.isOverWhitespace()) {
			cursor = cursor.nextWORD();
		}

		while (!cursor.right().isOverWhitespace() && !cursor.isAtEnd()) {
			cursor = cursor.right();
		}

		return cursor;
	}

	prevWORD(): Cursor {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		let cursor: Cursor = this;

		if (cursor.left().isOverWhitespace()) {
			cursor = cursor.left();
		}

		while (cursor.isOverWhitespace() && !cursor.isAtStart()) {
			cursor = cursor.left();
		}

		if (!cursor.isOverWhitespace()) {
			while (!cursor.left().isOverWhitespace() && !cursor.isAtStart()) {
				cursor = cursor.left();
			}
		}

		return cursor;
	}

	modifyText(end: Cursor, insertString: string = ""): Cursor {
		const startOffset = this.offset;
		const endOffset = end.offset;

		const newText =
			this.text.slice(0, startOffset) +
			insertString +
			this.text.slice(endOffset);

		return Cursor.fromText(
			newText,
			this.columns,
			startOffset + insertString.normalize("NFC").length,
		);
	}

	insert(insertString: string): Cursor {
		const newCursor = this.modifyText(this, insertString);
		return newCursor;
	}

	del(): Cursor {
		if (this.isAtEnd()) {
			return this;
		}
		return this.modifyText(this.right());
	}

	backspace(): Cursor {
		if (this.isAtStart()) {
			return this;
		}
		return this.left().modifyText(this);
	}

	private graphemeAt(pos: number): string {
		if (pos >= this.text.length) return "";
		const nextOff = this.measuredText.nextOffset(pos);
		return this.text.slice(pos, nextOff);
	}

	private isOverWhitespace(): boolean {
		const currentChar = this.text[this.offset] ?? "";
		return /\s/.test(currentChar);
	}

	equals(other: Cursor): boolean {
		return (
			this.offset === other.offset && this.measuredText === other.measuredText
		);
	}

	isAtStart(): boolean {
		return this.offset === 0;
	}
	isAtEnd(): boolean {
		return this.offset >= this.text.length;
	}

	startOfFirstLine(): Cursor {
		return new Cursor(this.measuredText, 0, 0);
	}

	startOfLastLine(): Cursor {
		const lastNewlineIndex = this.text.lastIndexOf("\n");

		if (lastNewlineIndex === -1) {
			return this.startOfLine();
		}

		return new Cursor(this.measuredText, lastNewlineIndex + 1, 0);
	}

	goToLine(lineNumber: number): Cursor {
		// Go to the beginning of the specified logical line (1-indexed, like vim)
		// Uses logical lines (separated by \n), not wrapped display lines
		const lines = this.text.split("\n");
		const targetLine = Math.min(Math.max(0, lineNumber - 1), lines.length - 1);
		let offset = 0;
		for (let i = 0; i < targetLine; i++) {
			offset += (lines[i]?.length ?? 0) + 1; // +1 for newline
		}
		return new Cursor(this.measuredText, offset, 0);
	}

	endOfFile(): Cursor {
		return new Cursor(this.measuredText, this.text.length, 0);
	}

	public get text(): string {
		return this.measuredText.text;
	}

	private get columns(): number {
		return this.measuredText.columns + 1;
	}

	getPosition(): Position {
		return this.measuredText.getPositionFromOffset(this.offset);
	}

	private getOffset(position: Position): number {
		return this.measuredText.getOffsetFromPosition(position);
	}

	/**
	 * Find a character using vim f/F/t/T semantics.
	 *
	 * @param char - The character to find
	 * @param type - 'f' (forward to), 'F' (backward to), 't' (forward till), 'T' (backward till)
	 * @param count - Find the Nth occurrence
	 * @returns The target offset, or null if not found
	 */
	findCharacter(
		char: string,
		type: "f" | "F" | "t" | "T",
		count: number = 1,
	): number | null {
		const text = this.text;
		const forward = type === "f" || type === "t";
		const till = type === "t" || type === "T";
		let found = 0;

		if (forward) {
			let pos = this.measuredText.nextOffset(this.offset);
			while (pos < text.length) {
				const grapheme = this.graphemeAt(pos);
				if (grapheme === char) {
					found++;
					if (found === count) {
						return till
							? Math.max(this.offset, this.measuredText.prevOffset(pos))
							: pos;
					}
				}
				pos = this.measuredText.nextOffset(pos);
			}
		} else {
			if (this.offset === 0) return null;
			let pos = this.measuredText.prevOffset(this.offset);
			while (pos >= 0) {
				const grapheme = this.graphemeAt(pos);
				if (grapheme === char) {
					found++;
					if (found === count) {
						return till
							? Math.min(this.offset, this.measuredText.nextOffset(pos))
							: pos;
					}
				}
				if (pos === 0) break;
				pos = this.measuredText.prevOffset(pos);
			}
		}

		return null;
	}
}

class WrappedLine {
	public readonly text: string;
	public readonly startOffset: number;
	public readonly isPrecededByNewline: boolean;
	public readonly endsWithNewline: boolean;

	constructor(
		text: string,
		startOffset: number,
		isPrecededByNewline: boolean,
		endsWithNewline: boolean = false,
	) {
		this.text = text;
		this.startOffset = startOffset;
		this.isPrecededByNewline = isPrecededByNewline;
		this.endsWithNewline = endsWithNewline;
	}

	equals(other: WrappedLine): boolean {
		return this.text === other.text && this.startOffset === other.startOffset;
	}

	get length(): number {
		return this.text.length + (this.endsWithNewline ? 1 : 0);
	}
}

export class MeasuredText {
	private _wrappedLines?: WrappedLine[];
	public readonly text: string;
	readonly columns: number;
	private navigationCache: Map<string, number>;
	private graphemeBoundaries?: number[];

	constructor(text: string, columns: number) {
		this.text = text.normalize("NFC");
		this.columns = columns;
		this.navigationCache = new Map();
	}

	/**
	 * Lazily computes and caches wrapped lines.
	 * This expensive operation is deferred until actually needed.
	 */
	private get wrappedLines(): WrappedLine[] {
		if (!this._wrappedLines) {
			this._wrappedLines = this.measureWrappedText();
		}
		return this._wrappedLines;
	}

	private getGraphemeBoundaries(): number[] {
		if (!this.graphemeBoundaries) {
			this.graphemeBoundaries = [];
			for (const { index } of getGraphemeSegmenter().segment(this.text)) {
				this.graphemeBoundaries.push(index);
			}
			this.graphemeBoundaries.push(this.text.length);
		}
		return this.graphemeBoundaries;
	}

	private wordBoundariesCache?: Array<{
		start: number;
		end: number;
		isWordLike: boolean;
	}>;

	/**
	 * Get word boundaries using Intl.Segmenter for proper Unicode word segmentation.
	 * This correctly handles CJK (Chinese, Japanese, Korean) text where each character
	 * is typically its own word, as well as scripts that use spaces between words.
	 */
	public getWordBoundaries(): Array<{
		start: number;
		end: number;
		isWordLike: boolean;
	}> {
		if (!this.wordBoundariesCache) {
			this.wordBoundariesCache = [];
			for (const segment of getWordSegmenter().segment(this.text)) {
				this.wordBoundariesCache.push({
					start: segment.index,
					end: segment.index + segment.segment.length,
					isWordLike: segment.isWordLike ?? false,
				});
			}
		}
		return this.wordBoundariesCache;
	}

	/**
	 * Binary search for boundaries.
	 * @param boundaries: Sorted array of boundaries
	 * @param target: Target offset
	 * @param findNext: If true, finds first boundary > target. If false, finds last boundary < target.
	 * @returns The found boundary index, or appropriate default
	 */
	private binarySearchBoundary(
		boundaries: number[],
		target: number,
		findNext: boolean,
	): number {
		let left = 0;
		let right = boundaries.length - 1;
		let result = findNext ? this.text.length : 0;

		while (left <= right) {
			const mid = Math.floor((left + right) / 2);
			const boundary = boundaries[mid];
			if (boundary === undefined) break;

			if (findNext) {
				if (boundary > target) {
					result = boundary;
					right = mid - 1;
				} else {
					left = mid + 1;
				}
			} else {
				if (boundary < target) {
					result = boundary;
					left = mid + 1;
				} else {
					right = mid - 1;
				}
			}
		}

		return result;
	}

	public stringIndexToDisplayWidth(text: string, index: number): number {
		if (index <= 0) return 0;
		if (index >= text.length) return visibleWidth(text);
		return visibleWidth(text.substring(0, index));
	}

	public displayWidthToStringIndex(text: string, targetWidth: number): number {
		if (targetWidth <= 0) return 0;
		if (!text) return 0;

		if (text === this.text) {
			return this.offsetAtDisplayWidth(targetWidth);
		}

		let currentWidth = 0;
		let currentOffset = 0;

		for (const { segment, index } of getGraphemeSegmenter().segment(text)) {
			const segmentWidth = visibleWidth(segment);

			if (currentWidth + segmentWidth > targetWidth) {
				break;
			}

			currentWidth += segmentWidth;
			currentOffset = index + segment.length;
		}

		return currentOffset;
	}

	/**
	 * Find the string offset that corresponds to a target display width.
	 */
	private offsetAtDisplayWidth(targetWidth: number): number {
		if (targetWidth <= 0) return 0;

		let currentWidth = 0;
		const boundaries = this.getGraphemeBoundaries();

		for (let i = 0; i < boundaries.length - 1; i++) {
			const start = boundaries[i];
			const end = boundaries[i + 1];
			if (start === undefined || end === undefined) continue;
			const segment = this.text.substring(start, end);
			const segmentWidth = visibleWidth(segment);

			if (currentWidth + segmentWidth > targetWidth) {
				return start;
			}
			currentWidth += segmentWidth;
		}

		return this.text.length;
	}

	private measureWrappedText(): WrappedLine[] {
		const wrappedText = hardWrapToWidth(this.text, this.columns);

		const wrappedLines: WrappedLine[] = [];
		let searchOffset = 0;
		let lastNewLinePos = -1;

		const lines = wrappedText.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const text = lines[i]!;
			const isPrecededByNewline = (startOffset: number) =>
				i === 0 || (startOffset > 0 && this.text[startOffset - 1] === "\n");

			if (text.length === 0) {
				lastNewLinePos = this.text.indexOf("\n", lastNewLinePos + 1);

				if (lastNewLinePos !== -1) {
					const startOffset = lastNewLinePos;
					const endsWithNewline = true;

					wrappedLines.push(
						new WrappedLine(
							text,
							startOffset,
							isPrecededByNewline(startOffset),
							endsWithNewline,
						),
					);
				} else {
					// If we can't find another newline, this must be the end of text
					const startOffset = this.text.length;
					wrappedLines.push(
						new WrappedLine(
							text,
							startOffset,
							isPrecededByNewline(startOffset),
							false,
						),
					);
				}
			} else {
				const startOffset = this.text.indexOf(text, searchOffset);

				if (startOffset === -1) {
					throw new Error("Failed to find wrapped line in text");
				}

				searchOffset = startOffset + text.length;

				const potentialNewlinePos = startOffset + text.length;
				const endsWithNewline =
					potentialNewlinePos < this.text.length &&
					this.text[potentialNewlinePos] === "\n";

				if (endsWithNewline) {
					lastNewLinePos = potentialNewlinePos;
				}

				wrappedLines.push(
					new WrappedLine(
						text,
						startOffset,
						isPrecededByNewline(startOffset),
						endsWithNewline,
					),
				);
			}
		}

		return wrappedLines;
	}

	public getWrappedText(): WrappedText {
		return this.wrappedLines.map((line) =>
			line.isPrecededByNewline ? line.text : line.text.trimStart(),
		);
	}

	public getWrappedLines(): WrappedLine[] {
		return this.wrappedLines;
	}

	private getLine(line: number): WrappedLine {
		const lines = this.wrappedLines;
		return lines[Math.max(0, Math.min(line, lines.length - 1))]!;
	}

	public getOffsetFromPosition(position: Position): number {
		const wrappedLine = this.getLine(position.line);

		if (wrappedLine.text.length === 0 && wrappedLine.endsWithNewline) {
			return wrappedLine.startOffset;
		}

		const leadingWhitespace = wrappedLine.isPrecededByNewline
			? 0
			: wrappedLine.text.length - wrappedLine.text.trimStart().length;

		const displayColumnWithLeading = position.column + leadingWhitespace;
		const stringIndex = this.displayWidthToStringIndex(
			wrappedLine.text,
			displayColumnWithLeading,
		);

		const offset = wrappedLine.startOffset + stringIndex;

		const lineEnd = wrappedLine.startOffset + wrappedLine.text.length;

		// Don't allow going past the end of the current line into the next line
		// unless we're at the very end of the text
		let maxOffset = lineEnd;
		const lineDisplayWidth = visibleWidth(wrappedLine.text);
		if (wrappedLine.endsWithNewline && position.column > lineDisplayWidth) {
			// Allow positioning after the newline
			maxOffset = lineEnd + 1;
		}

		return Math.min(offset, maxOffset);
	}

	public getLineLength(line: number): number {
		const wrappedLine = this.getLine(line);
		return visibleWidth(wrappedLine.text);
	}

	public getPositionFromOffset(offset: number): Position {
		const lines = this.wrappedLines;
		for (let line = 0; line < lines.length; line++) {
			const currentLine = lines[line]!;
			const nextLine = lines[line + 1];
			if (
				offset >= currentLine.startOffset &&
				(!nextLine || offset < nextLine.startOffset)
			) {
				const stringPosInLine = offset - currentLine.startOffset;

				let displayColumn: number;
				if (currentLine.isPrecededByNewline) {
					displayColumn = this.stringIndexToDisplayWidth(
						currentLine.text,
						stringPosInLine,
					);
				} else {
					const leadingWhitespace =
						currentLine.text.length - currentLine.text.trimStart().length;
					if (stringPosInLine < leadingWhitespace) {
						// Cursor is in the trimmed whitespace area, position at start
						displayColumn = 0;
					} else {
						const trimmedText = currentLine.text.trimStart();
						const posInTrimmed = stringPosInLine - leadingWhitespace;
						displayColumn = this.stringIndexToDisplayWidth(
							trimmedText,
							posInTrimmed,
						);
					}
				}

				return {
					line,
					column: Math.max(0, displayColumn),
				};
			}
		}

		const line = lines.length - 1;
		const lastLine = this.wrappedLines[line]!;
		return {
			line,
			column: visibleWidth(lastLine.text),
		};
	}

	public get lineCount(): number {
		return this.wrappedLines.length;
	}

	private withCache<T>(key: string, compute: () => T): T {
		const cached = this.navigationCache.get(key);
		if (cached !== undefined) return cached as T;

		const result = compute();
		this.navigationCache.set(key, result as number);
		return result;
	}

	nextOffset(offset: number): number {
		return this.withCache(`next:${offset}`, () => {
			const boundaries = this.getGraphemeBoundaries();
			return this.binarySearchBoundary(boundaries, offset, true);
		});
	}

	prevOffset(offset: number): number {
		if (offset <= 0) return 0;

		return this.withCache(`prev:${offset}`, () => {
			const boundaries = this.getGraphemeBoundaries();
			return this.binarySearchBoundary(boundaries, offset, false);
		});
	}

	/**
	 * Snap an arbitrary code-unit offset to the start of the containing grapheme.
	 * If offset is already on a boundary, returns it unchanged.
	 */
	snapToGraphemeBoundary(offset: number): number {
		if (offset <= 0) return 0;
		if (offset >= this.text.length) return this.text.length;
		const boundaries = this.getGraphemeBoundaries();
		let lo = 0;
		let hi = boundaries.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (boundaries[mid]! <= offset) lo = mid;
			else hi = mid - 1;
		}
		return boundaries[lo]!;
	}
}

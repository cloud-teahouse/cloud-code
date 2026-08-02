/**
 * StdinBuffer buffers input and emits complete sequences.
 *
 * This is necessary because stdin data events can arrive in partial chunks,
 * especially for escape sequences like mouse events. Without buffering,
 * partial sequences can be misinterpreted as regular keypresses.
 *
 * For example, the mouse SGR sequence `\x1b[<35;20;5m` might arrive as:
 * - Event 1: `\x1b`
 * - Event 2: `[<35`
 * - Event 3: `;20;5m`
 *
 * The buffer accumulates these until a complete sequence is detected.
 * Call the `process()` method to feed input data.
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

import { EventEmitter } from "events";

const ESC = "\x1b";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * Find the end (exclusive index) of the sequence starting at `start` in
 * `data`, or -1 when the sequence is still incomplete.
 *
 * `from` is a resume cursor: chars in [start, from) were already scanned by a
 * previous pass and found not to complete the sequence, so only [from, len)
 * needs examining. The per-type rules are exactly those of the original
 * candidate-by-candidate completeness loop, but each rule is checked in a
 * single forward pass with no per-candidate string copies:
 * - ESC alone                       -> incomplete
 * - ESC [ M ...                     -> old-style mouse: exactly 6 chars
 * - ESC [ < ...                     -> SGR mouse: completes only once the whole
 *                                      payload matches ^<\d+;\d+;\d+[Mm]$
 * - ESC [ ...                       -> CSI: first byte in 0x40-0x7E terminates
 * - ESC ] ...                       -> OSC: terminates at BEL or ESC \
 * - ESC P ... / ESC _ ...           -> DCS / APC: terminate at ESC \
 * - ESC O x                         -> SS3: exactly 3 chars
 * - ESC <other>                     -> meta / unknown: exactly 2 chars
 */
function scanSequenceEnd(data: string, start: number, from: number): number {
	const len = data.length;
	if (len - start < 2) return -1;

	const c1 = data[start + 1];

	if (c1 === "[") {
		const c2 = data[start + 2];
		if (c2 === "M") {
			// Old-style mouse needs ESC[M + 3 bytes = 6 total
			return len - start >= 6 ? start + 6 : -1;
		}
		if (c2 === "<") {
			// SGR mouse: ESC[<B;X;Ym / ESC[<B;X;YM. A terminator candidate is
			// only ever an M/m; the whole payload must match the pattern, so
			// an M/m at a wrong position keeps the sequence incomplete.
			for (let i = Math.max(start + 3, from); i < len; i++) {
				const ch = data[i];
				if ((ch === "M" || ch === "m") && /^<\d+;\d+;\d+[Mm]$/.test(data.slice(start + 2, i + 1))) {
					return i + 1;
				}
			}
			return -1;
		}
		// CSI sequences end with a byte in the range 0x40-0x7E (@-~)
		for (let i = Math.max(start + 2, from); i < len; i++) {
			const code = data.charCodeAt(i);
			if (code >= 0x40 && code <= 0x7e) return i + 1;
		}
		return -1;
	}

	if (c1 === "]") {
		// OSC sequences end with ST (ESC \) or BEL (\x07). The one-char
		// lookback catches an ESC \ pair straddling the resume cursor.
		for (let i = Math.max(start + 2, from); i < len; i++) {
			const ch = data[i];
			if (ch === "\x07") return i + 1;
			if (ch === "\\" && data[i - 1] === ESC) return i + 1;
		}
		return -1;
	}

	if (c1 === "P" || c1 === "_") {
		// DCS (XTVersion responses) and APC (Kitty graphics responses)
		// sequences end with ST (ESC \)
		for (let i = Math.max(start + 2, from); i < len; i++) {
			if (data[i] === "\\" && data[i - 1] === ESC) return i + 1;
		}
		return -1;
	}

	if (c1 === "O") {
		// SS3 sequences: ESC O followed by a single character
		return len - start >= 3 ? start + 3 : -1;
	}

	// Meta key / unknown escape sequences: ESC followed by a single character.
	if (c1 === ESC) {
		// WezTerm with enable_kitty_keyboard sends the Escape key press as a
		// raw '\x1b' byte (simple text path in encode_kitty, ignoring
		// DISAMBIGUATE_ESCAPE_CODES) and the release as a full Kitty CSI-u
		// sequence. These arrive concatenated as '\x1b\x1b[27;...u'.
		// The buffer would normally treat '\x1b\x1b' as a complete meta-key
		// sequence (ESC + single char), leaving '[27;...u' to be typed as
		// plain text. If the character immediately following '\x1b\x1b'
		// would begin a new escape sequence, emit only the first ESC and
		// restart from the second.
		const next = data[start + 2];
		if (next === "[" || next === "]" || next === "O" || next === "P" || next === "_") {
			return start + 1;
		}
	}
	return start + 2;
}

function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
	const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
	if (!match) return undefined;

	const codepoint = parseInt(match[1]!, 10);
	return codepoint >= 32 ? codepoint : undefined;
}

/**
 * Split accumulated buffer into complete sequences. `from` is a resume cursor
 * for the first (pending) sequence in the buffer; pass 0 for a one-shot scan.
 */
function extractCompleteSequences(
	buffer: string,
	from = 0,
): { sequences: string[]; remainder: string } {
	const sequences: string[] = [];
	let pos = 0;

	while (pos < buffer.length) {
		if (buffer[pos] === ESC) {
			const end = scanSequenceEnd(buffer, pos, Math.max(pos + 2, from));
			if (end === -1) {
				return { sequences, remainder: buffer.slice(pos) };
			}
			sequences.push(buffer.slice(pos, end));
			pos = end;
		} else {
			// Not an escape sequence - take a single UTF-16 code unit
			// (char-by-char, exactly like the previous slice-based scan).
			sequences.push(buffer[pos]!);
			pos++;
		}
	}

	return { sequences, remainder: "" };
}

export type StdinBufferOptions = {
	/**
	 * Maximum time to wait for sequence completion (default: 10ms)
	 * After this time, the buffer is flushed even if incomplete
	 */
	timeout?: number;
};

export type StdinBufferEventMap = {
	data: [string];
	paste: [string];
};

/**
 * Buffers stdin input and emits complete sequences via the 'data' event.
 * Handles partial escape sequences that arrive across multiple chunks.
 */
export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	private buffer: string = "";
	/**
	 * Resume cursor into `buffer`: how many leading chars of the pending
	 * (incomplete) escape sequence were already scanned without completing.
	 * Extraction emits every complete sequence, so the buffer only ever holds
	 * a single incomplete tail and one cursor suffices — rescanning it from
	 * index 0 on every chunk made trickle-fed long sequences quadratic.
	 */
	private scannedCount: number = 0;
	private timeout: ReturnType<typeof setTimeout> | null = null;
	private readonly timeoutMs: number;
	private pasteMode: boolean = false;
	private pasteBuffer: string = "";
	private pendingKittyPrintableCodepoint: number | undefined;

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.timeoutMs = options.timeout ?? 10;
	}

	public process(data: string | Buffer): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		// Handle high-byte conversion (for compatibility with parseKeypress)
		// If buffer has single byte > 127, convert to ESC + (byte - 128)
		let str: string;
		if (Buffer.isBuffer(data)) {
			if (data.length === 1 && data[0]! > 127) {
				const byte = data[0]! - 128;
				str = `\x1b${String.fromCharCode(byte)}`;
			} else {
				str = data.toString();
			}
		} else {
			str = data;
		}

		if (str.length === 0 && this.buffer.length === 0) {
			this.emitDataSequence("");
			return;
		}

		this.buffer += str;

		if (this.pasteMode) {
			this.pasteBuffer += this.buffer;
			this.buffer = "";
			this.scannedCount = 0;

			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				const pastedContent = this.pasteBuffer.slice(0, endIndex);
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				this.pasteMode = false;
				this.pasteBuffer = "";
				this.pendingKittyPrintableCodepoint = undefined;

				this.emit("paste", pastedContent);

				if (remaining.length > 0) {
					this.process(remaining);
				}
			}
			return;
		}

		const startIndex = this.buffer.indexOf(BRACKETED_PASTE_START);
		if (startIndex !== -1) {
			if (startIndex > 0) {
				const beforePaste = this.buffer.slice(0, startIndex);
				const result = extractCompleteSequences(beforePaste);
				for (const sequence of result.sequences) {
					this.emitDataSequence(sequence);
				}
			}

			this.pendingKittyPrintableCodepoint = undefined;
			this.buffer = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			this.pasteMode = true;
			this.pasteBuffer = this.buffer;
			this.buffer = "";
			this.scannedCount = 0;

			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				const pastedContent = this.pasteBuffer.slice(0, endIndex);
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				this.pasteMode = false;
				this.pasteBuffer = "";
				this.pendingKittyPrintableCodepoint = undefined;

				this.emit("paste", pastedContent);

				if (remaining.length > 0) {
					this.process(remaining);
				}
			}
			return;
		}

		const result = extractCompleteSequences(this.buffer, this.scannedCount);
		this.buffer = result.remainder;
		// The remainder is the pending incomplete sequence; all of it has been
		// scanned already, so the next chunk resumes at its end.
		this.scannedCount = this.buffer.length;

		for (const sequence of result.sequences) {
			this.emitDataSequence(sequence);
		}

		if (this.buffer.length > 0) {
			this.timeout = setTimeout(() => {
				const flushed = this.flush();

				for (const sequence of flushed) {
					this.emitDataSequence(sequence);
				}
			}, this.timeoutMs);
		}
	}

	private emitDataSequence(sequence: string): void {
		const rawCodepoint = sequence.length === 1 ? sequence.codePointAt(0) : undefined;
		if (rawCodepoint !== undefined && rawCodepoint === this.pendingKittyPrintableCodepoint) {
			this.pendingKittyPrintableCodepoint = undefined;
			return;
		}

		this.pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
		this.emit("data", sequence);
	}

	flush(): string[] {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		if (this.buffer.length === 0) {
			return [];
		}

		const sequences = [this.buffer];
		this.buffer = "";
		this.scannedCount = 0;
		this.pendingKittyPrintableCodepoint = undefined;
		return sequences;
	}

	clear(): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
		this.buffer = "";
		this.scannedCount = 0;
		this.pasteMode = false;
		this.pasteBuffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
	}

	getBuffer(): string {
		return this.buffer;
	}

	destroy(): void {
		this.clear();
	}
}

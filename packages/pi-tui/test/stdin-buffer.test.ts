/**
 * Tests for StdinBuffer
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { StdinBuffer } from "../src/stdin-buffer.ts";

describe("StdinBuffer", () => {
	let buffer: StdinBuffer;
	let emittedSequences: string[];

	beforeEach(() => {
		buffer = new StdinBuffer({ timeout: 10 });

		emittedSequences = [];
		buffer.on("data", (sequence) => {
			emittedSequences.push(sequence);
		});
	});

	function processInput(data: string | Buffer): void {
		buffer.process(data);
	}

	async function wait(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	describe("Regular Characters", () => {
		it("should pass through regular characters immediately", () => {
			processInput("a");
			assert.deepStrictEqual(emittedSequences, ["a"]);
		});

		it("should pass through multiple regular characters", () => {
			processInput("abc");
			assert.deepStrictEqual(emittedSequences, ["a", "b", "c"]);
		});

		it("should handle unicode characters", () => {
			processInput("hello 世界");
			assert.deepStrictEqual(emittedSequences, ["h", "e", "l", "l", "o", " ", "世", "界"]);
		});
	});

	describe("Complete Escape Sequences", () => {
		it("should pass through complete mouse SGR sequences", () => {
			const mouseSeq = "\x1b[<35;20;5m";
			processInput(mouseSeq);
			assert.deepStrictEqual(emittedSequences, [mouseSeq]);
		});

		it("should pass through complete arrow key sequences", () => {
			const upArrow = "\x1b[A";
			processInput(upArrow);
			assert.deepStrictEqual(emittedSequences, [upArrow]);
		});

		it("should pass through complete function key sequences", () => {
			const f1 = "\x1b[11~";
			processInput(f1);
			assert.deepStrictEqual(emittedSequences, [f1]);
		});

		it("should pass through meta key sequences", () => {
			const metaA = "\x1ba";
			processInput(metaA);
			assert.deepStrictEqual(emittedSequences, [metaA]);
		});

		it("should pass through SS3 sequences", () => {
			const ss3 = "\x1bOA";
			processInput(ss3);
			assert.deepStrictEqual(emittedSequences, [ss3]);
		});
	});

	describe("Partial Escape Sequences", () => {
		it("should buffer incomplete mouse SGR sequence", async () => {
			processInput("\x1b");
			assert.deepStrictEqual(emittedSequences, []);
			assert.strictEqual(buffer.getBuffer(), "\x1b");

			processInput("[<35");
			assert.deepStrictEqual(emittedSequences, []);
			assert.strictEqual(buffer.getBuffer(), "\x1b[<35");

			processInput(";20;5m");
			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;20;5m"]);
			assert.strictEqual(buffer.getBuffer(), "");
		});

		it("should buffer incomplete CSI sequence", () => {
			processInput("\x1b[");
			assert.deepStrictEqual(emittedSequences, []);

			processInput("1;");
			assert.deepStrictEqual(emittedSequences, []);

			processInput("5H");
			assert.deepStrictEqual(emittedSequences, ["\x1b[1;5H"]);
		});

		it("should buffer split across many chunks", () => {
			processInput("\x1b");
			processInput("[");
			processInput("<");
			processInput("3");
			processInput("5");
			processInput(";");
			processInput("2");
			processInput("0");
			processInput(";");
			processInput("5");
			processInput("m");

			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;20;5m"]);
		});

		it("should flush incomplete sequence after timeout", async () => {
			processInput("\x1b[<35");
			assert.deepStrictEqual(emittedSequences, []);

			await wait(15);

			assert.deepStrictEqual(emittedSequences, ["\x1b[<35"]);
		});
	});

	describe("Mixed Content", () => {
		it("should handle characters followed by escape sequence", () => {
			processInput("abc\x1b[A");
			assert.deepStrictEqual(emittedSequences, ["a", "b", "c", "\x1b[A"]);
		});

		it("should handle escape sequence followed by characters", () => {
			processInput("\x1b[Aabc");
			assert.deepStrictEqual(emittedSequences, ["\x1b[A", "a", "b", "c"]);
		});

		it("should handle multiple complete sequences", () => {
			processInput("\x1b[A\x1b[B\x1b[C");
			assert.deepStrictEqual(emittedSequences, ["\x1b[A", "\x1b[B", "\x1b[C"]);
		});

		it("should handle partial sequence with preceding characters", () => {
			processInput("abc\x1b[<35");
			assert.deepStrictEqual(emittedSequences, ["a", "b", "c"]);
			assert.strictEqual(buffer.getBuffer(), "\x1b[<35");

			processInput(";20;5m");
			assert.deepStrictEqual(emittedSequences, ["a", "b", "c", "\x1b[<35;20;5m"]);
		});
	});

	describe("Kitty Keyboard Protocol", () => {
		it("should handle Kitty CSI u press events", () => {
			processInput("\x1b[97u");
			assert.deepStrictEqual(emittedSequences, ["\x1b[97u"]);
		});

		it("should handle Kitty CSI u release events", () => {
			processInput("\x1b[97;1:3u");
			assert.deepStrictEqual(emittedSequences, ["\x1b[97;1:3u"]);
		});

		it("should handle batched Kitty press and release", () => {
			// Press 'a', release 'a' batched together (common over SSH)
			processInput("\x1b[97u\x1b[97;1:3u");
			assert.deepStrictEqual(emittedSequences, ["\x1b[97u", "\x1b[97;1:3u"]);
		});

		it("should handle multiple batched Kitty events", () => {
			processInput("\x1b[97u\x1b[97;1:3u\x1b[98u\x1b[98;1:3u");
			assert.deepStrictEqual(emittedSequences, ["\x1b[97u", "\x1b[97;1:3u", "\x1b[98u", "\x1b[98;1:3u"]);
		});

		it("should handle Kitty arrow keys with event type", () => {
			processInput("\x1b[1;1:1A");
			assert.deepStrictEqual(emittedSequences, ["\x1b[1;1:1A"]);
		});

		it("should handle Kitty functional keys with event type", () => {
			processInput("\x1b[3;1:3~");
			assert.deepStrictEqual(emittedSequences, ["\x1b[3;1:3~"]);
		});

		it("should split ESC+ESC+CSI into standalone ESC and the CSI sequence (WezTerm Escape key regression)", () => {
			// WezTerm with enable_kitty_keyboard sends Escape key press as raw \x1b
			// and the release as a full Kitty CSI-u sequence, concatenated.
			// The buffer must not treat \x1b\x1b as a complete meta-key when the
			// following byte starts a new escape sequence.
			processInput("\x1b\x1b[27;129:3u");
			assert.deepStrictEqual(emittedSequences, ["\x1b", "\x1b[27;129:3u"]);
		});

		it("should split ESC+ESC+CSI with no modifier (no num_lock)", () => {
			processInput("\x1b\x1b[27;1:3u");
			assert.deepStrictEqual(emittedSequences, ["\x1b", "\x1b[27;1:3u"]);
		});

		it("should still emit ESC+ESC as a single sequence when not followed by a new escape", () => {
			// \x1b\x1b alone (no following CSI) stays as-is — e.g. ctrl+alt+[
			processInput("\x1b\x1b");
			assert.deepStrictEqual(emittedSequences, ["\x1b\x1b"]);
		});

		it("should handle plain characters mixed with Kitty sequences", () => {
			processInput("a\x1b[97;1:3u");
			assert.deepStrictEqual(emittedSequences, ["a", "\x1b[97;1:3u"]);
		});

		it("should drop raw duplicate character after matching Kitty printable sequence", () => {
			processInput("\x1b[224uà");
			assert.deepStrictEqual(emittedSequences, ["\x1b[224u"]);
		});

		it("should drop raw duplicate character after matching Kitty printable sequence across chunks", () => {
			processInput("\x1b[64u");
			processInput("@");
			assert.deepStrictEqual(emittedSequences, ["\x1b[64u"]);
		});

		it("should keep non-matching plain character after Kitty printable sequence", () => {
			processInput("\x1b[97ub");
			assert.deepStrictEqual(emittedSequences, ["\x1b[97u", "b"]);
		});

		it("should keep raw character after modified Kitty printable sequence", () => {
			processInput("\x1b[64;3u@");
			assert.deepStrictEqual(emittedSequences, ["\x1b[64;3u", "@"]);
		});

		it("should handle rapid typing simulation with Kitty protocol", () => {
			// Simulates typing "hi" quickly with releases interleaved
			processInput("\x1b[104u\x1b[104;1:3u\x1b[105u\x1b[105;1:3u");
			assert.deepStrictEqual(emittedSequences, ["\x1b[104u", "\x1b[104;1:3u", "\x1b[105u", "\x1b[105;1:3u"]);
		});
	});

	describe("Mouse Events", () => {
		it("should handle mouse press event", () => {
			processInput("\x1b[<0;10;5M");
			assert.deepStrictEqual(emittedSequences, ["\x1b[<0;10;5M"]);
		});

		it("should handle mouse release event", () => {
			processInput("\x1b[<0;10;5m");
			assert.deepStrictEqual(emittedSequences, ["\x1b[<0;10;5m"]);
		});

		it("should handle mouse move event", () => {
			processInput("\x1b[<35;20;5m");
			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;20;5m"]);
		});

		it("should handle split mouse events", () => {
			processInput("\x1b[<3");
			processInput("5;1");
			processInput("5;");
			processInput("10m");
			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;15;10m"]);
		});

		it("should handle multiple mouse events", () => {
			processInput("\x1b[<35;1;1m\x1b[<35;2;2m\x1b[<35;3;3m");
			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;1;1m", "\x1b[<35;2;2m", "\x1b[<35;3;3m"]);
		});

		it("should handle old-style mouse sequence (ESC[M + 3 bytes)", () => {
			processInput("\x1b[M abc");
			assert.deepStrictEqual(emittedSequences, ["\x1b[M ab", "c"]);
		});

		it("should buffer incomplete old-style mouse sequence", () => {
			processInput("\x1b[M");
			assert.strictEqual(buffer.getBuffer(), "\x1b[M");

			processInput(" a");
			assert.strictEqual(buffer.getBuffer(), "\x1b[M a");

			processInput("b");
			assert.deepStrictEqual(emittedSequences, ["\x1b[M ab"]);
		});
	});

	describe("Edge Cases", () => {
		it("should handle empty input", () => {
			processInput("");
			assert.deepStrictEqual(emittedSequences, [""]);
		});

		it("should handle lone escape character with timeout", async () => {
			processInput("\x1b");
			assert.deepStrictEqual(emittedSequences, []);

			await wait(15);
			assert.deepStrictEqual(emittedSequences, ["\x1b"]);
		});

		it("should handle lone escape character with explicit flush", () => {
			processInput("\x1b");
			assert.deepStrictEqual(emittedSequences, []);

			const flushed = buffer.flush();
			assert.deepStrictEqual(flushed, ["\x1b"]);
		});

		it("should handle buffer input", () => {
			processInput(Buffer.from("\x1b[A"));
			assert.deepStrictEqual(emittedSequences, ["\x1b[A"]);
		});

		it("should handle very long sequences", () => {
			const longSeq = `\x1b[${"1;".repeat(50)}H`;
			processInput(longSeq);
			assert.deepStrictEqual(emittedSequences, [longSeq]);
		});
	});

	describe("Flush", () => {
		it("should flush incomplete sequences", () => {
			processInput("\x1b[<35");
			const flushed = buffer.flush();
			assert.deepStrictEqual(flushed, ["\x1b[<35"]);
			assert.strictEqual(buffer.getBuffer(), "");
		});

		it("should return empty array if nothing to flush", () => {
			const flushed = buffer.flush();
			assert.deepStrictEqual(flushed, []);
		});

		it("should emit flushed data via timeout", async () => {
			processInput("\x1b[<35");
			assert.deepStrictEqual(emittedSequences, []);

			await wait(15);

			assert.deepStrictEqual(emittedSequences, ["\x1b[<35"]);
		});
	});

	describe("Clear", () => {
		it("should clear buffered content without emitting", () => {
			processInput("\x1b[<35");
			assert.strictEqual(buffer.getBuffer(), "\x1b[<35");

			buffer.clear();
			assert.strictEqual(buffer.getBuffer(), "");
			assert.deepStrictEqual(emittedSequences, []);
		});
	});

	describe("Bracketed Paste", () => {
		let emittedPaste: string[] = [];

		beforeEach(() => {
			buffer = new StdinBuffer({ timeout: 10 });

			emittedSequences = [];
			buffer.on("data", (sequence) => {
				emittedSequences.push(sequence);
			});

			emittedPaste = [];
			buffer.on("paste", (data) => {
				emittedPaste.push(data);
			});
		});

		it("should emit paste event for complete bracketed paste", () => {
			const pasteStart = "\x1b[200~";
			const pasteEnd = "\x1b[201~";
			const content = "hello world";

			processInput(pasteStart + content + pasteEnd);

			assert.deepStrictEqual(emittedPaste, ["hello world"]);
			assert.deepStrictEqual(emittedSequences, []); // No data events during paste
		});

		it("should handle paste arriving in chunks", () => {
			processInput("\x1b[200~");
			assert.deepStrictEqual(emittedPaste, []);

			processInput("hello ");
			assert.deepStrictEqual(emittedPaste, []);

			processInput("world\x1b[201~");
			assert.deepStrictEqual(emittedPaste, ["hello world"]);
			assert.deepStrictEqual(emittedSequences, []);
		});

		it("should handle paste with input before and after", () => {
			processInput("a");
			processInput("\x1b[200~pasted\x1b[201~");
			processInput("b");

			assert.deepStrictEqual(emittedSequences, ["a", "b"]);
			assert.deepStrictEqual(emittedPaste, ["pasted"]);
		});

		it("should handle paste with newlines", () => {
			processInput("\x1b[200~line1\nline2\nline3\x1b[201~");

			assert.deepStrictEqual(emittedPaste, ["line1\nline2\nline3"]);
			assert.deepStrictEqual(emittedSequences, []);
		});

		it("should handle paste with unicode", () => {
			processInput("\x1b[200~Hello 世界 🎉\x1b[201~");

			assert.deepStrictEqual(emittedPaste, ["Hello 世界 🎉"]);
			assert.deepStrictEqual(emittedSequences, []);
		});
	});

	describe("Adversarial split feeds (resume cursor)", () => {
		// Every case feeds the same bytes twice: once in a single process()
		// call and once split into pieces. The emitted sequence stream must be
		// identical — the resume cursor must not change segmentation semantics.
		function feedInPieces(input: string, pieces: number): string[] {
			const chunked = new StdinBuffer({ timeout: 10_000 });
			const out: string[] = [];
			chunked.on("data", (s) => out.push(s));
			const step = Math.max(1, Math.ceil(input.length / pieces));
			for (let i = 0; i < input.length; i += step) {
				chunked.process(input.slice(i, i + step));
			}
			return out;
		}

		function feedOneShot(input: string): string[] {
			const oneShot = new StdinBuffer({ timeout: 10_000 });
			const out: string[] = [];
			oneShot.on("data", (s) => out.push(s));
			oneShot.process(input);
			return out;
		}

		const cases: Record<string, string> = {
			"plain text": "hello world",
			"unicode text": "hi 世界!",
			"CSI arrow": "\x1b[A",
			"CSI long params": "\x1b[1;2;3;4;5H",
			"CSI with garbage params": "\x1b[???~~~",
			"SGR mouse press": "\x1b[<0;10;5M",
			"SGR mouse move": "\x1b[<35;20;5m",
			"old-style mouse": "\x1b[M ab",
			"SS3": "\x1bOA",
			"OSC BEL": "\x1b]0;window title\x07",
			"OSC ST": "\x1b]8;;https://example.com\x1b\\",
			"DCS XTVersion": "\x1bP>|xtversion 1.0\x1b\\",
			"APC kitty": "\x1b_Ga=T,f=32,s=1,v=1;\x1b\\",
			"meta key": "\x1ba",
			"ESC ESC alone": "\x1b\x1b",
			"kitty batched": "\x1b[97u\x1b[97;1:3u",
			"mixed stream": "ab\x1b[A\x1b[<1;2;3m cd\x1b]0;t\x07ef\x1bOBgh",
		};

		for (const [name, input] of Object.entries(cases)) {
			it(`byte-by-byte equals one-shot: ${name}`, () => {
				assert.deepStrictEqual(feedInPieces(input, input.length), feedOneShot(input));
			});

			it(`three chunks equals one-shot: ${name}`, () => {
				assert.deepStrictEqual(feedInPieces(input, 3), feedOneShot(input));
			});
		}

		it("pins the chunk-dependent WezTerm ESC+ESC split (matches the previous scanner)", () => {
			// When '\x1b\x1b' is the whole buffer it completes as a meta sequence
			// (no next char exists to prove a CSI follows); the later CSI bytes
			// then arrive as plain input. The one-shot split only happens when
			// the CSI start is present in the same chunk — that timing
			// dependence existed in the slice-based scanner as well.
			processInput("\x1b");
			processInput("\x1b");
			assert.deepStrictEqual(emittedSequences, ["\x1b\x1b"]);
			processInput("[27;129:3u");
			assert.deepStrictEqual(emittedSequences, [
				"\x1b\x1b",
				"[",
				"2",
				"7",
				";",
				"1",
				"2",
				"9",
				":",
				"3",
				"u",
			]);
		});

		it("completes an OSC ST terminator straddling the resume cursor", () => {
			processInput("\x1b]0;title\x1b");
			assert.deepStrictEqual(emittedSequences, []);
			processInput("\\");
			assert.deepStrictEqual(emittedSequences, ["\x1b]0;title\x1b\\"]);
		});

		it("completes a DCS ST terminator straddling the resume cursor", () => {
			processInput("\x1bP1;r\x1b");
			assert.deepStrictEqual(emittedSequences, []);
			processInput("\\");
			assert.deepStrictEqual(emittedSequences, ["\x1bP1;r\x1b\\"]);
		});

		it("keeps an invalid SGR mouse payload incomplete even as it grows", () => {
			processInput("\x1b[<1;2;3x");
			assert.deepStrictEqual(emittedSequences, []);
			// A terminator-looking char after a corrupted payload still does not
			// complete: the whole payload must match the SGR pattern.
			processInput("m");
			assert.deepStrictEqual(emittedSequences, []);
			assert.strictEqual(buffer.getBuffer(), "\x1b[<1;2;3xm");
			assert.deepStrictEqual(buffer.flush(), ["\x1b[<1;2;3xm"]);
		});

		it("keeps an over-long SGR mouse payload incomplete", () => {
			processInput("\x1b[<1;2;3");
			processInput(";4;5m");
			assert.deepStrictEqual(emittedSequences, []);
			assert.strictEqual(buffer.getBuffer(), "\x1b[<1;2;3;4;5m");
			assert.deepStrictEqual(buffer.flush(), ["\x1b[<1;2;3;4;5m"]);
		});

		it("keeps an SGR payload with an embedded early M incomplete (matches previous scanner)", () => {
			// The 'M' after '<1;2' is not a valid terminator (needs 3 digit
			// groups), and appending ';3M' does not make '<1;2M;3M' valid
			// either — the payload must be exactly <digits;digits;digits[Mm].
			processInput("\x1b[<1;2M");
			assert.deepStrictEqual(emittedSequences, []);
			processInput(";3M");
			assert.deepStrictEqual(emittedSequences, []);
			assert.deepStrictEqual(buffer.flush(), ["\x1b[<1;2M;3M"]);
		});

		it("splits WezTerm ESC+ESC+CSI fed across chunks", () => {
			processInput("\x1b");
			assert.deepStrictEqual(emittedSequences, []);
			processInput("\x1b[27;129:3u");
			assert.deepStrictEqual(emittedSequences, ["\x1b", "\x1b[27;129:3u"]);
		});

		it("handles a long OSC drip-fed in small chunks", () => {
			const payload = "A".repeat(4096);
			const seq = `\x1b]52;c;${payload}\x07`;
			assert.deepStrictEqual(feedInPieces(seq, 64), [seq]);
		});

		it("resets the resume cursor on flush and keeps parsing fresh input", () => {
			processInput("\x1b[<35");
			assert.deepStrictEqual(buffer.flush(), ["\x1b[<35"]);
			processInput("m");
			assert.deepStrictEqual(emittedSequences, ["m"]);
			processInput("\x1b[A");
			assert.deepStrictEqual(emittedSequences, ["m", "\x1b[A"]);
		});

		it("resets the resume cursor on clear and keeps parsing fresh input", () => {
			processInput("\x1b]0;unterminated");
			buffer.clear();
			processInput("\x1b[B");
			assert.deepStrictEqual(emittedSequences, ["\x1b[B"]);
		});

		it("drops a partial escape right before a paste start (existing lossy behavior)", () => {
			const emittedPaste: string[] = [];
			buffer.on("paste", (data) => emittedPaste.push(data));
			processInput("\x1b[");
			processInput("\x1b[200~hello\x1b[201~");
			assert.deepStrictEqual(emittedPaste, ["hello"]);
			assert.deepStrictEqual(emittedSequences, []);
			processInput("a");
			assert.deepStrictEqual(emittedSequences, ["a"]);
		});
	});

	describe("Destroy", () => {
		it("should clear buffer on destroy", () => {
			processInput("\x1b[<35");
			assert.strictEqual(buffer.getBuffer(), "\x1b[<35");

			buffer.destroy();
			assert.strictEqual(buffer.getBuffer(), "");
		});

		it("should clear pending timeouts on destroy", async () => {
			processInput("\x1b[<35");
			buffer.destroy();

			await wait(15);

			assert.deepStrictEqual(emittedSequences, []);
		});
	});
});

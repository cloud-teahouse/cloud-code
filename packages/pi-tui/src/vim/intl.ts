/**
 * Intl segmenter helpers for the vim engine.
 *
 * The shared, lazily-initialized segmenters live in pi-tui's utils; this
 * module re-exports them and adds the grapheme helpers the ported vim code
 * relies on (Claude Code's src/utils/intl.ts equivalents).
 */

import { getGraphemeSegmenter } from "../utils.ts";

export { getGraphemeSegmenter, getWordSegmenter } from "../utils.ts";

/**
 * Extract the first grapheme cluster from a string.
 * Returns "" for empty strings.
 */
export function firstGrapheme(text: string): string {
	if (!text) return "";
	const segments = getGraphemeSegmenter().segment(text);
	const first = segments[Symbol.iterator]().next().value;
	return first?.segment ?? "";
}

/**
 * Extract the last grapheme cluster from a string.
 * Returns "" for empty strings.
 */
export function lastGrapheme(text: string): string {
	if (!text) return "";
	let last = "";
	for (const { segment } of getGraphemeSegmenter().segment(text)) {
		last = segment;
	}
	return last;
}

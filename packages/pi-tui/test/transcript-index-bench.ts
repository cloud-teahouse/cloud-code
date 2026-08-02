/**
 * Wall-clock comparison of the legacy linear transcript walks vs the row
 * index, on a 2000-child transcript. Not a test — run directly:
 *   node test/transcript-index-bench.ts
 *
 * "legacy" reproduces exactly what the old code did per operation:
 * - hit-test: top-down walk rendering every child above the hit line;
 * - compose: render every child, prefix the gutter onto every line, concat
 *   into one array, then slice the viewport window out of it.
 * "indexed" is the new path: binary search / window-only materialization.
 */
import { TranscriptRowIndex } from "../src/transcript-index.ts";
import { type Component, Container } from "../src/tui.ts";

const CHILDREN = 2000;
const CHILD_HEIGHT = 2;
const WIDTH = 75;
const VIEWPORT = 7;
const LOOKS = 20_000;

class BenchChild implements Component {
	readonly lines = [`${"x".repeat(20)}`, `${"y".repeat(20)}`];
	renderCalls = 0;
	render(_width: number): string[] {
		this.renderCalls++;
		return this.lines;
	}
	invalidate(): void {}
}

const container = new Container();
const children: BenchChild[] = [];
for (let i = 0; i < CHILDREN; i++) {
	const child = new BenchChild();
	children.push(child);
	container.addChild(child);
}

const index = new TranscriptRowIndex();
index.syncFull(container, WIDTH);

function time(label: string, fn: () => void): number {
	// Warmup
	for (let i = 0; i < 100; i++) fn();
	const start = performance.now();
	for (let i = 0; i < LOOKS; i++) fn();
	const ms = (performance.now() - start) / LOOKS;
	console.log(`${label.padEnd(56)} ${(ms * 1000).toFixed(2).padStart(10)} µs/op`);
	return ms;
}

console.log(`transcript: ${CHILDREN} children × ${CHILD_HEIGHT} lines = ${CHILDREN * CHILD_HEIGHT} rows, viewport ${VIEWPORT} rows\n`);

// --- hit-test: pointer near the bottom (worst case for the legacy walk) ---
const hitLine = CHILDREN * CHILD_HEIGHT - 3;

const legacyHit = time("legacy hit-test (walk+render to hit line)", () => {
	let acc = 0;
	for (const child of container.children) {
		const height = child.render(WIDTH).length;
		if (hitLine >= acc && hitLine < acc + height) break;
		acc += height;
	}
});

const indexedHit = time("indexed hit-test (binary search)", () => {
	index.locate(hitLine);
});

console.log(`  → ${(legacyHit / indexedHit).toFixed(0)}× faster\n`);

// --- compose: steady frame (scroll position changed, content frozen) ---
const lead = "  ";
const scrollTop = CHILDREN * CHILD_HEIGHT - VIEWPORT;

const legacyCompose = time("legacy compose (render+prefix+concat+slice)", () => {
	const out: string[] = [];
	for (const child of container.children) {
		for (const line of child.render(WIDTH)) out.push(lead + line);
	}
	out.slice(scrollTop, scrollTop + VIEWPORT);
});

const prefixCache = new WeakMap<string[], string[]>();
const indexedCompose = time("indexed compose (window materialization)", () => {
	const rows: string[] = [];
	for (const entry of index.windowEntries(scrollTop, scrollTop + VIEWPORT)) {
		let block = prefixCache.get(entry.lines);
		if (block === undefined) {
			block = entry.lines.map((line) => lead + line);
			prefixCache.set(entry.lines, block);
		}
		const start = Math.max(scrollTop - entry.base, 0);
		const end = Math.min(entry.base + entry.height, scrollTop + VIEWPORT) - entry.base;
		for (let i = start; i < end; i++) rows.push(block[i]!);
	}
});

console.log(`  → ${(legacyCompose / indexedCompose).toFixed(0)}× faster\n`);

// --- compose: revalidation frame (one child changed; both paths walk all) ---
const legacyDirty = time("legacy dirty frame (same as steady)", () => {
	const out: string[] = [];
	for (const child of container.children) {
		for (const line of child.render(WIDTH)) out.push(lead + line);
	}
	out.slice(scrollTop, scrollTop + VIEWPORT);
});

const indexedDirty = time("indexed dirty frame (syncFull + window)", () => {
	index.syncFull(container, WIDTH);
	const rows: string[] = [];
	for (const entry of index.windowEntries(scrollTop, scrollTop + VIEWPORT)) {
		const start = Math.max(scrollTop - entry.base, 0);
		const end = Math.min(entry.base + entry.height, scrollTop + VIEWPORT) - entry.base;
		for (let i = start; i < end; i++) rows.push(entry.lines[i]!);
	}
});

console.log(`  → ${(legacyDirty / indexedDirty).toFixed(2)}× (dirty frames stay O(children) by design)`);

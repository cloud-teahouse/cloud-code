import type { Component, Container } from "./tui.ts";

/**
 * Per-child geometry of one synced transcript: the rendered lines (kept so the
 * composer can materialize the viewport window without re-rendering), the
 * child's first transcript row, and its row count.
 */
export interface TranscriptIndexEntry {
	child: Component;
	lines: string[];
	base: number;
	height: number;
}

/**
 * Row-geometry index over the transcript scroll container's children.
 *
 * The fullscreen composer and the transcript mouse hit-tests both need
 * line → child lookups constantly (once per composed frame, once per pointer
 * cell for motion). A top-down walk that renders every child to sum heights
 * is O(transcript rows) each time, so the TUI keeps this index instead: each
 * child's rendered line count is cached (keyed on the layout width, which is
 * what changes line counts), prefix sums answer lookups in O(log n), and the
 * composer materializes only the viewport window from the cached lines.
 *
 * Freshness contract: component mutations that affect layout request a render
 * (the TUI latches that as dirty), so a full revalidation — one render call
 * per child, a cache hit for unchanged content — runs on the first compose
 * after any mutation, and every other consumer (hit-tests, scroll-driven
 * frames) may trust the cached geometry because layout is frozen between
 * renders.
 */
export class TranscriptRowIndex {
	private container: Container | null = null;
	private width = -1;
	private childrenArray: readonly Component[] | null = null;
	private entries: TranscriptIndexEntry[] = [];
	private _totalLines = 0;
	/**
	 * Containers whose render the index cannot reproduce (per-child chrome
	 * rows reported via rowsBeforeChild). Declined once and left to the legacy
	 * whole-render path until the next reset, instead of paying for a failed
	 * sync attempt on every frame.
	 */
	private declinedContainer: Container | null = null;

	get totalLines(): number {
		return this._totalLines;
	}

	/** Drop all cached geometry (region swap, tree-wide invalidate). */
	reset(): void {
		this.container = null;
		this.width = -1;
		this.childrenArray = null;
		this.entries = [];
		this._totalLines = 0;
		this.declinedContainer = null;
	}

	/** Whether the container already declined index composition. */
	isDeclinedFor(container: Container): boolean {
		return this.declinedContainer === container;
	}

	/**
	 * Whether the cached geometry matches this container and width: same child
	 * list (identity scan, no renders) at the same layout width. A warm index
	 * plus no latched mutation means the geometry is exact, since layout only
	 * changes between renders.
	 */
	isWarmFor(container: Container, width: number): boolean {
		if (this.declinedContainer === container) return false;
		if (this.container !== container || this.width !== width) return false;
		const children = container.children;
		if (this.childrenArray !== children || this.entries.length !== children.length) return false;
		for (let i = 0; i < children.length; i++) {
			if (this.entries[i]!.child !== children[i]) return false;
		}
		return true;
	}

	/**
	 * Revalidate every child's geometry: one render call per child (a cache hit
	 * for unchanged content), while retaining entries whose child and lines
	 * references are unchanged. Once the first changed child is found, only the
	 * suffix's prefix bases are updated. Returns false when the container paints
	 * per-child chrome rows (rowsBeforeChild), which the index cannot reproduce —
	 * the caller falls back to whole-container rendering.
	 */
	syncFull(container: Container, width: number): boolean {
		const children = container.children;
		for (const child of children) {
			if (container.rowsBeforeChild(child) !== 0) {
				this.container = null;
				this.childrenArray = null;
				this.entries = [];
				this._totalLines = 0;
				this.declinedContainer = container;
				return false;
			}
		}

		const entries = this.entries;
		let base = 0;
		let firstChanged = -1;
		for (let i = 0; i < children.length; i++) {
			const child = children[i]!;
			const previous = entries[i];
			const lines = child.render(width);
			const unchanged = previous !== undefined && previous.child === child && previous.lines === lines;

			if (firstChanged === -1 && unchanged) {
				base += previous.height;
				continue;
			}
			if (firstChanged === -1) firstChanged = i;

			const entry = previous !== undefined && previous.child === child ? previous : { child, lines, base, height: lines.length };
			entry.child = child;
			entry.lines = lines;
			entry.base = base;
			entry.height = lines.length;
			entries[i] = entry;
			base += entry.height;
		}
		if (entries.length > children.length) entries.length = children.length;

		this.container = container;
		this.width = width;
		this.childrenArray = children;
		this._totalLines = base;
		return true;
	}

	/**
	 * The child occupying transcript `line`, via binary search over the prefix
	 * sums. Null when the line falls outside the synced content.
	 */
	locate(line: number): TranscriptIndexEntry | null {
		const index = this.locateIndex(line);
		return index === -1 ? null : this.entries[index]!;
	}

	/**
	 * Children intersecting [fromLine, toLine), in order — the compose window.
	 */
	*windowEntries(fromLine: number, toLine: number): Iterable<TranscriptIndexEntry> {
		let i = this.locateIndex(fromLine);
		if (i === -1) return;
		const entries = this.entries;
		for (; i < entries.length && entries[i]!.base < toLine; i++) {
			yield entries[i]!;
		}
	}

	/**
	 * Index of the entry owning `line`: the rightmost entry with base ≤ line,
	 * provided the line falls within its height (zero-height entries can never
	 * own a line). -1 when the line falls outside the synced content.
	 */
	private locateIndex(line: number): number {
		const entries = this.entries;
		let lo = 0;
		let hi = entries.length - 1;
		let found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (entries[mid]!.base <= line) {
				found = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		if (found === -1) return -1;
		const entry = entries[found]!;
		return line < entry.base + entry.height ? found : -1;
	}
}

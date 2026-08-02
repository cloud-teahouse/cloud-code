/**
 * Virtual scrollbar — the shared model behind the hover-revealed bars on the
 * rightmost column of scrollable surfaces (transcript viewport, takeover
 * browsers, taller slot dialogs).
 *
 * Geometry: the track is a single column spanning the scrollable region's
 * rows; the thumb's size is proportional to viewport/content and its offset
 * to scrollTop/maxScroll. A press distinguishes two cases, matching GUI
 * scrollbars: landing on the thumb anchors the pointer at that row within
 * the thumb (grab delta — the content does not jump, and the drag tracks
 * the pointer 1:1 through {@link scrollTopForThumbOffset}); landing on the
 * bare track jumps to the pointed fraction of the content
 * ({@link scrollTopForTrackRow}), and the drag keeps applying that absolute
 * mapping. Either way the press captures the drag session's geometry
 * ({@link Scrollbar.dragSession}) so per-motion drags never re-derive it.
 *
 * Presentation: bars are hover-revealed overlays, never a reserved column —
 * {@link Scrollbar} tracks the reveal/drag state and {@link drawScrollbar}
 * splices the glyphs over the target column only while engaged. Surfaces
 * skip the bar entirely when the content fits the viewport or the track is
 * shorter than {@link MIN_TRACK_ROWS} rows (a 1–2 row track cannot show a
 * meaningful track+thumb pair).
 */

import { sliceWithWidth } from "./utils.ts";

/** Scroll position of a surface, in rendered lines (or window rows). */
export interface ScrollbarMetrics {
	/** First content line visible at the top of the viewport. */
	readonly scrollTop: number;
	/** Rows visible at once. */
	readonly viewport: number;
	/** Total rows of scrollable content. */
	readonly content: number;
}

/** Thumb placement within the track, both 0-based rows. */
export interface ScrollbarThumb {
	readonly offset: number;
	readonly size: number;
}

/** Tracks shorter than this never show a bar (tiny surfaces are skipped). */
export const MIN_TRACK_ROWS = 3;

/** Default glyphs; surfaces restyle through {@link ScrollbarStyle}. */
export const SCROLLBAR_TRACK_GLYPH = "░";
export const SCROLLBAR_THUMB_GLYPH = "█";

/** Styling hook for the two glyph kinds (identity by default). */
export interface ScrollbarStyle {
	readonly track: (glyph: string) => string;
	readonly thumb: (glyph: string) => string;
}

const DEFAULT_STYLE: ScrollbarStyle = { track: (g) => g, thumb: (g) => g };

/** Largest scroll offset: the clamp every mapping lands within. */
export function maxScrollOf(metrics: ScrollbarMetrics): number {
	return Math.max(0, metrics.content - metrics.viewport);
}

/**
 * Thumb geometry for a track of `trackHeight` rows, or null when the bar
 * should not be shown at all (content fits the viewport, degenerate
 * metrics, or a track too short to read).
 */
export function scrollbarThumb(metrics: ScrollbarMetrics, trackHeight: number): ScrollbarThumb | null {
	const maxScroll = maxScrollOf(metrics);
	if (maxScroll <= 0 || metrics.viewport <= 0 || trackHeight < MIN_TRACK_ROWS) return null;
	const size = Math.max(1, Math.min(trackHeight, Math.round((trackHeight * metrics.viewport) / metrics.content)));
	const scrollTop = Math.max(0, Math.min(metrics.scrollTop, maxScroll));
	const offset = Math.round(((trackHeight - size) * scrollTop) / maxScroll);
	return { offset, size };
}

/**
 * The absolute track mapping: the scroll offset whose fraction of
 * `maxScroll` equals the pointer's fraction down the track. Rows outside
 * the track clamp to the nearest end, so a drag running past the top or
 * bottom edge keeps scrolling to the limit.
 */
export function scrollTopForTrackRow(
	metrics: ScrollbarMetrics,
	trackHeight: number,
	trackRow: number,
): number {
	const maxScroll = maxScrollOf(metrics);
	if (maxScroll <= 0) return 0;
	const fraction = trackHeight <= 1 ? 0 : Math.max(0, Math.min(1, trackRow / (trackHeight - 1)));
	return Math.round(fraction * maxScroll);
}

/**
 * Inverse of {@link scrollbarThumb}'s offset mapping: the scroll offset that
 * puts the thumb's top edge at `thumbOffset`, clamped to the thumb's travel
 * so a grab-drag running past an edge keeps scrolling to the limit. This is
 * the grab-drag counterpart of {@link scrollTopForTrackRow}.
 */
export function scrollTopForThumbOffset(
	metrics: ScrollbarMetrics,
	trackHeight: number,
	thumbOffset: number,
): number {
	const maxScroll = maxScrollOf(metrics);
	if (maxScroll <= 0) return 0;
	const thumb = scrollbarThumb(metrics, trackHeight);
	if (thumb === null) return 0;
	const travel = trackHeight - thumb.size;
	if (travel <= 0) return 0;
	const clamped = Math.max(0, Math.min(travel, thumbOffset));
	return Math.round((clamped / travel) * maxScroll);
}

/**
 * Geometry snapshot a drag session maps against, captured by
 * {@link Scrollbar.press} and exposed through {@link Scrollbar.dragSession}.
 * Content height is expensive to re-derive on some surfaces (a full content
 * rebuild) and barely changes mid-drag, so the whole drag reuses the
 * snapshot; surfaces re-settle against live metrics on release.
 */
export interface ScrollbarDragSession {
	/** Total rows of scrollable content, as of the press. */
	readonly content: number;
	/** Rows visible at once, as of the press. */
	readonly viewport: number;
	/** Track rows the drag maps against, as of the press. */
	readonly trackHeight: number;
	/** True when the press grabbed the thumb (the drag tracks the pointer
	 * 1:1); false for a track press (the drag keeps the absolute mapping). */
	readonly grabbedThumb: boolean;
}

/**
 * Reveal/drag state machine for one surface's scrollbar. The bar renders
 * while {@link engaged} — the pointer hovers the track column or a drag is
 * in progress (a drag keeps the bar revealed even when the pointer leaves
 * the column, matching GUI scrollbar capture).
 */
export class Scrollbar {
	private hovered = false;
	private dragActive = false;
	private session:
		| {
				readonly snapshot: ScrollbarDragSession;
				/** Rows from the thumb's top edge the pointer grabbed it at;
				 * null for a track press. */
				readonly grabOffset: number | null;
		  }
		| null = null;

	/** True while the bar should render: hovered or mid-drag. */
	get engaged(): boolean {
		return this.hovered || this.dragActive;
	}

	/** True between {@link press} and {@link release}. */
	get dragging(): boolean {
		return this.dragActive;
	}

	/** The active drag's geometry snapshot, or null outside a drag. */
	get dragSession(): ScrollbarDragSession | null {
		return this.session?.snapshot ?? null;
	}

	/**
	 * Pointer motion without a button held: `onTrack` is whether the pointer
	 * sits on the track column. Returns true when the reveal state changed
	 * (a re-render is warranted).
	 */
	hover(onTrack: boolean): boolean {
		if (onTrack === this.hovered) return false;
		this.hovered = onTrack;
		return true;
	}

	/**
	 * Begin a drag from a press on the track; returns the target scrollTop.
	 * A press landing on the thumb anchors the pointer at that row within the
	 * thumb — the content does not jump (grab delta) — while a press on the
	 * bare track jumps to the pointed fraction. Either way the press captures
	 * the session the drag maps against ({@link dragSession}).
	 */
	press(trackRow: number, metrics: ScrollbarMetrics, trackHeight: number): number {
		this.dragActive = true;
		const thumb = scrollbarThumb(metrics, trackHeight);
		const grabOffset =
			thumb !== null && trackRow >= thumb.offset && trackRow < thumb.offset + thumb.size
				? trackRow - thumb.offset
				: null;
		this.session = {
			snapshot: {
				content: metrics.content,
				viewport: metrics.viewport,
				trackHeight,
				grabbedThumb: grabOffset !== null,
			},
			grabOffset,
		};
		if (grabOffset !== null) {
			// Thumb grab: hold the current position, the drag moves from here.
			return Math.max(0, Math.min(metrics.scrollTop, maxScrollOf(metrics)));
		}
		return scrollTopForTrackRow(metrics, trackHeight, trackRow);
	}

	/**
	 * Continue an active drag; returns the target scrollTop, mapped against
	 * the session captured by {@link press}. A thumb grab tracks the pointer
	 * 1:1 (thumb top = pointer row − grab offset, clamped to the travel); a
	 * track press keeps applying the absolute fraction mapping.
	 */
	drag(trackRow: number): number {
		const s = this.session;
		if (s === null) return 0;
		const metrics = { scrollTop: 0, viewport: s.snapshot.viewport, content: s.snapshot.content };
		if (s.grabOffset === null) return scrollTopForTrackRow(metrics, s.snapshot.trackHeight, trackRow);
		return scrollTopForThumbOffset(metrics, s.snapshot.trackHeight, trackRow - s.grabOffset);
	}

	/** End the drag (button released); drops the session snapshot. The
	 * reveal then follows the hover. */
	release(): void {
		this.dragActive = false;
		this.session = null;
	}
}

/**
 * Splice the bar into `lines` at `col` (1-based): every row gets the track
 * glyph, rows `[thumb.offset, thumb.offset + thumb.size)` the thumb glyph.
 * Each line is truncated or space-padded to `col - 1` visible columns first
 * (ANSI-aware, wide-char strict), so the glyph always lands on the exact
 * column regardless of the row's own width. Input lines are not mutated.
 */
export function drawScrollbar(
	lines: readonly string[],
	col: number,
	thumb: ScrollbarThumb,
	style: ScrollbarStyle = DEFAULT_STYLE,
): string[] {
	return lines.map((line, row) => {
		const { text, width } = sliceWithWidth(line, 0, Math.max(0, col - 1), true);
		const padded = width >= col - 1 ? text : text + " ".repeat(col - 1 - width);
		const inThumb = row >= thumb.offset && row < thumb.offset + thumb.size;
		return padded + (inThumb ? style.thumb(SCROLLBAR_THUMB_GLYPH) : style.track(SCROLLBAR_TRACK_GLYPH));
	});
}

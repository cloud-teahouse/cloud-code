/**
 * Minimal TUI implementation with differential rendering
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { hasHitZones, hitZoneAt, resolveHitZones, type HitZone, type HitZoneId, type HitZoneSemantics, type ResolvedHitZone } from "./hit-zones.ts";
import { isKeyRelease, matchesKey } from "./keys.ts";
import { getKeybindings } from "./keybindings.ts";
import {
	drawScrollbar,
	scrollbarThumb,
	scrollTopForThumbOffset,
	scrollTopForTrackRow,
	type ScrollbarStyle,
} from "./scrollbar.ts";
import type { Terminal } from "./terminal.ts";
import {
	isOsc11BackgroundColorResponse,
	parseOsc11BackgroundColor,
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
} from "./terminal-colors.ts";
import { deleteKittyImage, getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.ts";
import { TranscriptRowIndex } from "./transcript-index.ts";
import {
	asciiVisibleWidth,
	extractSegments,
	normalizeTerminalOutput,
	sliceByColumn,
	sliceWithWidth,
	visibleWidth,
} from "./utils.ts";

const KITTY_SEQUENCE_PREFIX = "\x1b_G";

/** Shared empty id list for non-image lines in the per-line image-id cache. */
const EMPTY_IMAGE_IDS: readonly number[] = [];

interface KittyImageHeader {
	ids: number[];
	rows: number;
}

function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return undefined;

	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return undefined;

	const ids: number[] = [];
	let rows = 1;
	const params = line.slice(paramsStart, paramsEnd);
	for (const param of params.split(",")) {
		const [key, value] = param.split("=", 2);
		if (value === undefined) continue;
		const numberValue = Number(value);
		if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 0xffffffff) continue;
		if (key === "i") {
			ids.push(numberValue);
		} else if (key === "r") {
			rows = numberValue;
		}
	}
	return { ids, rows };
}

function extractKittyImageIds(line: string): number[] {
	return parseKittyImageHeader(line)?.ids ?? [];
}

function extractKittyImageRows(line: string): number {
	return parseKittyImageHeader(line)?.rows ?? 1;
}

/**
 * A parsed SGR mouse event. Coordinates are 1-based terminal cells as
 * reported, with two exceptions: for wheel events forwarded to a focused
 * component in the bottom slot, `row` is translated to be relative to the
 * slot's first row and `slotRelative` is true (takeover components get raw
 * terminal rows); for left-press and motion events forwarded to the focused
 * component, `row` is translated to the component's own first rendered line
 * (0-based, via each container's rendered child heights plus its
 * {@link Container.rowsBeforeChild} chrome, plus the rows clipped off the
 * slot's top when it is taller than the screen) and `col` is translated past
 * each container's {@link Container.leftInset} gutter, so components can do
 * row/col-hit selection without knowing the layout.
 *
 * Motion events (any-motion tracking, mode 1003) carry the pointer cell;
 * `button` is the held button with the SGR motion bit (32) stripped (3 = no
 * button). A forwarded motion event with `row === -1` signals the pointer
 * left the focused component's region — components treat it as hover-clear.
 */
export interface MouseEvent {
  readonly type: 'wheel' | 'press' | 'release' | 'motion';
  /** SGR button code: 64 = wheel up, 65 = wheel down, 0 = left, 1 = middle, 2 = right.
   *  For motion events the motion bit (32) is already stripped; 3 = no button held. */
  readonly button: number;
  readonly col: number;
  readonly row: number;
  readonly slotRelative: boolean;
}

/**
 * Component interface - all components must implement this
 */
export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/**
	 * Optional handler for keyboard input when component has focus
	 */
	handleInput?(data: string): void;

	/**
	 * Optional handler for mouse input when component has focus (fullscreen
	 * mode only). Wheel events are routed here instead of scrolling the
	 * transcript whenever the focused component is not inside the scroll
	 * region — i.e. takeovers and editor-replacement dialogs. Left-press and
	 * motion (hover) events arrive with component-relative rows.
	 *
	 * May return `false` to signal the event changed nothing visual, letting
	 * the TUI skip the re-render — motion events fire once per pointer cell,
	 * so hover handlers should return false whenever the hover target (and
	 * therefore the render output) is unchanged. Any other return value
	 * (including undefined) schedules a render.
	 *
	 * When the component declares {@link hitZones}, presses inside a zone and
	 * hover tracking are dispatched to {@link onHitZone} / {@link
	 * setHoveredZone} instead; this handler still receives wheel events and
	 * presses that land outside every zone.
	 */
	handleMouse?(event: MouseEvent): void | boolean;

	/**
	 * Optional predicate consulted before mouse events are forwarded to
	 * {@link handleMouse}. Return false to decline the event (it falls back
	 * to the default transcript scroll). When absent, a component with
	 * `handleMouse` accepts everything.
	 */
	wantsMouseEvent?(event: MouseEvent): boolean;

	/**
	 * Optional declaration of the component's interactive regions (fullscreen
	 * mode only), in the same coordinate space as translated mouse events —
	 * row 0-based from the component's first rendered line, col 1-based from
	 * its first content cell. When present, the TUI hit-tests zones before
	 * the raw {@link handleMouse} path: a left-press inside an `action` zone
	 * goes to {@link onHitZone} (presses outside all zones still fall back to
	 * `handleMouse`), and pointer motion across `hover` zones is reported via
	 * {@link setHoveredZone} instead of `handleMouse`. Zones must derive from
	 * the same state {@link render} reads (caching them as a render
	 * by-product is fine — a render always runs before input is dispatched).
	 * A container that does not implement this composes its children's zones
	 * instead. See hit-zones.ts.
	 */
	hitZones?(): Iterable<HitZone>;

	/**
	 * Called when a left-press lands in one of this component's declared
	 * zones. The event is re-translated into this component's own frame when
	 * the zone was composed through containers. The return-value convention
	 * matches {@link handleMouse}: `false` skips the re-render.
	 */
	onHitZone?(id: HitZoneId, event: MouseEvent): void | boolean;

	/**
	 * Called when the hovered zone of this component changes — `null` when
	 * the pointer left all of its zones. The component should record the id
	 * and reflect it in its next render (e.g. a hover underline). The
	 * return-value convention matches {@link handleMouse}: `false` skips the
	 * re-render.
	 */
	setHoveredZone?(id: HitZoneId | null): void | boolean;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;
}

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;
type PendingOsc11BackgroundQuery = {
	settled: boolean;
	resolve: ((rgb: RgbColor | undefined) => void) | undefined;
	timer: NodeJS.Timeout | undefined;
};

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
}

/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1]!)) / 100);
	}
	return undefined;
}

function isTermuxSession(): boolean {
	return Boolean(process.env['TERMUX_VERSION']);
}

/**
 * Built-in scroll-badge look: bright-white text on a neutral gray fill, the
 * fill lifting one shade while the pointer hovers the badge. Apps re-theme
 * via {@link TUI.setScrollIndicatorStyle}.
 */
function defaultScrollIndicatorBadgeStyle(text: string, hovered: boolean): string {
	return `\x1b[97;48;5;${hovered ? 244 : 240}m${text}\x1b[39;49m`;
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	width?: SizeValue;
	/** Minimum width in columns */
	minWidth?: number;
	/** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
	maxHeight?: SizeValue;

	// === Positioning - anchor-based ===
	/** Anchor point for positioning (default: 'center') */
	anchor?: OverlayAnchor;
	/** Horizontal offset from anchor position (positive = right) */
	offsetX?: number;
	/** Vertical offset from anchor position (positive = down) */
	offsetY?: number;

	// === Positioning - percentage or absolute ===
	/** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
	row?: SizeValue;
	/** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
	col?: SizeValue;

	// === Margin from terminal edges ===
	/** Margin from terminal edges. Number applies to all sides. */
	margin?: OverlayMargin | number;

	// === Visibility ===
	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
	/** If true, don't capture keyboard focus when shown */
	nonCapturing?: boolean;
}

/** Options for {@link OverlayHandle.unfocus}. */
export interface OverlayUnfocusOptions {
	/** Explicit target to focus after releasing this overlay. */
	target: Component | null;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
	/** Permanently remove the overlay (cannot be shown again) */
	hide(): void;
	/** Temporarily hide or show the overlay */
	setHidden(hidden: boolean): void;
	/** Check if overlay is temporarily hidden */
	isHidden(): boolean;
	/** Focus this overlay and bring it to the visual front */
	focus(): void;
	/** Release focus to the next visible capturing overlay or previous target, or to an explicit target when provided */
	unfocus(options?: OverlayUnfocusOptions): void;
	/** Check if this overlay currently has focus */
	isFocused(): boolean;
}

type OverlayStackEntry = {
	component: Component;
	options?: OverlayOptions;
	preFocus: Component | null;
	hidden: boolean;
	focusOrder: number;
	/**
	 * Screen rect (0-based rows/cols) the overlay occupied in the last composed
	 * frame, null while the overlay is hidden or no frame has been composed yet.
	 * Fullscreen mouse dispatch translates event coordinates through this rect.
	 */
	lastRect: { row: number; col: number; width: number; height: number } | null;
};

type OverlayBlockedFocusResume = { status: "restore-overlay" } | { status: "focus-target"; target: Component | null };
type EligibleOverlayFocusRestoreState = { status: "eligible"; overlay: OverlayStackEntry };
type BlockedOverlayFocusRestoreState = {
	status: "blocked";
	overlay: OverlayStackEntry;
	blockedBy: Component;
	resume: OverlayBlockedFocusResume;
};
type ActiveOverlayFocusRestoreState = EligibleOverlayFocusRestoreState | BlockedOverlayFocusRestoreState;
type OverlayFocusRestoreState = { status: "inactive" } | ActiveOverlayFocusRestoreState;
type OverlayFocusRestorePolicy = "clear" | "preserve";

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	children: Component[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	/**
	 * Rows of container chrome rendered before {@link child} beyond the
	 * preceding siblings' heights (e.g. an editor-slot separator row). Used by
	 * the TUI's mouse row translation; containers that paint extra rows above a
	 * child override this.
	 */
	rowsBeforeChild(_child: Component): number {
		return 0;
	}

	/**
	 * Columns of left inset this container prefixes onto every rendered line
	 * (e.g. a chrome gutter aligning children with the input box). Used by the
	 * TUI's mouse column translation; containers that paint a left gutter
	 * override this.
	 */
	leftInset(): number {
		return 0;
	}

	/**
	 * Columns of right inset this container reserves after every rendered
	 * line (e.g. a chrome gutter mirroring the left one). Used together with
	 * {@link leftInset} by the TUI's transcript hit-test walk to compute the
	 * width children actually render at; containers that reserve right
	 * columns override this.
	 */
	rightInset(): number {
		return 0;
	}

	render(width: number): string[] {
		// Extremely narrow terminals can report tiny or even non-positive
		// column counts; never propagate a width below 1 into components.
		width = Math.max(1, width);
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(width);
			for (const line of childLines) {
				lines.push(line);
			}
		}
		return lines;
	}
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	public terminal: Terminal;
	private previousLines: string[] = [];
	/**
	 * Raw (pre-processing) lines of the previous frame, aligned with
	 * {@link previousLines}. Component render caches return identical string
	 * references for unchanged content, which lets each frame reuse the
	 * processed output for every untouched line instead of re-normalizing and
	 * re-comparing the whole transcript (see doRender).
	 */
	private previousRawLines: string[] = [];
	/** Per-line kitty image ids of the previous frame, aligned with previousRawLines. */
	private previousLineImageIds: ReadonlyArray<number>[] = [];
	/**
	 * Fullscreen counterparts of previousRawLines/previousLineImageIds: the
	 * composed frame (post cursor-marker extraction, pre width-check/reset)
	 * of the last doFullscreenRender, aligned with previousLines.
	 */
	private previousRawFrameLines: string[] = [];
	private previousFrameLineImageIds: ReadonlyArray<number>[] = [];
	/**
	 * Monotonic counter bumped by every completed render. Component layout
	 * can only change between renders (any mutation that affects layout
	 * requests a render), so the mouse-motion dedupe can trust its cached
	 * row translation while this and the render-request flag are unchanged.
	 */
	private renderEpoch = 0;
	private previousKittyImageIds = new Set<number>();
	private previousWidth = 0;
	private previousHeight = 0;
	private focusedComponent: Component | null = null;
	/** Dedupe key of the last forwarded motion event (cell + focus identity). */
	private lastMotionKey: string | null = null;
	/**
	 * Raw-cell motion dedupe: skips the row-translation hit-walk entirely
	 * when the pointer cell is unchanged AND layout cannot have changed
	 * (same renderEpoch, no pending render request). The translated
	 * row/col key is a pure function of the raw cell and the layout, so
	 * this is exactly equivalent to the lastMotionKey check below it.
	 */
	private lastMotionRawKey: string | null = null;
	private lastMotionRawEpoch = -1;
	/**
	 * The zone the pointer currently hovers, as (declaring component, zone
	 * id); null when it is over no hover zone. Tracked centrally for
	 * zone-declaring components — {@link Component.setHoveredZone} is only
	 * called when this pair changes, mirroring the per-cell motion dedupe of
	 * the legacy hover path.
	 */
	private lastHoveredZone: { owner: Component; id: HitZoneId } | null = null;
	/**
	 * The transcript-content zone the pointer currently hovers, as (declaring
	 * component, zone id); null when it is over no transcript hover zone.
	 * Tracked separately from {@link lastHoveredZone}: transcript children
	 * never take focus, so their hover is managed by the scroll-region
	 * routing rather than the focused-component path.
	 */
	private lastTranscriptHoveredZone: { owner: Component; id: HitZoneId } | null = null;
	private inputListeners = new Set<InputListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	public onDebug?: () => void;
	private renderRequested = false;
	private renderTimer: NodeJS.Timeout | undefined;
	private lastRenderAt = 0;
	private collapseRenderRequested = false;
	private static readonly MIN_RENDER_INTERVAL_MS = 16;
	private cursorRow = 0; // Logical cursor row (end of rendered content)
	private hardwareCursorRow = 0; // Actual terminal cursor row (may differ due to IME positioning)
	private showHardwareCursor = process.env['PI_HARDWARE_CURSOR'] === "1";
	private clearOnShrink = process.env['PI_CLEAR_ON_SHRINK'] === "1"; // Clear empty rows when content shrinks (default: off)
	private maxLinesRendered = 0; // Track terminal's working area (max lines ever rendered)
	private previousViewportTop = 0; // Track previous viewport top for resize-aware cursor moves
	private fullRedrawCount = 0;
	// Starts true: renders are only allowed after start() (pre-start renders
	// would leak frames into the normal buffer, and in fullscreen the first
	// alt-screen frame must be a fresh full repaint anyway).
	private stopped = true;
	// Explicit "terminal mode is live" flag for setFullscreen's live-switch
	// (previousWidth was a wrong proxy during the pre-first-frame window).
	private started = false;

	// === Fullscreen (alternate screen + bottom slot) mode ===
	// When enabled, the TUI renders an exactly `rows`-line frame each render:
	// a scrollable transcript viewport pinned above a fixed bottom slot.
	private fullscreen = false;
	private layoutRegions: { scroll?: Component; slot?: Component } = {};
	private scrollTop = 0; // First transcript line shown at the top of the viewport
	private followOutput = true; // Stick to the bottom when new content arrives
	private lastScrollRegionLineCount = 0; // From the last composed frame (for scroll clamping)
	private lastViewportHeight = 0;
	/**
	 * Transcript row geometry: caches each scroll-region child's rendered line
	 * count (keyed on layout width) so line → child lookups are O(log n) and
	 * steady frames materialize only the viewport window instead of rendering
	 * and concatenating the whole transcript.
	 */
	private transcriptIndex = new TranscriptRowIndex();
	/**
	 * Gutter-prefixed line blocks keyed on the rendered lines array identity
	 * (unchanged children return identical references from their render
	 * caches), so a steady frame never re-prefixes a child that did not
	 * change. WeakMap: superseded renders are collected with their lines.
	 */
	private transcriptPrefixCache = new WeakMap<string[], { lead: string; block: string[] }>();
	/**
	 * Latched by every public render request (a component mutation may be
	 * pending) and cleared by the first compose that revalidates the row
	 * index. TUI-internal chrome repaints (scroll position, scrollbar/badge
	 * hover) go through {@link requestChromeRender} and leave the latch alone:
	 * they cannot mutate transcript content, so the cached geometry stays
	 * exact for those frames and the compose skips the full revalidation.
	 */
	private transcriptDirty = true;
	/**
	 * Rows clipped off the slot's top in the last composed frame (the slot is
	 * taller than the screen and keeps its bottom). Mouse row translation from
	 * the visible slot top into the slot's (unclipped) rendered output must add
	 * this back.
	 */
	private lastSlotClipRows = 0;
	private scrollIndicatorLabel: ((hiddenLines: number) => string) | null = null;
	private scrollIndicatorVisible = false;
	/** Visible width of the drawn scroll badge — clicks only count on the badge. */
	private scrollIndicatorBadgeWidth = 0;
	/**
	 * Style hook for the scroll badge: receives the space-padded label and the
	 * hover state, returns the label wrapped in ANSI styling. Null selects the
	 * built-in white-on-gray default ({@link defaultScrollIndicatorBadgeStyle}).
	 */
	private scrollIndicatorStyle: ((text: string, hovered: boolean) => string) | null = null;
	/** Whether the pointer hovers the badge's click rect (drives the hover shade). */
	private scrollIndicatorHovered = false;
	/**
	 * Style hook for the transcript scrollbar glyphs. Null selects the built-in
	 * unstyled default (plain ░/█). The bar itself is hover-revealed chrome on
	 * the viewport's rightmost column — see composeFullscreenFrame.
	 */
	private scrollbarStyle: ScrollbarStyle | null = null;
	/** Pointer over the transcript scrollbar column (viewport's last column). */
	private transcriptScrollbarHover = false;
	/** A press on the transcript scrollbar started a drag; motion re-maps the
	 *  pointer row until the release arrives (a thumb grab tracks 1:1, a track
	 *  press keeps the absolute fraction mapping). */
	private transcriptScrollbarDrag = false;
	/** Rows from the thumb's top edge the press grabbed it at; null for a
	 *  track press (the drag then keeps the absolute fraction mapping). */
	private transcriptScrollbarGrabOffset: number | null = null;
	/** Supplies the one-line sticky prompt header (already styled, width-padded
	 *  by the app). Drawn over the viewport's top row while scrolled up. The
	 *  optional jumpTo is the transcript line the header click scrolls to. */
	private stickyHeaderContent:
		| ((width: number, scrollTop: number, viewportHeight: number) => {
				line: string;
				jumpTo?: number;
		  } | null)
		| null = null;
	private stickyHeaderVisible = false;
	private stickyJumpTo: number | null = null;
	private pendingOsc11BackgroundReplies = 0;
	private pendingOsc11BackgroundQueries: PendingOsc11BackgroundQuery[] = [];
	private terminalColorSchemeListeners = new Set<(scheme: TerminalColorScheme) => void>();
	private terminalColorSchemeNotificationsEnabled = false;

	// Overlay stack for modal components rendered on top of base content
	private focusOrderCounter = 0;
	private overlayStack: OverlayStackEntry[] = [];
	private overlayFocusRestore: OverlayFocusRestoreState = { status: "inactive" };

	constructor(terminal: Terminal, showHardwareCursor?: boolean) {
		super();
		this.terminal = terminal;
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	getShowHardwareCursor(): boolean {
		return this.showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.terminal.hideCursor();
		}
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/**
	 * Set whether to trigger full re-render when content shrinks.
	 * When true (default), empty rows are cleared when content shrinks.
	 * When false, empty rows remain (reduces redraws on slower terminals).
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	// === Fullscreen mode API ===

	getFullscreen(): boolean {
		return this.fullscreen;
	}

	/**
	 * Switch between legacy inline rendering (content flows into the terminal's
	 * native scrollback) and fullscreen rendering (alternate screen, fixed
	 * bottom slot, in-app scrolling). Safe to call before or after start().
	 */
	setFullscreen(enabled: boolean): void {
		if (this.fullscreen === enabled) return;
		this.fullscreen = enabled;
		this.scrollTop = 0;
		this.followOutput = true;
		this.transcriptScrollbarHover = false;
		this.transcriptScrollbarDrag = false;
		this.transcriptScrollbarGrabOffset = null;
		this.transcriptIndex.reset();
		this.clearTranscriptZoneHover();
		if (this.started) {
			// Already running: switch the terminal mode live.
			if (enabled) {
				this.terminal.enterAltScreen();
				this.terminal.setMouseReporting(true);
			} else {
				this.terminal.setMouseReporting(false);
				this.terminal.exitAltScreen();
			}
		}
		this.requestRender(true);
	}

	/**
	 * Register the scrollable region (transcript) and the fixed bottom slot.
	 * Both must remain mounted in the children tree; when they are not (e.g.
	 * a fullscreen takeover swapped the children), rendering falls back to a
	 * plain top-aligned full-screen frame.
	 *
	 * When the scroll region is a Container, the fullscreen composer renders
	 * it through the row index: children are laid out at the terminal width
	 * minus the container's {@link Container.leftInset}/{@link
	 * Container.rightInset} and each line carries the left-inset gutter — the
	 * layout a gutter-style transcript container produces itself. Containers
	 * with per-child chrome rows (rowsBeforeChild) stay on the legacy
	 * whole-render path.
	 */
	setLayoutRegions(regions: { scroll?: Component; slot?: Component }): void {
		this.layoutRegions = regions;
		this.transcriptIndex.reset();
		this.requestRender();
	}

	/** Scroll the viewport by `lines` (positive = towards newer content). */
	scrollBy(lines: number): void {
		if (!this.fullscreen || lines === 0) return;
		const maxScroll = Math.max(0, this.lastScrollRegionLineCount - this.lastViewportHeight);
		const next = Math.max(0, Math.min(this.scrollTop + lines, maxScroll));
		if (next !== this.scrollTop) this.clearTranscriptZoneHover();
		this.scrollTop = next;
		this.followOutput = this.scrollTop >= maxScroll;
		this.requestChromeRender();
	}

	/** Page-scroll the viewport (positive = down). */
	scrollPage(direction: number): void {
		const page = Math.max(1, this.lastViewportHeight - 1);
		this.scrollBy(direction * page);
	}

	scrollToBottom(): void {
		if (!this.fullscreen) return;
		this.followOutput = true;
		this.requestChromeRender();
	}

	/** Jump to the oldest transcript line; leaves follow mode (unless the
	 *  transcript fits the viewport, where top and bottom coincide). */
	scrollToTop(): void {
		if (!this.fullscreen) return;
		this.clearTranscriptZoneHover();
		this.scrollTop = 0;
		const maxScroll = Math.max(0, this.lastScrollRegionLineCount - this.lastViewportHeight);
		this.followOutput = this.scrollTop >= maxScroll;
		this.requestChromeRender();
	}

	isFollowingOutput(): boolean {
		return this.followOutput;
	}

	/** Localizable badge shown at the viewport's bottom-right while scrolled up. */
	setScrollIndicatorLabel(label: ((hiddenLines: number) => string) | null): void {
		this.scrollIndicatorLabel = label;
	}

	/**
	 * Re-theme the scroll badge. The hook receives the space-padded label and
	 * whether the pointer hovers the badge's click rect, and returns the label
	 * with ANSI styling applied. Pass null to restore the built-in default.
	 */
	setScrollIndicatorStyle(style: ((text: string, hovered: boolean) => string) | null): void {
		this.scrollIndicatorStyle = style;
	}

	/**
	 * Re-theme the transcript scrollbar glyphs (track/thumb). Pass null to
	 * restore the built-in unstyled default. The bar is the hover-revealed
	 * overlay on the viewport's rightmost column: a press jumps to the pointed
	 * fraction of the transcript and a drag scrolls continuously.
	 */
	setScrollbarStyle(style: ScrollbarStyle | null): void {
		this.scrollbarStyle = style;
	}

	/**
	 * Set the sticky prompt header provider (Claude Code style): while the user
	 * is scrolled up into history, the returned line is drawn over the
	 * viewport's top row; a left-click on that row scrolls to `jumpTo` (or back
	 * to the bottom when omitted). The provider receives the frame width plus
	 * the current scroll position so it can anchor the header to the message
	 * currently in view.
	 */
	setStickyHeaderContent(
		provider:
			| ((width: number, scrollTop: number, viewportHeight: number) => {
					line: string;
					jumpTo?: number;
			  } | null)
			| null,
	): void {
		this.stickyHeaderContent = provider;
	}

	/** Whether the sticky header is currently drawn (scrolled up + content). */
	isStickyHeaderVisible(): boolean {
		return this.stickyHeaderVisible;
	}

	setFocus(component: Component | null): void {
		this.setFocusInternal({ component, overlayFocusRestore: "clear" });
	}

	private setFocusInternal({
		component,
		overlayFocusRestore,
	}: {
		component: Component | null;
		overlayFocusRestore: OverlayFocusRestorePolicy;
	}): void {
		const previousFocus = this.focusedComponent;
		let nextFocus = component;
		const previousFocusedOverlay = previousFocus
			? this.overlayStack.find((entry) => entry.component === previousFocus && this.isOverlayVisible(entry))
			: undefined;
		const nextFocusIsOverlay = nextFocus ? this.overlayStack.some((entry) => entry.component === nextFocus) : false;
		const restoreState = this.getVisibleOverlayFocusRestore();
		if (nextFocus && !nextFocusIsOverlay) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				if (restoreState.resume.status === "focus-target" || !this.isComponentMounted(restoreState.blockedBy)) {
					nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
				} else {
					this.overlayFocusRestore = {
						status: "blocked",
						overlay: restoreState.overlay,
						blockedBy: nextFocus,
						resume: restoreState.resume,
					};
				}
			} else if (
				previousFocusedOverlay &&
				restoreState.status !== "inactive" &&
				restoreState.overlay === previousFocusedOverlay &&
				!this.isOverlayFocusAncestor(previousFocusedOverlay, nextFocus)
			) {
				this.overlayFocusRestore = {
					status: "blocked",
					overlay: previousFocusedOverlay,
					blockedBy: nextFocus,
					resume: { status: "restore-overlay" },
				};
			}
		} else if (nextFocus === null) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
			} else if (overlayFocusRestore === "clear") {
				this.clearOverlayFocusRestore();
			}
		}

		if (isFocusable(this.focusedComponent)) {
			this.focusedComponent.focused = false;
		}

		this.focusedComponent = nextFocus;
		// A focus change invalidates the motion dedupe key: the pointer cell is
		// unchanged but the hover target under it is, so the next motion event
		// must reach the newly focused component even in the same cell.
		this.lastMotionKey = null;
		this.lastMotionRawKey = null;
		// Zone hover belongs to the previously focused subtree; when focus
		// moves outside it, clear the hover so the old owner drops its hover
		// affordance instead of rendering it stale.
		const hoveredZone = this.lastHoveredZone;
		if (
			hoveredZone !== null &&
			(nextFocus === null || !this.containsComponent(nextFocus, hoveredZone.owner))
		) {
			this.lastHoveredZone = null;
			hoveredZone.owner.setHoveredZone?.(null);
		}

		if (isFocusable(nextFocus)) {
			nextFocus.focused = true;
		}

		const focusedOverlay = nextFocus
			? this.overlayStack.find((entry) => entry.component === nextFocus && this.isOverlayVisible(entry))
			: undefined;
		if (focusedOverlay) {
			this.overlayFocusRestore = { status: "eligible", overlay: focusedOverlay };
		}
	}

	private clearOverlayFocusRestore(): void {
		this.overlayFocusRestore = { status: "inactive" };
	}

	private clearOverlayFocusRestoreFor(overlay: OverlayStackEntry): void {
		if (this.overlayFocusRestore.status !== "inactive" && this.overlayFocusRestore.overlay === overlay) {
			this.clearOverlayFocusRestore();
		}
	}

	private resolveBlockedOverlayFocusResume(restoreState: BlockedOverlayFocusRestoreState): Component | null {
		if (restoreState.resume.status === "restore-overlay") return restoreState.overlay.component;
		this.clearOverlayFocusRestore();
		return restoreState.resume.target;
	}

	private getVisibleOverlayFocusRestore(): OverlayFocusRestoreState {
		const restoreState = this.overlayFocusRestore;
		if (restoreState.status === "inactive") return restoreState;
		if (!this.overlayStack.includes(restoreState.overlay) || !this.isOverlayVisible(restoreState.overlay)) {
			return { status: "inactive" };
		}
		return restoreState;
	}

	private isOverlayFocusAncestor(entry: OverlayStackEntry, component: Component): boolean {
		const visited = new Set<Component>();
		let current = entry.preFocus;
		while (current && !visited.has(current)) {
			visited.add(current);
			if (current === component) return true;
			current = this.overlayStack.find((overlay) => overlay.component === current)?.preFocus ?? null;
		}
		return false;
	}

	private retargetOverlayPreFocus(removed: OverlayStackEntry): void {
		for (const overlay of this.overlayStack) {
			if (overlay !== removed && overlay.preFocus === removed.component) {
				overlay.preFocus = removed.preFocus;
			}
		}
	}

	private isComponentMounted(component: Component): boolean {
		return this.children.some((child) => this.containsComponent(child, component));
	}

	private containsComponent(root: Component, target: Component): boolean {
		if (root === target) return true;
		if (!(root instanceof Container)) return false;
		return root.children.some((child) => this.containsComponent(child, target));
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry: OverlayStackEntry = {
			component,
			...(options === undefined ? {} : { options }),
			preFocus: this.focusedComponent,
			hidden: false,
			focusOrder: ++this.focusOrderCounter,
			lastRect: null,
		};
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.clearOverlayFocusRestoreFor(entry);
					this.retargetOverlayPreFocus(entry);
					this.overlayStack.splice(index, 1);
					// Restore focus if this overlay had focus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.terminal.hideCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					this.clearOverlayFocusRestoreFor(entry);
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
						entry.focusOrder = ++this.focusOrderCounter;
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
			focus: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry)) return;
				entry.focusOrder = ++this.focusOrderCounter;
				this.setFocus(component);
				this.requestRender();
			},
			unfocus: (unfocusOptions) => {
				const isFocused = this.focusedComponent === component;
				const restoreState = this.overlayFocusRestore;
				const hasPendingRestore = restoreState.status !== "inactive" && restoreState.overlay === entry;
				if (!isFocused && !hasPendingRestore) return;
				if (
					restoreState.status === "blocked" &&
					restoreState.overlay === entry &&
					this.focusedComponent === restoreState.blockedBy
				) {
					if (unfocusOptions) {
						this.overlayFocusRestore = {
							status: "blocked",
							overlay: entry,
							blockedBy: restoreState.blockedBy,
							resume: { status: "focus-target", target: unfocusOptions.target },
						};
					} else {
						this.clearOverlayFocusRestore();
					}
					this.requestRender();
					return;
				}
				this.clearOverlayFocusRestoreFor(entry);
				if (isFocused || unfocusOptions) {
					const topVisible = this.getTopmostVisibleOverlay();
					const fallbackTarget = topVisible && topVisible !== entry ? topVisible.component : entry.preFocus;
					this.setFocus(unfocusOptions ? unfocusOptions.target : fallbackTarget);
				}
				this.requestRender();
			},
			isFocused: () => this.focusedComponent === component,
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		const overlay = this.overlayStack[this.overlayStack.length - 1];
		if (!overlay) return;
		this.clearOverlayFocusRestoreFor(overlay);
		this.retargetOverlayPreFocus(overlay);
		this.overlayStack.pop();
		if (this.focusedComponent === overlay.component) {
			// Find topmost visible overlay, or fall back to preFocus
			const topVisible = this.getTopmostVisibleOverlay();
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		if (this.overlayStack.length === 0) this.terminal.hideCursor();
		this.requestRender();
	}

	/** Check if there are any visible overlays */
	hasOverlay(): boolean {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	/** Check if an overlay entry is currently visible */
	private isOverlayVisible(entry: OverlayStackEntry): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Find the visual-frontmost visible capturing overlay, if any */
	private getTopmostVisibleOverlay(): OverlayStackEntry | undefined {
		let topmost: OverlayStackEntry | undefined;
		for (const overlay of this.overlayStack) {
			if (overlay.options?.nonCapturing || !this.isOverlayVisible(overlay)) continue;
			if (!topmost || overlay.focusOrder > topmost.focusOrder) {
				topmost = overlay;
			}
		}
		return topmost;
	}

	override invalidate(): void {
		// Tree-wide dirty (theme switch): every child's cached lines carry stale
		// styling, so the transcript geometry must be rebuilt from scratch too.
		this.transcriptIndex.reset();
		this.transcriptDirty = true;
		super.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
	}

	start(): void {
		this.stopped = false;
		this.started = true;
		this.terminal.start(
			(data) => this.handleInput(data),
			() => this.requestRender(),
		);
		if (this.fullscreen) {
			this.terminal.enterAltScreen();
			this.terminal.setMouseReporting(true);
		}
		this.terminal.hideCursor();
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.terminal.write("\x1b[?2031h");
		}
		this.queryCellSize();
		// Fullscreen always opens on a fresh alternate buffer — force a full
		// repaint instead of diffing against whatever previousLines holds
		// (also covers stop→start cycles, whose buffer is new as well).
		this.requestRender(this.fullscreen);
	}

	addInputListener(listener: InputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: InputListener): void {
		this.inputListeners.delete(listener);
	}

	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void {
		this.terminalColorSchemeListeners.add(listener);
		return () => {
			this.terminalColorSchemeListeners.delete(listener);
		};
	}

	setTerminalColorSchemeNotifications(enabled: boolean): void {
		if (this.terminalColorSchemeNotificationsEnabled === enabled) {
			return;
		}
		this.terminalColorSchemeNotificationsEnabled = enabled;
		if (!this.stopped) {
			this.terminal.write(enabled ? "\x1b[?2031h" : "\x1b[?2031l");
		}
	}

	private queryCellSize(): void {
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!getCapabilities().images) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.terminal.write("\x1b[16t");
	}

	stop(): void {
		this.stopped = true;
		this.started = false;
		// Drop any pending render so a later start() cannot find the queue
		// permanently blocked behind a stale renderRequested flag.
		this.renderRequested = false;
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.terminal.write("\x1b[?2031l");
		}
		if (this.fullscreen) {
			// The alternate buffer is discarded wholesale on exit; no need to
			// reposition the cursor to the end of the content first. Placed
			// kitty images, however, survive buffer switches — delete them or
			// they accumulate in terminal memory across sessions.
			this.terminal.write(this.deleteKittyImages(this.previousKittyImageIds));
			this.previousKittyImageIds = new Set();
			this.terminal.setMouseReporting(false);
			this.terminal.exitAltScreen();
			this.terminal.showCursor();
			this.terminal.stop();
			return;
		}
		// Move cursor to the end of the content to prevent overwriting/artifacts on exit
		if (this.previousLines.length > 0) {
			const targetRow = this.previousLines.length; // Line after the last content
			const lineDiff = targetRow - this.hardwareCursorRow;
			if (lineDiff > 0) {
				this.terminal.write(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A`);
			}
			this.terminal.write("\r\n");
		}

		this.terminal.showCursor();
		this.terminal.stop();
	}

	requestRender(force = false): void {
		// Latch before the early return: a mutation may be pending even when a
		// render is already scheduled, and the next fullscreen compose must
		// revalidate the transcript row index for it.
		this.transcriptDirty = true;
		if (force) {
			this.previousLines = [];
			this.previousWidth = -1; // -1 triggers widthChanged, forcing a full clear
			this.previousHeight = -1; // -1 triggers heightChanged, forcing a full clear
			this.cursorRow = 0;
			this.hardwareCursorRow = 0;
			this.maxLinesRendered = 0;
			this.previousViewportTop = 0;
			this.scheduleImmediateRender();
			return;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => this.scheduleRender());
	}

	/**
	 * Schedule a repaint that provably has no transcript mutations behind it —
	 * scroll-position and TUI-chrome (scroll badge/scrollbar) updates only.
	 * The fullscreen composer may trust the row index's cached geometry for
	 * these frames instead of revalidating every child.
	 */
	private requestChromeRender(): void {
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => this.scheduleRender());
	}

	/**
	 * Request a viewport repaint that preserves the terminal's native
	 * scrollback: the visible region is rewritten in place and leftover rows
	 * below the new content are erased with `\x1b[J` — never the `\x1b[3J`
	 * scrollback purge that requestRender(true) performs. Use when tall chrome
	 * is replaced by shorter content (dialog/takeover close) and the session
	 * history scrolled into the native buffer must survive.
	 */
	requestCollapseRender(): void {
		// A public render request: a mutation may be pending, so the next
		// fullscreen compose must revalidate the transcript row index.
		this.transcriptDirty = true;
		this.collapseRenderRequested = true;
		this.scheduleImmediateRender();
	}

	private scheduleImmediateRender(): void {
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		this.renderRequested = true;
		process.nextTick(() => {
			if (this.stopped || !this.renderRequested) {
				return;
			}
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
		});
	}

	private scheduleRender(): void {
		if (this.stopped || this.renderTimer || !this.renderRequested) {
			return;
		}
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, TUI.MIN_RENDER_INTERVAL_MS - elapsed);
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (this.stopped || !this.renderRequested) {
				return;
			}
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
			if (this.renderRequested) {
				this.scheduleRender();
			}
		}, delay);
	}

	// Parse an SGR mouse event: \x1b[<button;col;row[M=press|m=release].
	// Button bit 32 marks motion (any-motion tracking, mode 1003); it is
	// stripped from the reported button so held-button drags and plain hovers
	// share the 'motion' type.
	private static parseMouseEvent(data: string): MouseEvent | null {
		const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
		if (!match) return null;
		const rawButton = Number.parseInt(match[1]!, 10);
		const isMotion = (rawButton & 32) !== 0;
		const button = isMotion ? rawButton & ~32 : rawButton;
		const isWheel = button === 64 || button === 65;
		return {
			type: isMotion
				? 'motion'
				: isWheel && match[4] === 'M'
					? 'wheel'
					: isWheel
						? 'release'
						: match[4] === 'M'
							? 'press'
							: 'release',
			button,
			col: Number.parseInt(match[2]!, 10),
			row: Number.parseInt(match[3]!, 10),
			slotRelative: false,
		};
	}

	/**
	 * Row offset of `descendant`'s first rendered line within `ancestor`'s
	 * rendered output (0-based), via each container's rendered child heights and
	 * its {@link Container.rowsBeforeChild} chrome. Press events are one-shot, so
	 * measuring heights on demand is fine — this never runs per frame.
	 */
	private rowOffsetWithin(ancestor: Component, descendant: Component): number | null {
		if (ancestor === descendant) return 0;
		if (!(ancestor instanceof Container)) return null;
		const width = Math.max(1, this.terminal.columns);
		let acc = 0;
		for (const child of ancestor.children) {
			const base = acc + ancestor.rowsBeforeChild(child);
			if (child === descendant) return base;
			const inner = this.rowOffsetWithin(child, descendant);
			if (inner !== null) return base + inner;
			acc += child.render(width).length;
		}
		return null;
	}

	/**
	 * Accumulated left inset between `ancestor`'s rendered lines and
	 * `descendant`'s content: the sum of {@link Container.leftInset} over the
	 * containers on the path (a gutter-prefixed line shifts every child column
	 * right by the gutter). Returns null when descendant is not under ancestor.
	 */
	private colInsetWithin(ancestor: Component, descendant: Component): number | null {
		if (ancestor === descendant) return 0;
		if (!(ancestor instanceof Container)) return null;
		for (const child of ancestor.children) {
			if (child === descendant) return ancestor.leftInset();
			const inner = this.colInsetWithin(child, descendant);
			if (inner !== null) return ancestor.leftInset() + inner;
		}
		return null;
	}

	/** The visible overlay whose component subtree contains `component`, if any. */
	private visibleOverlayEntryFor(component: Component | null): OverlayStackEntry | undefined {
		if (component === null) return undefined;
		for (const entry of this.overlayStack) {
			if (!this.isOverlayVisible(entry)) continue;
			if (this.containsComponent(entry.component, component)) return entry;
		}
		return undefined;
	}

	/**
	 * Whether a mouse event position (1-based row/col) falls inside the rect the
	 * overlay occupied in the last composed frame.
	 */
	private isPointInOverlayRect(entry: OverlayStackEntry, row: number, col: number): boolean {
		const rect = entry.lastRect;
		if (rect === null) return false;
		return row - 1 >= rect.row && row - 1 < rect.row + rect.height && col > rect.col && col <= rect.col + rect.width;
	}

	/**
	 * Wheel hit-test over slot display panels: find the deepest mouse-aware
	 * component under the pointer outside the focused component's subtree and
	 * deliver the event with a component-relative row. Returns true when the
	 * event was consumed. Display panels (btw/todo/queue/notice/swarm) never
	 * take focus, so without this their only scroll path was the transcript.
	 */
	private hoverSlotPanelHit(root: Container, row: number, event: MouseEvent): boolean {
		const width = Math.max(1, this.terminal.columns);
		const focused = this.focusedComponent;
		let acc = 0;
		for (const child of root.children) {
			const base = acc + root.rowsBeforeChild(child);
			const height = child.render(width).length;
			if (row >= base && row < base + height) {
				if (focused !== null && this.containsComponent(child, focused)) return false;
				const inner = this.hoverSlotPanelHitIn(child, row - base, event);
				if (inner !== null) {
					inner.handleMouse(inner.event);
					return true;
				}
				return false;
			}
			acc = base + height;
		}
		return false;
	}

	private hoverSlotPanelHitIn(
		component: Component,
		row: number,
		event: MouseEvent,
	): { handleMouse: (event: MouseEvent) => void; event: MouseEvent } | null {
		if (component instanceof Container) {
			const width = Math.max(1, this.terminal.columns);
			let acc = 0;
			for (const child of component.children) {
				const base = acc + component.rowsBeforeChild(child);
				const height = child.render(width).length;
				if (row >= base && row < base + height) {
					return this.hoverSlotPanelHitIn(child, row - base, event);
				}
				acc = base + height;
			}
			return null;
		}
		if (component.handleMouse === undefined) return null;
		const translated: MouseEvent = { ...event, row, slotRelative: true };
		if (!(component.wantsMouseEvent?.(translated) ?? true)) return null;
		return { handleMouse: (e: MouseEvent) => component.handleMouse?.(e), event: translated };
	}

	/**
	 * Press counterpart of {@link hoverSlotPanelHit}: find the slot child under
	 * the pointer outside the focused component's subtree and hit-test the hit
	 * zones composed within it. A press inside an `action` zone is dispatched
	 * to the zone owner's onHitZone (event re-translated into the owner's
	 * frame, same as the focused path). Returns true when the event was
	 * consumed. Display chrome (footer) never takes focus, so without this its
	 * declared zones would be unreachable.
	 */
	private slotPanelZonePress(root: Container, row: number, event: MouseEvent): boolean {
		const width = Math.max(1, this.terminal.columns);
		const focused = this.focusedComponent;
		// Render-free pre-check: the height walk below renders each child, so
		// bail before paying for it when no child outside the focused subtree
		// declares zones at all (the common case — chrome without zones).
		if (
			!root.children.some(
				(child) => !(focused !== null && this.containsComponent(child, focused)) && hasHitZones(child),
			)
		) {
			return false;
		}
		let acc = 0;
		for (const child of root.children) {
			const base = acc + root.rowsBeforeChild(child);
			const height = child.render(width).length;
			if (row >= base && row < base + height) {
				if (focused !== null && this.containsComponent(child, focused)) return false;
				if (!hasHitZones(child)) return false;
				const col = event.col - (this.colInsetWithin(root, child) ?? 0);
				const zone = hitZoneAt(resolveHitZones(child, width), row - base, col, "action");
				if (zone === null) return false;
				if (this.dispatchHitZone(zone, { ...event, row: row - base, col, slotRelative: true }) !== false) {
					this.requestRender();
				}
				return true;
			}
			acc = base + height;
		}
		return false;
	}

	/**
	 * Hit-test the transcript scroll region's children at a viewport row:
	 * `viewportRow` is 0-based from the viewport's top, so the transcript line
	 * under the pointer is `scrollTop + viewportRow`. The line → child lookup
	 * goes through the row index's binary search whenever its cached geometry
	 * is exact (warm index, no mutation latched for the next render); the
	 * fallback is a top-down walk that renders children at the width the
	 * scroll container lays them out (terminal columns minus its gutter
	 * insets) — render caches keep this cheap. Either way only the child that
	 * owns the line gets its zones resolved. The returned event is expressed
	 * in that child's frame, ready for {@link dispatchHitZone}'s owner
	 * re-translation. Returns null when no child — or no zone of the
	 * requested kind — covers the point.
	 */
	private transcriptZoneHit(
		scroll: Container,
		viewportRow: number,
		event: MouseEvent,
		kind: keyof Required<HitZoneSemantics>,
	): { zone: ResolvedHitZone; event: MouseEvent } | null {
		const width = Math.max(1, this.terminal.columns);
		const line = this.scrollTop + viewportRow;
		const colInset = scroll.leftInset();
		const childWidth = Math.max(1, width - colInset - scroll.rightInset());
		if (!this.transcriptDirty && this.transcriptIndex.isWarmFor(scroll, childWidth)) {
			const entry = this.transcriptIndex.locate(line);
			if (entry === null) return null;
			const child = entry.child;
			if (!hasHitZones(child)) return null;
			const translated: MouseEvent = {
				...event,
				row: line - entry.base,
				col: event.col - colInset,
				slotRelative: false,
			};
			const zone = hitZoneAt(resolveHitZones(child, childWidth), translated.row, translated.col, kind);
			return zone === null ? null : { zone, event: translated };
		}
		let acc = 0;
		for (const child of scroll.children) {
			const base = acc + scroll.rowsBeforeChild(child);
			const height = child.render(childWidth).length;
			if (line >= base && line < base + height) {
				if (!hasHitZones(child)) return null;
				const translated: MouseEvent = {
					...event,
					row: line - base,
					col: event.col - colInset,
					slotRelative: false,
				};
				const zone = hitZoneAt(resolveHitZones(child, childWidth), translated.row, translated.col, kind);
				return zone === null ? null : { zone, event: translated };
			}
			acc = base + height;
		}
		return null;
	}

	/**
	 * Whether a 1-based terminal cell counts as transcript content for zone
	 * routing: inside the viewport while the layout regions are mounted, not
	 * the sticky-header overlay row, and not shielded by a visible overlay
	 * (the same rule the transcript scrollbar applies).
	 */
	private isTranscriptContentCell(row: number, col: number): boolean {
		const { scroll, slot } = this.layoutRegions;
		if (
			!(scroll instanceof Container) ||
			slot === undefined ||
			!this.isComponentMounted(scroll) ||
			!this.isComponentMounted(slot)
		) {
			return false;
		}
		if (row < 1 || row > this.lastViewportHeight) return false;
		if (row === 1 && this.stickyHeaderVisible) return false;
		const overlay = this.visibleOverlayEntryFor(this.focusedComponent);
		return overlay === undefined || !this.isPointInOverlayRect(overlay, row, col);
	}

	/**
	 * Route a fullscreen mouse event: wheel over the transcript viewport unless
	 * a mouse-aware focused component outside the scroll region should get it
	 * (hover-to-scroll); left-press drives the transcript scrollbar (rightmost
	 * viewport column: a press on the thumb anchors it to the pointer — grab
	 * delta — a press on the bare track jumps to the pointed fraction; motion
	 * with the button held drags),
	 * the sticky header / scroll badge, and is otherwise forwarded to the
	 * focused component with component-relative coordinates for row/col-hit
	 * handling (click-to-select); releases are forwarded with the press
	 * translation so component drags can end. Press and motion
	 * translation accounts for the slot-top clip (a slot taller than the screen
	 * keeps its bottom) and for container left gutters, so components receive
	 * coordinates in their own rendered frame. When the focused component
	 * declares hit zones, a press inside an action zone is dispatched to the
	 * zone owner's onHitZone instead of handleMouse, and button-free motion
	 * drives the centrally tracked hovered zone (setHoveredZone) rather than
	 * being forwarded; motion with a button held is a drag and goes to
	 * handleMouse instead.
	 */
	private handleFullscreenMouse(event: MouseEvent): void {
		if (event.type === 'wheel') {
			const focused = this.focusedComponent;
			const { scroll, slot } = this.layoutRegions;
			const regionsMounted =
				scroll !== undefined &&
				slot !== undefined &&
				this.isComponentMounted(scroll) &&
				this.isComponentMounted(slot);
			// Focus inside a visible overlay: the dialog owns the wheel only while
			// the pointer hovers its rect (the same hover semantics slot panels
			// have). Outside the rect the wheel keeps its underlay routing, so a
			// display panel covered by the overlay can't be scrolled through it.
			const focusedOverlay = this.visibleOverlayEntryFor(focused);
			if (focusedOverlay !== undefined) {
				const rect = focusedOverlay.lastRect;
				if (rect !== null && this.isPointInOverlayRect(focusedOverlay, event.row, event.col)) {
					if (
						focused?.handleMouse !== undefined &&
						(focused.wantsMouseEvent?.(event) ?? true) &&
						focused.handleMouse({
							...event,
							row: event.row - 1 - rect.row,
							col: event.col - rect.col,
							slotRelative: false,
						}) !== false
					) {
						this.requestRender();
					}
					return;
				}
				if (regionsMounted && event.row > this.lastViewportHeight) {
					const hit =
						slot instanceof Container &&
						this.hoverSlotPanelHit(
							slot,
							event.row - 1 - this.lastViewportHeight + this.lastSlotClipRows,
							event,
						);
					if (hit) {
						this.requestRender();
						return;
					}
				}
				this.scrollBy(event.button === 64 ? -3 : 3);
				return;
			}
			// Hover hit-test over slot display panels (btw/todo/queue/notice/swarm
			// containers, which never take focus): the pointer over one of them
			// scrolls that panel, not the focused component. The editorContainer
			// subtree is excluded — its content is the focused component and is
			// covered by the focused path below.
			if (regionsMounted && event.row > this.lastViewportHeight) {
				const hit =
					slot instanceof Container &&
					this.hoverSlotPanelHit(
						slot,
						event.row - 1 - this.lastViewportHeight + this.lastSlotClipRows,
						event,
					);
				if (hit) {
					this.requestRender();
					return;
				}
			}
			const insideScrollRegion =
				regionsMounted && focused !== null && this.containsComponent(scroll, focused);
			if (
				!insideScrollRegion &&
				focused?.handleMouse !== undefined &&
				(focused.wantsMouseEvent?.(event) ?? true)
			) {
				const insideSlot = regionsMounted && this.containsComponent(slot, focused);
				// True hover semantics: a slot dialog owns the wheel only while the
				// pointer is over the slot itself; over the transcript viewport the
				// wheel keeps scrolling the transcript.
				if (insideSlot && event.row <= this.lastViewportHeight) {
					this.scrollBy(event.button === 64 ? -3 : 3);
					return;
				}
				if (
					focused.handleMouse({
						...event,
						row: insideSlot ? event.row - this.lastViewportHeight : event.row,
						slotRelative: insideSlot,
					}) !== false
				) {
					this.requestRender();
				}
				return;
			}
			this.scrollBy(event.button === 64 ? -3 : 3);
			return;
		}
		// Pointer motion (any-motion tracking, mode 1003): forwarded to the
		// focused mouse-aware component with the same component-relative row/col
		// translation as presses, so hover hit-tests reuse the press math. A
		// translated row of -1 signals the pointer left the component region
		// (hover-clear). Deduped per pointer cell — mode 1003 reports every
		// cell boundary crossed. For zone-declaring components the translation
		// is identical, but the TUI hit-tests the declared zones and tracks the
		// hovered zone centrally (setHoveredZone) instead of forwarding.
		if (event.type === 'motion') {
			// The scroll badge is TUI chrome (not a component), so its hover is
			// tracked here ahead of — and independently of — component routing.
			this.updateScrollIndicatorHover(event);
			// An active transcript-scrollbar drag owns the pointer until the
			// release: the row keeps mapping even off the bar's column (GUI-style
			// capture). A button-free motion without a release defensively ends
			// the drag for terminals that drop them.
			if (this.transcriptScrollbarDrag) {
				if (event.button === 0) {
					if (this.transcriptScrollbarGrabOffset === null) {
						this.scrollTranscriptToTrackRow(event.row - 1);
					} else {
						this.scrollTranscriptToThumbRow(event.row - 1 - this.transcriptScrollbarGrabOffset);
					}
					return;
				}
				this.transcriptScrollbarDrag = false;
				this.transcriptScrollbarGrabOffset = null;
			}
			// The transcript scrollbar is TUI chrome like the badge: its hover
			// reveal is tracked here, ahead of component routing.
			this.updateTranscriptScrollbarHover(event);
			// Cheap pre-dedupe on the raw pointer cell, ahead of every hit-walk
			// below (transcript zone hover and the focused-component row
			// translation): don't pay for either when the answer cannot have
			// changed — same raw cell, no render since (layout frozen), and no
			// render request pending (a mutation may be waiting for one).
			const rawKey = `${event.row}:${event.col}`;
			if (
				rawKey === this.lastMotionRawKey &&
				this.lastMotionRawEpoch === this.renderEpoch &&
				!this.renderRequested
			) {
				return;
			}
			// Transcript content zones (tool cards/groups) likewise track
			// button-free motion ahead of — and independently of — the focused
			// component's own hover routing.
			if (event.button === 3) {
				this.updateTranscriptZoneHover(event);
			}
			const focused = this.focusedComponent;
			if (focused === null) return;
			const zoneAware = hasHitZones(focused);
			if (focused.handleMouse === undefined && !zoneAware) return;
			const { slot } = this.layoutRegions;
			let row: number;
			let col: number;
			const motionOverlay = this.visibleOverlayEntryFor(focused);
			if (motionOverlay !== undefined) {
				// Overlay: translate through its composed rect; outside the rect
				// the pointer reports as row -1 so the dialog clears its hover.
				const rect = motionOverlay.lastRect;
				if (rect === null) return;
				row = this.isPointInOverlayRect(motionOverlay, event.row, event.col)
					? event.row - 1 - rect.row
					: -1;
				col = event.col - rect.col;
			} else if (slot !== undefined && this.containsComponent(slot, focused)) {
				// The slot starts right below the transcript viewport; inside it,
				// container chrome and siblings shift the component down, and a
				// slot taller than the screen is clipped at the top (the visible
				// slot top sits lastSlotClipRows into the slot's rendered
				// output). Container gutters likewise shift the component right.
				const inner = this.rowOffsetWithin(slot, focused);
				if (inner === null) return;
				const slotIndex = event.row - 1 - this.lastViewportHeight + this.lastSlotClipRows;
				row = slotIndex < this.lastSlotClipRows ? -1 : Math.max(slotIndex - inner, -1);
				col = event.col - (this.colInsetWithin(slot, focused) ?? 0);
			} else {
				// Takeover components fill the screen from row 1.
				row = event.row - 1;
				col = event.col - (this.colInsetWithin(this as Container, focused) ?? 0);
			}
			const key = `${row < 0 ? -1 : row}:${col}`;
			if (key === this.lastMotionKey) return;
			this.lastMotionKey = key;
			this.lastMotionRawKey = rawKey;
			this.lastMotionRawEpoch = this.renderEpoch;
			const translated: MouseEvent = {
				...event,
				col,
				row: Math.max(row, -1),
				slotRelative: false,
			};
			if (!(focused.wantsMouseEvent?.(translated) ?? true)) return;
			// A motion with a button held is a drag, not a hover: it goes to the
			// raw handler even when the component declares zones (component
			// scrollbar drags live there). Zones only track button-free motion.
			if (zoneAware && event.button === 3) {
				this.updateZoneHover(focused, row, col);
				return;
			}
			if (focused.handleMouse === undefined) return;
			if (focused.handleMouse(translated) !== false) this.requestRender();
			return;
		}
		// Button release: ends a transcript-scrollbar drag and is forwarded to
		// the focused mouse-aware component with the press translation (no zone
		// dispatch — releases exist so component scrollbars can end their
		// drags). Handlers that only expect wheel/press/motion ignore it.
		if (event.type === 'release') {
			if (this.transcriptScrollbarDrag) {
				this.transcriptScrollbarDrag = false;
				this.transcriptScrollbarGrabOffset = null;
				// The drag path skips hover tracking, so settle the reveal with
				// the release cell (the bar hides when the pointer is off-column).
				this.updateTranscriptScrollbarHover(event);
				this.updateTranscriptZoneHover(event);
			}
			const focused = this.focusedComponent;
			if (focused === null || focused.handleMouse === undefined) return;
			const releaseOverlay = this.visibleOverlayEntryFor(focused);
			const { slot } = this.layoutRegions;
			let row: number;
			let col: number;
			if (releaseOverlay !== undefined) {
				const rect = releaseOverlay.lastRect;
				if (rect === null) return;
				row = this.isPointInOverlayRect(releaseOverlay, event.row, event.col)
					? event.row - 1 - rect.row
					: -1;
				col = event.col - rect.col;
			} else if (slot !== undefined && this.containsComponent(slot, focused)) {
				const inner = this.rowOffsetWithin(slot, focused);
				if (inner === null) return;
				const slotIndex = event.row - 1 - this.lastViewportHeight + this.lastSlotClipRows;
				row = slotIndex < this.lastSlotClipRows ? -1 : Math.max(slotIndex - inner, -1);
				col = event.col - (this.colInsetWithin(slot, focused) ?? 0);
			} else {
				// Takeover components fill the screen from row 1.
				row = event.row - 1;
				col = event.col - (this.colInsetWithin(this as Container, focused) ?? 0);
			}
			const translated: MouseEvent = { ...event, col, row, slotRelative: false };
			if (!(focused.wantsMouseEvent?.(translated) ?? true)) return;
			if (focused.handleMouse(translated) !== false) this.requestRender();
			return;
		}
		// Left-click (press only; rows are 1-based):
		// - the transcript scrollbar's column (rightmost, scrollable viewport)
		//   → start a drag: anchored on the thumb, jumping on the bare track
		// - top row while the sticky header is visible → jump to the
		//   header's message position (or to the bottom when unset)
		// - viewport bottom row while the scroll badge is visible → bottom
		// - anything else → forwarded to the focused mouse-aware component with
		//   the row translated to that component's own frame (0-based), so
		//   dialogs can do row-hit selection without knowing the slot layout
		if (event.type === 'press' && event.button === 0) {
			// A press landing on a visible overlay belongs to it: the covered
			// underlay affordances (sticky header, scroll badge, slot zones)
			// must not fire through it.
			const pressOverlay = this.visibleOverlayEntryFor(this.focusedComponent);
			const overlayHit =
				pressOverlay !== undefined && this.isPointInOverlayRect(pressOverlay, event.row, event.col);
			if (!overlayHit) {
				// The transcript scrollbar owns its column ahead of the other
				// chrome sharing those rows (sticky header, scroll badge).
				if (this.isTranscriptScrollbarCell(event.row, event.col)) {
					this.transcriptScrollbarDrag = true;
					this.beginTranscriptScrollbarDrag(event.row - 1);
					return;
				}
				if (event.row === 1 && this.stickyHeaderVisible) {
					if (this.stickyJumpTo !== null) {
						const maxScroll = Math.max(0, this.lastScrollRegionLineCount - this.lastViewportHeight);
						const next = Math.max(0, Math.min(this.stickyJumpTo, maxScroll));
						if (next !== this.scrollTop) this.clearTranscriptZoneHover();
						this.scrollTop = next;
						this.followOutput = this.scrollTop >= maxScroll;
						this.requestRender();
					} else {
						this.scrollToBottom();
					}
					return;
				}
				if (event.row === this.lastViewportHeight && this.scrollIndicatorVisible) {
					// Only clicks landing on the badge itself count (right-aligned);
					// anywhere else on that row is just transcript content.
					if (event.col > this.terminal.columns - this.scrollIndicatorBadgeWidth) {
						this.scrollToBottom();
						return;
					}
				}
				// Zone hit-test over slot display panels (chrome like the footer,
				// which never takes focus): a press landing in a declared action
				// zone is dispatched to the zone's owner. The focused component's
				// own subtree is excluded — it is covered by the focused path below.
				{
					const { scroll, slot } = this.layoutRegions;
					const regionsMounted =
						scroll !== undefined &&
						slot !== undefined &&
						this.isComponentMounted(scroll) &&
						this.isComponentMounted(slot);
					if (
						regionsMounted &&
						event.row > this.lastViewportHeight &&
						slot instanceof Container &&
						this.slotPanelZonePress(
							slot,
							event.row - 1 - this.lastViewportHeight + this.lastSlotClipRows,
							event,
						)
					) {
						return;
					}
				}
				// A focused overlay is modal: presses outside its rect never
				// reach the underlay (transcript content, covered slot chrome).
				if (pressOverlay !== undefined) return;
			}
			// Transcript content zones (tool cards/groups): a press landing in
			// a declared action zone is dispatched to the zone's owner with
			// scroll-offset and gutter-inset translation. Presses elsewhere in
			// the viewport fall through to the focused path, which declines
			// transcript-region rows for slot-focused components.
			{
				const { scroll } = this.layoutRegions;
				if (
					scroll instanceof Container &&
					this.isTranscriptContentCell(event.row, event.col)
				) {
					const hit = this.transcriptZoneHit(scroll, event.row - 1, event, "action");
					if (hit !== null) {
						if (this.dispatchHitZone(hit.zone, hit.event) !== false) {
							this.requestRender();
						}
						return;
					}
				}
			}
			const focused = this.focusedComponent;
			if (focused === null) return;
			const zoneAware = hasHitZones(focused);
			if (focused.handleMouse === undefined && !zoneAware) return;
			const { slot } = this.layoutRegions;
			let row: number;
			let col: number;
			if (pressOverlay !== undefined) {
				// Overlay: translate through its composed rect (overlayHit was
				// verified above, so the rect is non-null and contains the point).
				const rect = pressOverlay.lastRect!;
				row = event.row - 1 - rect.row;
				col = event.col - rect.col;
			} else if (slot !== undefined && this.containsComponent(slot, focused)) {
				// The slot starts right below the transcript viewport; inside it,
				// container chrome and siblings shift the component down, and a
				// slot taller than the screen is clipped at the top (the visible
				// slot top sits lastSlotClipRows into the slot's rendered
				// output). Container gutters likewise shift the component right.
				const inner = this.rowOffsetWithin(slot, focused);
				if (inner === null) return;
				const slotIndex = event.row - 1 - this.lastViewportHeight + this.lastSlotClipRows;
				// Rows above the visible slot top are transcript viewport (or
				// clipped-away slot lines), not component hits.
				if (slotIndex < this.lastSlotClipRows) return;
				row = slotIndex - inner;
				col = event.col - (this.colInsetWithin(slot, focused) ?? 0);
			} else {
				// Takeover components fill the screen from row 1.
				row = event.row - 1;
				col = event.col - (this.colInsetWithin(this as Container, focused) ?? 0);
			}
			if (row < 0) return;
			const translated: MouseEvent = {
				...event,
				col,
				row,
				slotRelative: false,
			};
			if (!(focused.wantsMouseEvent?.(translated) ?? true)) return;
			// Declared hit zones take precedence: a press inside an action zone
			// is dispatched semantically to the zone's owner; only presses
			// outside every zone reach the raw handleMouse path.
			if (zoneAware) {
				const zone = hitZoneAt(
					resolveHitZones(focused, Math.max(1, this.terminal.columns)),
					row,
					col,
					"action",
				);
				if (zone !== null) {
					if (this.dispatchHitZone(zone, translated) !== false) this.requestRender();
					return;
				}
			}
			if (focused.handleMouse === undefined) return;
			if (focused.handleMouse(translated) !== false) this.requestRender();
		}
	}

	/**
	 * Deliver a zone hit to the zone's owner, re-translating the event into
	 * the owner's own frame when the zone was composed through containers
	 * (the event is in the focused component's frame; the owner may be a
	 * descendant of it).
	 */
	private dispatchHitZone(zone: ResolvedHitZone, event: MouseEvent): void | boolean {
		const ownerEvent =
			zone.rowOffset === 0 && zone.colOffset === 0
				? event
				: { ...event, row: event.row - zone.rowOffset, col: event.col - zone.colOffset };
		return zone.owner.onHitZone?.(zone.id, ownerEvent);
	}

	/**
	 * Scroll-badge hover: the pointer over the right-aligned badge on the
	 * viewport's bottom row lights it up. The hit rect matches the click rect;
	 * a visible overlay covering that point shields the underlay badge, the
	 * same rule the press path applies.
	 */
	private updateScrollIndicatorHover(event: MouseEvent): void {
		let hovered = false;
		if (
			this.scrollIndicatorVisible &&
			event.row === this.lastViewportHeight &&
			event.col > this.terminal.columns - this.scrollIndicatorBadgeWidth
		) {
			const overlay = this.visibleOverlayEntryFor(this.focusedComponent);
			hovered = overlay === undefined || !this.isPointInOverlayRect(overlay, event.row, event.col);
		}
		if (hovered === this.scrollIndicatorHovered) return;
		this.scrollIndicatorHovered = hovered;
		this.requestChromeRender();
	}

	/**
	 * Whether a 1-based terminal cell sits on the transcript scrollbar's rect:
	 * the viewport's rightmost column, while the layout regions are mounted
	 * and the transcript actually scrolls. A visible overlay covering the
	 * cell shields the bar, the same rule the scroll badge applies.
	 */
	private isTranscriptScrollbarCell(row: number, col: number): boolean {
		if (col !== this.terminal.columns || row < 1 || row > this.lastViewportHeight) return false;
		const { scroll, slot } = this.layoutRegions;
		if (
			scroll === undefined ||
			slot === undefined ||
			!this.isComponentMounted(scroll) ||
			!this.isComponentMounted(slot)
		) {
			return false;
		}
		if (this.lastScrollRegionLineCount - this.lastViewportHeight <= 0) return false;
		const overlay = this.visibleOverlayEntryFor(this.focusedComponent);
		return overlay === undefined || !this.isPointInOverlayRect(overlay, row, col);
	}

	/**
	 * Transcript-scrollbar hover: the bar reveals while the pointer sits on
	 * the viewport's rightmost column (a drag keeps it revealed via
	 * {@link transcriptScrollbarDrag} regardless of the pointer cell).
	 */
	private updateTranscriptScrollbarHover(event: MouseEvent): void {
		const hovered = this.isTranscriptScrollbarCell(event.row, event.col);
		if (hovered === this.transcriptScrollbarHover) return;
		this.transcriptScrollbarHover = hovered;
		this.requestChromeRender();
	}

	/**
	 * Begin a transcript-scrollbar drag from a press at a 0-based viewport
	 * row: landing on the thumb anchors the pointer at that row within the
	 * thumb (grab delta — the content does not jump); landing on the bare
	 * track jumps to the pointed fraction and the drag continues absolutely.
	 */
	private beginTranscriptScrollbarDrag(viewportRow: number): void {
		const thumb = scrollbarThumb(
			{
				scrollTop: this.scrollTop,
				viewport: this.lastViewportHeight,
				content: this.lastScrollRegionLineCount,
			},
			this.lastViewportHeight,
		);
		this.transcriptScrollbarGrabOffset =
			thumb !== null && viewportRow >= thumb.offset && viewportRow < thumb.offset + thumb.size
				? viewportRow - thumb.offset
				: null;
		if (this.transcriptScrollbarGrabOffset !== null) {
			// No jump — but the grab reveals the bar even if no motion preceded
			// the press (the drag flag alone engages it).
			this.requestChromeRender();
			return;
		}
		this.scrollTranscriptToTrackRow(viewportRow);
	}

	/**
	 * Apply the track's absolute fraction mapping to a 0-based viewport row:
	 * the pointed fraction of the transcript becomes the scroll offset.
	 */
	private scrollTranscriptToTrackRow(viewportRow: number): void {
		const metrics = {
			scrollTop: this.scrollTop,
			viewport: this.lastViewportHeight,
			content: this.lastScrollRegionLineCount,
		};
		this.applyTranscriptScrollTarget(
			scrollTopForTrackRow(metrics, this.lastViewportHeight, viewportRow),
		);
	}

	/**
	 * Grab-drag counterpart of {@link scrollTranscriptToTrackRow}: the scroll
	 * offset whose thumb sits at `thumbRow`, so the thumb follows the pointer
	 * 1:1 from the row it was grabbed at.
	 */
	private scrollTranscriptToThumbRow(thumbRow: number): void {
		const metrics = {
			scrollTop: this.scrollTop,
			viewport: this.lastViewportHeight,
			content: this.lastScrollRegionLineCount,
		};
		this.applyTranscriptScrollTarget(
			scrollTopForThumbOffset(metrics, this.lastViewportHeight, thumbRow),
		);
	}

	/**
	 * Shared landing for the scrollbar's press/drag targets: clamp to the
	 * live limits and re-engage follow mode when parked at the bottom,
	 * matching scrollBy. The metrics are O(1) render by-products re-derived
	 * per event, so a live transcript keeps the mapping exact even mid-drag.
	 */
	private applyTranscriptScrollTarget(target: number): void {
		const maxScroll = Math.max(0, this.lastScrollRegionLineCount - this.lastViewportHeight);
		if (maxScroll <= 0) return;
		const next = Math.max(0, Math.min(target, maxScroll));
		if (next !== this.scrollTop) this.clearTranscriptZoneHover();
		this.scrollTop = next;
		this.followOutput = this.scrollTop >= maxScroll;
		this.requestChromeRender();
	}

	/**
	 * Zone-based hover: hit-test the focused component's declared hover zones
	 * at the translated pointer position and notify the owning components when
	 * the hovered (owner, id) pair changes — leaving a zone clears the old
	 * owner's hover, entering one sets the new owner's. Owners report whether
	 * their render output changed (false = skip the frame), mirroring the
	 * legacy hover contract.
	 */
	private updateZoneHover(focused: Component, row: number, col: number): void {
		const zone =
			row < 0
				? null
				: hitZoneAt(resolveHitZones(focused, Math.max(1, this.terminal.columns)), row, col, "hover");
		const next = zone === null ? null : { owner: zone.owner, id: zone.id };
		const prev = this.lastHoveredZone;
		if (prev === null && next === null) return;
		if (prev !== null && next !== null && prev.owner === next.owner && prev.id === next.id) return;
		let renderNeeded = false;
		if (prev !== null && (next === null || prev.owner !== next.owner)) {
			renderNeeded = prev.owner.setHoveredZone?.(null) !== false;
		}
		if (next !== null) {
			renderNeeded = next.owner.setHoveredZone?.(next.id) !== false || renderNeeded;
		}
		this.lastHoveredZone = next;
		if (renderNeeded) this.requestRender();
	}

	/**
	 * Transcript-content zone hover: hit-test the scroll region's declared
	 * hover zones at the pointer's viewport cell and notify the owning
	 * components when the hovered (owner, id) pair changes, mirroring
	 * {@link updateZoneHover}. Transcript children never take focus, so this
	 * is tracked in {@link lastTranscriptHoveredZone} independently of the
	 * focused component's zone hover; both clears are driven by the same
	 * motion events. Owners report whether their render output changed (false
	 * = skip the frame).
	 */
	private updateTranscriptZoneHover(event: MouseEvent): void {
		const hit = this.isTranscriptContentCell(event.row, event.col)
			? this.transcriptZoneHit(this.layoutRegions.scroll as Container, event.row - 1, event, "hover")
			: null;
		const next = hit === null ? null : { owner: hit.zone.owner, id: hit.zone.id };
		const prev = this.lastTranscriptHoveredZone;
		if (prev === null && next === null) return;
		if (prev !== null && next !== null && prev.owner === next.owner && prev.id === next.id) return;
		let renderNeeded = false;
		if (prev !== null && (next === null || prev.owner !== next.owner)) {
			renderNeeded = prev.owner.setHoveredZone?.(null) !== false;
		}
		if (next !== null) {
			renderNeeded = next.owner.setHoveredZone?.(next.id) !== false || renderNeeded;
		}
		this.lastTranscriptHoveredZone = next;
		if (renderNeeded) this.requestRender();
	}

	/**
	 * Drop the transcript-content hover (scrolling, leaving fullscreen, the
	 * scroll region unmounting): the hovered owner is notified so it clears
	 * its affordance instead of rendering it stale.
	 */
	private clearTranscriptZoneHover(): void {
		const prev = this.lastTranscriptHoveredZone;
		if (prev === null) return;
		this.lastTranscriptHoveredZone = null;
		if (prev.owner.setHoveredZone?.(null) !== false) this.requestRender();
	}

	private handleInput(data: string): void {
		if (this.consumeOsc11BackgroundResponse(data)) {
			return;
		}
		if (this.consumeTerminalColorSchemeReport(data)) {
			return;
		}

		if (this.inputListeners.size > 0) {
			let current = data;
			for (const listener of this.inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// Consume terminal cell size responses without blocking unrelated input.
		if (this.consumeCellSizeResponse(data)) {
			return;
		}

		// Fullscreen mouse handling: wheel events scroll the transcript when the
		// focus is inside the scroll region, and are forwarded to mouse-aware
		// focused components (takeovers, slot dialogs) otherwise. Left-clicks
		// drive the sticky-header / scroll-badge jumps. Everything else is
		// swallowed so raw bytes never reach components; terminal-native
		// selection stays available via Shift+drag.
		if (this.fullscreen) {
			const event = TUI.parseMouseEvent(data);
			if (event) {
				this.handleFullscreenMouse(event);
				return;
			}
			const kb = getKeybindings();
			if (kb.matches(data, "tui.scroll.up")) {
				this.scrollPage(-1);
				return;
			}
			if (kb.matches(data, "tui.scroll.down")) {
				this.scrollPage(1);
				return;
			}
			if (kb.matches(data, "tui.scroll.top")) {
				this.scrollToTop();
				return;
			}
			if (kb.matches(data, "tui.scroll.bottom")) {
				this.scrollToBottom();
				return;
			}
		}

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				this.setFocusInternal({ component: focusedOverlay.preFocus, overlayFocusRestore: "preserve" });
			}
		}

		const focusIsOverlay = this.overlayStack.some((o) => o.component === this.focusedComponent);
		if (!focusIsOverlay) {
			const restoreState = this.getVisibleOverlayFocusRestore();
			if (restoreState.status === "eligible") {
				this.setFocus(restoreState.overlay.component);
			} else if (restoreState.status === "blocked" && restoreState.blockedBy !== this.focusedComponent) {
				if (restoreState.resume.status === "restore-overlay") {
					this.setFocus(restoreState.overlay.component);
				} else {
					this.clearOverlayFocusRestore();
					this.setFocus(restoreState.resume.target);
				}
			}
		}

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			this.focusedComponent.handleInput(data);
			this.requestRender();
		}
	}

	private consumeOsc11BackgroundResponse(data: string): boolean {
		if (this.pendingOsc11BackgroundReplies <= 0) {
			return false;
		}

		if (!isOsc11BackgroundColorResponse(data)) {
			return false;
		}

		const rgb = parseOsc11BackgroundColor(data);
		this.pendingOsc11BackgroundReplies -= 1;
		const query = this.pendingOsc11BackgroundQueries.shift();
		if (query && !query.settled) {
			query.settled = true;
			if (query.timer) {
				clearTimeout(query.timer);
				query.timer = undefined;
			}
			query.resolve?.(rgb);
			query.resolve = undefined;
		}
		return true;
	}

	private consumeTerminalColorSchemeReport(data: string): boolean {
		const scheme = parseTerminalColorSchemeReport(data);
		if (!scheme) {
			return false;
		}

		for (const listener of this.terminalColorSchemeListeners) {
			listener(scheme);
		}
		return true;
	}

	private consumeCellSizeResponse(data: string): boolean {
		// Response format: ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1]!, 10);
		const widthPx = parseInt(match[2]!, 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// Invalidate all components so images re-render with correct dimensions.
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * Resolve overlay layout from options.
	 * Returns { width, row, col, maxHeight } for rendering.
	 */
	private resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		const opt = options ?? {};

		// Parse margin (clamp to non-negative)
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// Available space after margins
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// Clamp to available space
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// Clamp to available space
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// Effective overlay height (may be clamped by maxHeight)
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === Resolve position ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]!) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// Invalid format, fall back to center
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				row = opt.row;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]!) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// Invalid format, fall back to center
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				col = opt.col;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// Clamp to terminal bounds (respecting margins)
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
	private compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		if (this.overlayStack.length === 0) return lines;
		const result = [...lines];

		// Stale rects must never survive a frame in which the overlay is hidden:
		// mouse hit-testing trusts lastRect to match what is on screen.
		for (const entry of this.overlayStack) entry.lastRect = null;

		// Pre-render all visible overlays and calculate positions
		const rendered: { entry: OverlayStackEntry; overlayLines: string[]; row: number; col: number; w: number }[] = [];
		let minLinesNeeded = result.length;

		const visibleEntries = this.overlayStack.filter((e) => this.isOverlayVisible(e));
		visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
		for (const entry of visibleEntries) {
			const { component, options } = entry;

			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height)
			const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render component at calculated width
			let overlayLines = component.render(width);

			// Apply maxHeight if specified
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// Get final row/col with actual overlay height
			const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);

			rendered.push({ entry, overlayLines, row, col, w: width });
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}

		// Pad to at least terminal height so overlays have screen-relative positions.
		// Excludes maxLinesRendered: the historical high-water mark caused self-reinforcing
		// inflation that pushed content into scrollback on terminal widen.
		const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement or working area
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// Composite each overlay
		for (const { entry, overlayLines, row, col, w } of rendered) {
			entry.lastRect = { row: viewportStart + row, col, width: w, height: overlayLines.length };
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]!) > w ? sliceByColumn(overlayLines[i]!, 0, w, true) : overlayLines[i]!;
					result[idx] = this.compositeLineAt(result[idx]!, truncatedOverlayLine, col, w, termWidth);
				}
			}
		}

		return result;
	}

	private static readonly SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

	private unionKittyImageIds(lineImageIds: ReadonlyArray<number>[]): Set<number> {
		const ids = new Set<number>();
		for (const lineIds of lineImageIds) {
			for (const id of lineIds) {
				ids.add(id);
			}
		}
		return ids;
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private getKittyImageReservedRows(lines: string[], index: number, maxIndex = lines.length - 1): number {
		const rows = extractKittyImageRows(lines[index] ?? "");
		if (rows <= 1) return 1;

		const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
		let reservedRows = 1;
		while (reservedRows < maxRows) {
			const line = lines[index + reservedRows] ?? "";
			if (isImageLine(line) || visibleWidth(line) > 0) break;
			reservedRows++;
		}
		return reservedRows;
	}

	private expandChangedRangeForKittyImages(
		firstChanged: number,
		lastChanged: number,
		newLines: string[],
		newLineImageIds: ReadonlyArray<number>[],
	): { firstChanged: number; lastChanged: number } {
		let expandedFirstChanged = firstChanged;
		let expandedLastChanged = lastChanged;
		const expandForLines = (lines: string[], lineImageIds: ReadonlyArray<number>[]): void => {
			for (let i = 0; i < lines.length; i++) {
				if ((lineImageIds[i] ?? EMPTY_IMAGE_IDS).length === 0) continue;
				const blockEnd = i + this.getKittyImageReservedRows(lines, i) - 1;
				if (i >= firstChanged || (i <= lastChanged && blockEnd >= firstChanged)) {
					expandedFirstChanged = Math.min(expandedFirstChanged, i);
					expandedLastChanged = Math.max(expandedLastChanged, blockEnd);
				}
			}
		};

		expandForLines(this.previousLines, this.previousLineImageIds);
		expandForLines(newLines, newLineImageIds);
		return { firstChanged: expandedFirstChanged, lastChanged: expandedLastChanged };
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of this.previousLineImageIds[i] ?? EMPTY_IMAGE_IDS) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	/** Splice overlay content into a base line at a specific column. Single-pass optimized. */
	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		if (isImageLine(baseLine)) return baseLine;

		// Single pass through baseLine extracts both before and after segments
		const afterStart = startCol + overlayWidth;
		const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

		// Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
		const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

		// Pad segments to target widths
		const beforePad = Math.max(0, startCol - base.beforeWidth);
		const overlayPad = Math.max(0, overlayWidth - overlay.width);
		const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
		const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
		const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
		const afterPad = Math.max(0, afterTarget - base.afterWidth);

		// Compose result
		const r = TUI.SEGMENT_RESET;
		const result =
			base.before +
			" ".repeat(beforePad) +
			r +
			overlay.text +
			" ".repeat(overlayPad) +
			r +
			base.after +
			" ".repeat(afterPad);

		// CRITICAL: Always verify and truncate to terminal width.
		// This is the final safeguard against width overflow which would crash the TUI.
		// Width tracking can drift from actual visible width due to:
		// - Complex ANSI/OSC sequences (hyperlinks, colors)
		// - Wide characters at segment boundaries
		// - Edge cases in segment extraction
		const resultWidth = visibleWidth(result);
		if (resultWidth <= totalWidth) {
			return result;
		}
		// Truncate with strict=true to ensure we don't exceed totalWidth
		return sliceByColumn(result, 0, totalWidth, true);
	}

	/**
	 * Replace kitty image lines whose reserved rows cross the slice end with "".
	 * A partially visible image must not be drawn, or it would paint over the
	 * rows belonging to the region below (viewport → slot, slot → screen edge).
	 */
	private clipKittyImagesToSlice(lines: string[]): string[] {
		for (let i = 0; i < lines.length; i++) {
			if (extractKittyImageRows(lines[i]!) > 1 && i + extractKittyImageRows(lines[i]!) > lines.length) {
				lines[i] = "";
			}
		}
		return lines;
	}

	/**
	 * Compose the fullscreen frame: exactly `height` lines = transcript viewport
	 * slice (top-padded) + fixed bottom slot. Falls back to a top-aligned
	 * whole-tree frame when the registered regions are not mounted (takeovers).
	 */
	private composeFullscreenFrame(width: number, height: number): string[] {
		const { scroll, slot } = this.layoutRegions;
		const regionsMounted =
			scroll !== undefined &&
			slot !== undefined &&
			this.isComponentMounted(scroll) &&
			this.isComponentMounted(slot);

		if (!regionsMounted) {
			// Takeover frames are whole-screen; the scroll UI flags from the main
			// layout must not leak into click handling or public getters here.
			this.scrollIndicatorVisible = false;
			this.scrollIndicatorHovered = false;
			this.transcriptScrollbarHover = false;
			this.transcriptScrollbarDrag = false;
			this.transcriptScrollbarGrabOffset = null;
			this.clearTranscriptZoneHover();
			this.stickyHeaderVisible = false;
			this.stickyJumpTo = null;
			const lines = this.render(width).slice(0, height);
			while (lines.length < height) lines.push("");
			this.lastScrollRegionLineCount = 0;
			this.lastViewportHeight = height;
			this.lastSlotClipRows = 0;
			return this.clipKittyImagesToSlice(lines);
		}

		// Bottom slot: clipped from the top when taller than the screen (viewport keeps 1 row).
		const slotLines = slot.render(width);
		const slotHeight = Math.min(slotLines.length, Math.max(1, height - 1));
		const slotView = slotHeight < slotLines.length ? slotLines.slice(slotLines.length - slotHeight) : slotLines;
		this.lastSlotClipRows = slotLines.length - slotView.length;
		this.clipKittyImagesToSlice(slotView);
		const viewportHeight = height - slotHeight;
		this.lastViewportHeight = viewportHeight;

		// Scroll region: show [scrollTop, scrollTop + viewportHeight). The row
		// index caches per-child geometry, so a steady frame materializes only
		// the viewport window instead of rendering and concatenating the whole
		// transcript; the legacy whole-render fallback covers non-Container
		// scroll regions and containers the index cannot reproduce (per-child
		// chrome rows).
		const scrollContainer = scroll instanceof Container ? scroll : null;
		const childWidth =
			scrollContainer === null
				? width
				: Math.max(1, width - scrollContainer.leftInset() - scrollContainer.rightInset());
		let indexed = false;
		if (scrollContainer !== null && !this.transcriptIndex.isDeclinedFor(scrollContainer)) {
			if (this.transcriptDirty || !this.transcriptIndex.isWarmFor(scrollContainer, childWidth)) {
				indexed = this.transcriptIndex.syncFull(scrollContainer, childWidth);
				// The legacy fallback re-renders the whole region every frame,
				// so the latch may drop even when the index declined.
				this.transcriptDirty = false;
			} else {
				indexed = true;
			}
		}
		let scrollLines: string[] | null = null;
		let scrollLineCount: number;
		if (indexed) {
			scrollLineCount = this.transcriptIndex.totalLines;
		} else {
			scrollLines = scroll.render(width);
			scrollLineCount = scrollLines.length;
		}
		this.lastScrollRegionLineCount = scrollLineCount;
		const maxScroll = Math.max(0, scrollLineCount - viewportHeight);
		if (this.followOutput) {
			this.scrollTop = maxScroll;
		}
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScroll));
		// Re-sync follow when the clamp lands us on the bottom: content shrank
		// (/clear, /new, collapse) or the viewport grew — being at the bottom
		// must mean following, otherwise new output stops anchoring here.
		if (this.scrollTop >= maxScroll) {
			this.followOutput = true;
		}

		const slice = indexed
			? this.materializeTranscriptWindow(scrollContainer!, this.scrollTop, viewportHeight)
			: scrollLines!.slice(this.scrollTop, this.scrollTop + viewportHeight);
		this.clipKittyImagesToSlice(slice);

		// Transcript is top-aligned: content starts at the viewport top and the
		// blank gap sits between it and the slot (classic chat layout — the
		// welcome card stays pinned to the top of a fresh session).
		const frame: string[] = [...slice];
		while (frame.length < viewportHeight) frame.push("");

		// Scrolled-up indicator: drawn over the viewport's bottom row, right-aligned.
		// The segment reset isolates the badge from any background colour the row's
		// own content carries (e.g. a full-width user-message block).
		this.scrollIndicatorVisible = false;
		if (!this.followOutput && viewportHeight > 0) {
			const hidden = maxScroll - this.scrollTop;
			if (hidden > 0) {
				const label = this.scrollIndicatorLabel?.(hidden) ?? `↓ ${hidden}`;
				const badgeWidth = visibleWidth(label) + 2;
				const style = this.scrollIndicatorStyle ?? defaultScrollIndicatorBadgeStyle;
				const badge = style(` ${label} `, this.scrollIndicatorHovered);
				const rowIndex = viewportHeight - 1;
				const base = frame[rowIndex]!;
				const baseWidth = visibleWidth(base);
				frame[rowIndex] =
					baseWidth > width - badgeWidth
						? sliceByColumn(base, 0, width - badgeWidth, true) + TUI.SEGMENT_RESET + badge
						: base + TUI.SEGMENT_RESET + " ".repeat(width - badgeWidth - baseWidth) + badge;
				this.scrollIndicatorVisible = true;
				this.scrollIndicatorBadgeWidth = badgeWidth;
			}
		}
		// No badge on screen means no hover target: drop a stale hover so the
		// next frame with the badge never lights up without the pointer on it.
		if (!this.scrollIndicatorVisible) {
			this.scrollIndicatorHovered = false;
		}

		// Sticky prompt header: while scrolled up, the prompt summary for the
		// message currently in view is pinned to the viewport's top row (click it
		// to jump to that message, or to the bottom when it has no target).
		this.stickyHeaderVisible = false;
		this.stickyJumpTo = null;
		if (!this.followOutput && this.stickyHeaderContent && viewportHeight > 1) {
			const header = this.stickyHeaderContent(width, this.scrollTop, viewportHeight);
			// Dedup: when the anchored message is itself visible in the viewport
			// (its start line is at or below the viewport top), showing it in the
			// header too reads as a duplicate — suppress the header.
			const anchoredVisible = header?.jumpTo !== undefined && header.jumpTo >= this.scrollTop;
			if (header !== null && header.line.length > 0 && !anchoredVisible) {
				frame[0] =
					visibleWidth(header.line) > width ? sliceByColumn(header.line, 0, width, true) : header.line;
				this.stickyHeaderVisible = true;
				this.stickyJumpTo = header.jumpTo ?? null;
			}
		}

		// Transcript scrollbar: hover-revealed overlay on the viewport's
		// rightmost column (░ track, █ thumb). Drawn after the badge and the
		// sticky header so the bar wins that cell — the badge's last cell is
		// its padding space. Kitty-image rows keep their line untouched:
		// splicing text into an image escape would corrupt the image.
		if ((this.transcriptScrollbarHover || this.transcriptScrollbarDrag) && maxScroll > 0) {
			const thumb = scrollbarThumb(
				{ scrollTop: this.scrollTop, viewport: viewportHeight, content: scrollLineCount },
				viewportHeight,
			);
			if (thumb !== null) {
				const viewportRows = frame.slice(0, viewportHeight);
				const barred = drawScrollbar(viewportRows, width, thumb, this.scrollbarStyle ?? undefined);
				for (let i = 0; i < viewportHeight; i++) {
					if (!isImageLine(viewportRows[i]!)) frame[i] = barred[i]!;
				}
			}
		}

		frame.push(...slotView);
		return frame;
	}

	/**
	 * The transcript rows of [fromLine, fromLine + count), composed from the
	 * row index: only the children intersecting the window are touched, and
	 * each child's gutter-prefixed block is reused across frames by lines
	 * identity (render caches return identical references for unchanged
	 * content, so the frame rows stay reference-stable for the differential
	 * renderer). Byte-equivalent to rendering the whole scroll region and
	 * slicing it.
	 */
	private materializeTranscriptWindow(scroll: Container, fromLine: number, count: number): string[] {
		const lead = " ".repeat(scroll.leftInset());
		const rows: string[] = [];
		const toLine = fromLine + count;
		for (const entry of this.transcriptIndex.windowEntries(fromLine, toLine)) {
			const lines = entry.lines;
			let block: string[];
			if (lead.length === 0) {
				block = lines;
			} else {
				let cached = this.transcriptPrefixCache.get(lines);
				if (cached === undefined || cached.lead !== lead) {
					cached = { lead, block: lines.map((line) => lead + line) };
					this.transcriptPrefixCache.set(lines, cached);
				}
				block = cached.block;
			}
			const start = Math.max(fromLine - entry.base, 0);
			const end = Math.min(entry.base + entry.height, toLine) - entry.base;
			for (let i = start; i < end && rows.length < count; i++) {
				rows.push(block[i]!);
			}
			if (rows.length >= count) break;
		}
		return rows;
	}

	/**
	 * Fullscreen renderer: the frame is exactly `rows` lines and is written with
	 * absolute cursor addressing, so no terminal scrolling ever happens — which
	 * is what makes ghost lines and viewport bookkeeping impossible here.
	 */
	private doFullscreenRender(): void {
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const sizeChanged = this.previousWidth !== width || this.previousHeight !== height;

		let frame = this.composeFullscreenFrame(width, height);
		if (this.overlayStack.length > 0) {
			frame = this.compositeOverlays(frame, width, height).slice(0, height);
		}

		// Extract cursor before line resets (marker must be found first)
		const cursorPos = this.extractCursorPosition(frame, height);

		// Process raw frame lines for output, reusing the previous frame's
		// processed lines when the raw string reference is unchanged. Same
		// invariant as the inline path's processed-line reuse: component
		// render caches return identical string references for unchanged
		// content, and the processed output is a pure function of the raw
		// line and the terminal width. Reuse requires an unchanged width;
		// height changes re-pad the frame but per-line processing is
		// height-independent, so per-index reuse stays valid there.
		const rawFrameLines = frame;
		const reuseProcessed = this.previousWidth === width && this.previousRawFrameLines.length > 0;
		const processedFrame: string[] = new Array(rawFrameLines.length);
		const frameLineImageIds: ReadonlyArray<number>[] = new Array(rawFrameLines.length);
		for (let i = 0; i < rawFrameLines.length; i++) {
			const rawLine = rawFrameLines[i]!;
			if (
				reuseProcessed &&
				i < this.previousRawFrameLines.length &&
				rawLine === this.previousRawFrameLines[i]
			) {
				processedFrame[i] = this.previousLines[i]!;
				frameLineImageIds[i] = this.previousFrameLineImageIds[i]!;
				continue;
			}
			// Never write a line wider than the terminal
			let line = rawLine;
			let imageIds: readonly number[] = EMPTY_IMAGE_IDS;
			if (isImageLine(line)) {
				imageIds = extractKittyImageIds(line);
			} else {
				const lineWidth = asciiVisibleWidth(line, width) ?? visibleWidth(line);
				if (lineWidth > width) {
					line = sliceByColumn(line, 0, width, true);
				}
				line = normalizeTerminalOutput(line) + TUI.SEGMENT_RESET;
			}
			processedFrame[i] = line;
			frameLineImageIds[i] = imageIds;
		}
		frame = processedFrame;
		const frameKittyImageIds = this.unionKittyImageIds(frameLineImageIds);

		const fullRepaint = sizeChanged || this.previousLines.length !== frame.length;
		let buffer = "\x1b[?2026h"; // Begin synchronized output
		let lastCursorRow = 0;

		if (fullRepaint) {
			this.fullRedrawCount += 1;
			buffer += this.deleteKittyImages(this.previousKittyImageIds);
			buffer += "\x1b[2J";
			for (let row = 0; row < frame.length; row++) {
				const line = frame[row]!;
				if (isImageLine(line)) {
					const reserved = this.getKittyImageReservedRows(frame, row);
					for (let k = 0; k < reserved; k++) {
						buffer += `\x1b[${row + 1 + k};1H\x1b[2K`;
					}
					buffer += `\x1b[${row + 1};1H`;
					buffer += line;
					lastCursorRow = row;
					row += reserved - 1;
					continue;
				}
				buffer += `\x1b[${row + 1};1H\x1b[2K`;
				buffer += line;
				lastCursorRow = row;
			}
		} else {
			// Delete kitty images that left the frame
			const staleIds: number[] = [];
			for (const id of this.previousKittyImageIds) {
				if (!frameKittyImageIds.has(id)) staleIds.push(id);
			}
			if (staleIds.length > 0) {
				buffer += this.deleteKittyImages(staleIds);
			}

			let row = 0;
			while (row < frame.length) {
				const line = frame[row]!;
				// Unchanged lines are skipped, images included: with absolute
				// addressing nothing scrolls, and re-sending the base64 payload
				// every frame is pure cost (flicker + bandwidth).
				if (frame[row] === this.previousLines[row]) {
					row++;
					continue;
				}
				if (isImageLine(line)) {
					const reserved = this.getKittyImageReservedRows(frame, row);
					for (let k = 0; k < reserved; k++) {
						buffer += `\x1b[${row + 1 + k};1H\x1b[2K`;
					}
					buffer += `\x1b[${row + 1};1H`;
					buffer += line;
					// The image escape is zero-width: the cursor stays on the
					// image row, not at the bottom of its reserved block.
					lastCursorRow = row;
					row += reserved;
					continue;
				}
				buffer += `\x1b[${row + 1};1H\x1b[2K`;
				buffer += line;
				lastCursorRow = row;
				row++;
			}
		}

		buffer += "\x1b[?2026l"; // End synchronized output
		this.terminal.write(buffer);

		this.cursorRow = Math.max(0, frame.length - 1);
		this.hardwareCursorRow = lastCursorRow;
		this.positionHardwareCursor(cursorPos, frame.length);

		this.previousLines = frame;
		this.previousRawFrameLines = rawFrameLines;
		this.previousFrameLineImageIds = frameLineImageIds;
		this.previousKittyImageIds = frameKittyImageIds;
		this.previousWidth = width;
		this.previousHeight = height;
	}

	/**
	 * Find and extract cursor position from rendered lines.
	 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
	 * Only scans the bottom terminal height lines (visible viewport).
	 * @param lines - Rendered lines to search
	 * @param height - Terminal height (visible viewport size)
	 * @returns Cursor position { row, col } or null if no marker found
	 */
	private extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// Only scan the bottom `height` lines (visible viewport)
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row]!;
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { row, col };
			}
		}
		return null;
	}

	private doRender(): void {
		if (this.stopped) return;
		// A completed render means layout may have changed; the mouse-motion
		// dedupe keys its cached row translation on this epoch.
		this.renderEpoch += 1;
		// Latch and clear: fullscreen frames are recomposed every render, so a
		// pending collapse request is meaningless there and must not leak into
		// a later inline frame after a mode switch.
		const collapseRequested = this.collapseRenderRequested;
		this.collapseRenderRequested = false;
		if (this.fullscreen) {
			this.doFullscreenRender();
			return;
		}
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		let newLines = this.render(width);

		if (this.overlayStack.length > 0) {
			newLines = this.compositeOverlays(newLines, width, height);
		}

		// Extract cursor position before applying line resets (marker must be found first)
		const cursorPos = this.extractCursorPosition(newLines, height);

		// Process raw lines for output. Never write a line wider than the
		// terminal: truncate defensively instead of crashing. Extremely narrow
		// terminals can make components overflow by a column (e.g. wide
		// graphemes at width 1). The trailing segment reset is appended after
		// truncation, so truncated lines still get their reset and cannot leak
		// styles.
		//
		// Lines whose raw string is reference-identical to the previous frame's
		// reuse their processed output verbatim: component render caches return
		// the same string references for unchanged content, so a steady frame
		// only pays for the lines that actually changed instead of
		// re-normalizing the whole transcript.
		const rawLines = newLines;
		const reuseProcessed = !widthChanged && this.previousRawLines.length > 0;
		const processedLines: string[] = new Array(rawLines.length);
		const lineImageIds: ReadonlyArray<number>[] = new Array(rawLines.length);
		for (let i = 0; i < rawLines.length; i++) {
			const rawLine = rawLines[i]!;
			if (reuseProcessed && rawLine === this.previousRawLines[i]) {
				processedLines[i] = this.previousLines[i]!;
				lineImageIds[i] = this.previousLineImageIds[i]!;
				continue;
			}
			let line = rawLine;
			let imageIds: readonly number[] = EMPTY_IMAGE_IDS;
			if (isImageLine(line)) {
				imageIds = extractKittyImageIds(line);
			} else {
				const lineWidth = asciiVisibleWidth(line, width) ?? visibleWidth(line);
				if (lineWidth > width) {
					line = sliceByColumn(line, 0, width, true);
				}
				line = normalizeTerminalOutput(line) + TUI.SEGMENT_RESET;
			}
			processedLines[i] = line;
			lineImageIds[i] = imageIds;
		}
		newLines = processedLines;

		const fullRender = (clear: boolean): void => {
			this.fullRedrawCount += 1;
			let buffer = "\x1b[?2026h"; // Begin synchronized output
			if (clear) {
				buffer += this.deleteKittyImages(this.previousKittyImageIds);
				buffer += "\x1b[2J\x1b[H\x1b[3J"; // Clear screen, home, then clear scrollback
			}
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				const line = newLines[i]!;
				const isImage = isImageLine(line);
				const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i) : 1;
				if (imageReservedRows > 1 && imageReservedRows <= height) {
					for (let row = 1; row < imageReservedRows; row++) {
						buffer += "\r\n";
					}
					buffer += `\x1b[${imageReservedRows - 1}A`;
					buffer += line;
					buffer += `\x1b[${imageReservedRows - 1}B`;
					i += imageReservedRows - 1;
					continue;
				}
				buffer += line;
			}
			buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			if (clear) {
				this.maxLinesRendered = newLines.length;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			const bufferLength = Math.max(height, newLines.length);
			this.previousViewportTop = Math.max(0, bufferLength - height);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousRawLines = rawLines;
			this.previousLineImageIds = lineImageIds;
			this.previousKittyImageIds = this.unionKittyImageIds(lineImageIds);
			this.previousWidth = width;
			this.previousHeight = height;
		};

		// Scrollback-preserving repaint for the collapse path (dialog/takeover
		// close): rewrite the new frame's visible tail over the screen rows in
		// place, then erase leftover rows below the new content with `\x1b[J`.
		// Nothing is written above the viewport and the screen never scrolls,
		// so the native scrollback survives — unlike fullRender(true), whose
		// home-and-replay would either purge it (`\x1b[3J`) or duplicate the
		// replayed head into it.
		const collapseRender = (): void => {
			this.fullRedrawCount += 1;
			const collapseViewportTop = Math.max(0, newLines.length - height);
			const visible = newLines.slice(collapseViewportTop, collapseViewportTop + height);
			let buffer = "\x1b[?2026h"; // Begin synchronized output
			buffer += this.deleteKittyImages(this.previousKittyImageIds);
			// Move the hardware cursor to the viewport's top screen row. The
			// clamp keeps the cursor inside the screen even if the tracked
			// position drifted above the previous viewport.
			const screenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			if (screenRow > 0) buffer += `\x1b[${screenRow}A`;
			buffer += "\r";
			for (let i = 0; i < visible.length; i++) {
				if (i > 0) buffer += "\r\n";
				const line = visible[i]!;
				const isImage = isImageLine(line);
				const imageReservedRows = isImage ? this.getKittyImageReservedRows(visible, i) : 1;
				if (imageReservedRows > 1 && imageReservedRows <= height) {
					// Reserve (and clear) the image's rows before drawing the
					// placement, mirroring the differential path.
					buffer += "\x1b[2K";
					for (let row = 1; row < imageReservedRows; row++) {
						buffer += "\r\n\x1b[2K";
					}
					buffer += `\x1b[${imageReservedRows - 1}A`;
					buffer += line;
					buffer += `\x1b[${imageReservedRows - 1}B`;
					i += imageReservedRows - 1;
					continue;
				}
				buffer += "\x1b[2K"; // Erase the old row before overwriting it
				buffer += line;
			}
			// Blank leftover rows below the new content. `\x1b[J` erases from
			// the cursor to the end of the screen only — scrollback is untouched.
			if (visible.length < height) {
				buffer += "\x1b[J";
			}
			buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = collapseViewportTop + Math.max(0, visible.length - 1);
			// The screen now holds exactly the new frame's visible region.
			this.maxLinesRendered = newLines.length;
			this.previousViewportTop = collapseViewportTop;
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousRawLines = rawLines;
			this.previousLineImageIds = lineImageIds;
			this.previousKittyImageIds = this.unionKittyImageIds(lineImageIds);
			this.previousWidth = width;
			this.previousHeight = height;
		};

		const debugRedraw = process.env['PI_DEBUG_REDRAW'] === "1";
		const logRedraw = (reason: string): void => {
			if (!debugRedraw) return;
			const logPath = path.join(os.homedir(), ".pi", "agent", "pi-debug.log");
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
			fs.appendFileSync(logPath, msg);
		};

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			fullRender(false);
			return;
		}

		// Width changes always need a full re-render because wrapping changes.
		if (widthChanged) {
			logRedraw(`terminal width changed (${this.previousWidth} -> ${width})`);
			fullRender(true);
			return;
		}

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		if (heightChanged && !isTermuxSession()) {
			logRedraw(`terminal height changed (${this.previousHeight} -> ${height})`);
			fullRender(true);
			return;
		}

		// Collapse repaint (dialog/takeover close): the resize guards above keep
		// their destructive full renders; here the frame history is intact, so
		// repaint the viewport in place and keep the native scrollback.
		if (collapseRequested) {
			logRedraw("collapse repaint");
			collapseRender();
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink() or PI_CLEAR_ON_SHRINK=0 env var
		if (this.clearOnShrink && newLines.length < this.maxLinesRendered && this.overlayStack.length === 0) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			fullRender(true);
			return;
		}

		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		if (firstChanged !== -1) {
			const expandedRange = this.expandChangedRangeForKittyImages(
				firstChanged,
				lastChanged,
				newLines,
				lineImageIds,
			);
			firstChanged = expandedRange.firstChanged;
			lastChanged = expandedRange.lastChanged;
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = prevViewportTop;
			this.previousHeight = height;
			// Processed output is unchanged, but keep the raw/image-id caches in
			// sync so future frames keep hitting the reuse fast path (e.g. the
			// cursor-marker line gets a fresh string every frame).
			this.previousRawLines = rawLines;
			this.previousLineImageIds = lineImageIds;
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				let buffer = "\x1b[?2026h";
				buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
				const targetRow = Math.max(0, newLines.length - 1);
				if (targetRow < prevViewportTop) {
					logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
					fullRender(true);
					return;
				}
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
				else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
				buffer += "\r";
				// Clear extra lines without scrolling
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					fullRender(true);
					return;
				}
				const clearStartOffset = newLines.length === 0 ? 0 : 1;
				if (extraLines > 0 && clearStartOffset > 0) {
					buffer += `\x1b[${clearStartOffset}B`;
				}
				for (let i = 0; i < extraLines; i++) {
					buffer += "\r\x1b[2K";
					if (i < extraLines - 1) buffer += "\x1b[1B";
				}
				const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
				if (moveBack > 0) {
					buffer += `\x1b[${moveBack}A`;
				}
				buffer += "\x1b[?2026l";
				this.terminal.write(buffer);
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousRawLines = rawLines;
			this.previousLineImageIds = lineImageIds;
			this.previousKittyImageIds = this.unionKittyImageIds(lineImageIds);
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			return;
		}

		// Differential rendering can only touch what was actually visible.
		// If the first changed line is above the previous viewport, we need a full redraw.
		if (firstChanged < prevViewportTop) {
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
			fullRender(true);
			return;
		}

		// Render from first changed line to end
		let buffer = "\x1b[?2026h"; // Begin synchronized output
		buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				buffer += `\x1b[${moveToBottom}B`;
			}
			const scroll = moveTargetRow - prevViewportBottom;
			buffer += "\r\n".repeat(scroll);
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`; // Move down
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`; // Move up
		}

		buffer += appendStart ? "\r\n" : "\r"; // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			const line = newLines[i]!;
			const isImage = isImageLine(line);
			const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i, renderEnd) : 1;
			if (imageReservedRows > 1) {
				const imageStartScreenRow = i - viewportTop;
				if (imageStartScreenRow < 0 || imageStartScreenRow + imageReservedRows > height) {
					logRedraw(
						`kitty image pre-clear would scroll (${imageStartScreenRow} + ${imageReservedRows} > ${height})`,
					);
					fullRender(true);
					return;
				}

				buffer += "\x1b[2K";
				for (let row = 1; row < imageReservedRows; row++) {
					buffer += "\r\n\x1b[2K";
				}
				buffer += `\x1b[${imageReservedRows - 1}A`;
				buffer += line;
				buffer += `\x1b[${imageReservedRows - 1}B`;
				i += imageReservedRows - 1;
				continue;
			}

			buffer += "\x1b[2K"; // Clear current line
			buffer += line;
		}

		let finalCursorRow = renderEnd;

		// If we had more lines before, clear them and move cursor back
		if (this.previousLines.length > newLines.length) {
			// Move to end of new content first if we stopped before it
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				buffer += `\x1b[${moveDown}B`;
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				buffer += "\r\n\x1b[2K";
			}
			// Move cursor back to end of new content
			buffer += `\x1b[${extraLines}A`;
		}

		buffer += "\x1b[?2026l"; // End synchronized output

		if (process.env['PI_TUI_DEBUG'] === "1") {
			const debugDir = "/tmp/tui";
			fs.mkdirSync(debugDir, { recursive: true });
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			const debugData = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${newLines.length}`,
				`previousLines.length: ${this.previousLines.length}`,
				"",
				"=== newLines ===",
				JSON.stringify(newLines, null, 2),
				"",
				"=== previousLines ===",
				JSON.stringify(this.previousLines, null, 2),
				"",
				"=== buffer ===",
				JSON.stringify(buffer),
			].join("\n");
			fs.writeFileSync(debugPath, debugData);
		}

		this.terminal.write(buffer);

		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

		// Position hardware cursor for IME
		this.positionHardwareCursor(cursorPos, newLines.length);

		this.previousLines = newLines;
		this.previousRawLines = rawLines;
		this.previousLineImageIds = lineImageIds;
		this.previousKittyImageIds = this.unionKittyImageIds(lineImageIds);
		this.previousWidth = width;
		this.previousHeight = height;
	}

	/**
	 * Position the hardware cursor for IME candidate window.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param totalLines Total number of rendered lines
	 */
	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		if (!cursorPos || totalLines <= 0) {
			this.terminal.hideCursor();
			return;
		}

		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		buffer += `\x1b[${targetCol + 1}G`;

		if (buffer) {
			this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		if (this.showHardwareCursor) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}

	/**
	 * Query the terminal's default background color with OSC 11 (`ESC ] 11 ; ? BEL`).
	 * @param timeoutMs Query timeout in milliseconds.
	 * @returns Promise containing the parsed RGB color, or undefined if it times out or fails to parse.
	 */
	queryTerminalBackgroundColor({ timeoutMs }: { timeoutMs: number }): Promise<RgbColor | undefined> {
		return new Promise((resolve) => {
			const query: PendingOsc11BackgroundQuery = {
				settled: false,
				resolve,
				timer: undefined,
			};

			query.timer = setTimeout(() => {
				if (query.settled) {
					return;
				}
				query.settled = true;
				query.timer = undefined;
				query.resolve?.(undefined);
				query.resolve = undefined;
			}, timeoutMs);
			this.pendingOsc11BackgroundQueries.push(query);
			this.pendingOsc11BackgroundReplies += 1;
			this.terminal.write("\x1b]11;?\x07");
		});
	}

	/**
	 * Query the terminal's color-scheme preference with DSR (`CSI ? 996 n`).
	 * Terminals that support the color palette notification protocol reply with
	 * `CSI ? 997 ; 1 n` for dark or `CSI ? 997 ; 2 n` for light.
	 */
	queryTerminalColorScheme({ timeoutMs }: { timeoutMs: number }): Promise<TerminalColorScheme | undefined> {
		return new Promise((resolve) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			let unsubscribe: () => void = () => {};
			const settle = (scheme: TerminalColorScheme | undefined) => {
				if (settled) return;
				settled = true;
				if (timer) {
					clearTimeout(timer);
					timer = undefined;
				}
				unsubscribe();
				resolve(scheme);
			};

			unsubscribe = this.onTerminalColorSchemeChange(settle);
			timer = setTimeout(() => settle(undefined), timeoutMs);
			this.terminal.write("\x1b[?996n");
		});
	}
}

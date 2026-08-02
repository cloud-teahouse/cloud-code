/**
 * Declarative hit zones — the mouse counterpart of the Component render
 * contract.
 *
 * A component declares the interactive regions of its rendered output as
 * {@link HitZone}s instead of re-deriving "my Nth row / Mth column is at
 * screen position X" inside `handleMouse`. The TUI translates terminal
 * coordinates into the focused component's frame (slot chrome, container
 * gutters, and slot-top clipping already accounted for) and then consults the
 * zones: a left-press inside an `action` zone is dispatched to the owner's
 * `onHitZone(id, event)`, and pointer motion across `hover` zones is tracked
 * centrally, notifying the owner's `setHoveredZone(id | null)` on every
 * enter/leave so it can render a hover affordance. Components that declare no
 * zones keep the raw `handleMouse` path unchanged.
 *
 * Zones use the same coordinate space as translated mouse events: `row` is
 * 0-based from the component's first rendered line, `col` is 1-based from its
 * first content cell (a click on a container's left gutter arrives as col 0
 * and therefore never matches a zone). Zones must be a pure function of the
 * state `render()` reads — caching them as a render by-product is fine since
 * a render always runs before input is dispatched.
 *
 * Composition: a component that implements `hitZones` owns hit-testing for
 * its whole subtree. A {@link Container} without its own `hitZones` composes
 * its children's zones into its own frame — row offsets accumulate over
 * sibling heights plus the container's `rowsBeforeChild` chrome, column
 * offsets over its `leftInset` gutter — and {@link resolveHitZones} records
 * the declaring component as the zone's owner, so dispatch and hover
 * notifications reach the child that understands the zone id, with the event
 * re-translated into that child's own frame.
 */

import { Container, type Component } from "./tui.ts";

/** Identifier of a hit zone, meaningful to the component that declared it. */
export type HitZoneId = string | number;

/** Which interactions a zone participates in; both default to true. */
export interface HitZoneSemantics {
	/** Dispatch left-presses landing in this zone to the owner's onHitZone. */
	readonly action?: boolean;
	/** Track the pointer over this zone via the owner's setHoveredZone. */
	readonly hover?: boolean;
}

/**
 * One interactive region of a component's rendered output, in the component's
 * own frame (row 0-based, col 1-based — see the module doc).
 */
export interface HitZone {
	readonly id: HitZoneId;
	/** 0-based row of the zone's first line. */
	readonly row: number;
	/** 1-based column of the zone's first cell. */
	readonly col: number;
	/** Width in cells. */
	readonly width: number;
	/** Height in rows. */
	readonly height: number;
	readonly semantics?: HitZoneSemantics;
}

/**
 * A zone resolved into the coordinate frame of the component the TUI queried
 * (the focused one), with its dispatch target attached. `semantics` is
 * normalized and capability-aware: `action` is only true when the owner
 * implements `onHitZone`, `hover` only when it implements `setHoveredZone` —
 * a zone whose owner cannot handle an interaction is transparent to it, so
 * the event falls back to the legacy `handleMouse` path. `rowOffset` /
 * `colOffset` map the querying frame back to the owner's own frame.
 */
export interface ResolvedHitZone extends HitZone {
	readonly owner: Component;
	readonly semantics: Required<HitZoneSemantics>;
	readonly rowOffset: number;
	readonly colOffset: number;
}

/**
 * Whether `root` or any descendant declares hit zones. Cheap structural
 * pre-check (no rendering) used by the TUI to keep the legacy fast path for
 * zone-less components.
 */
export function hasHitZones(root: Component): boolean {
	if (root.hitZones !== undefined) return true;
	if (root instanceof Container) return root.children.some(hasHitZones);
	return false;
}

/**
 * Resolve the hit zones of `root`'s subtree into `root`'s own frame. Zones a
 * component declares via `hitZones` are taken as-is; a container without its
 * own `hitZones` composes its children's zones, accumulating each child's row
 * offset (preceding siblings' rendered heights at `width`, plus the
 * container's {@link Container.rowsBeforeChild} chrome) and column offset
 * (the container's {@link Container.leftInset} gutter).
 */
export function resolveHitZones(root: Component, width: number): ResolvedHitZone[] {
	const resolved: ResolvedHitZone[] = [];
	collectHitZones(root, width, 0, 0, resolved);
	return resolved;
}

function collectHitZones(
	component: Component,
	width: number,
	rowOffset: number,
	colOffset: number,
	out: ResolvedHitZone[],
): void {
	if (component.hitZones !== undefined) {
		for (const zone of component.hitZones()) {
			out.push({
				owner: component,
				id: zone.id,
				row: zone.row + rowOffset,
				col: zone.col + colOffset,
				width: zone.width,
				height: zone.height,
				semantics: {
					action: zone.semantics?.action !== false && component.onHitZone !== undefined,
					hover: zone.semantics?.hover !== false && component.setHoveredZone !== undefined,
				},
				rowOffset,
				colOffset,
			});
		}
		return;
	}
	if (component instanceof Container) {
		let acc = rowOffset;
		for (const child of component.children) {
			const base = acc + component.rowsBeforeChild(child);
			collectHitZones(child, width, base, colOffset + component.leftInset(), out);
			acc = base + child.render(width).length;
		}
	}
}

/**
 * The first zone containing (`row`, `col`) that participates in `kind`, or
 * null. Declaration order wins when zones overlap.
 */
export function hitZoneAt<Z extends HitZone>(
	zones: Iterable<Z>,
	row: number,
	col: number,
	kind: keyof Required<HitZoneSemantics>,
): Z | null {
	for (const zone of zones) {
		if (zone.semantics?.[kind] === false) continue;
		if (row < zone.row || row >= zone.row + zone.height) continue;
		if (col < zone.col || col >= zone.col + zone.width) continue;
		return zone;
	}
	return null;
}

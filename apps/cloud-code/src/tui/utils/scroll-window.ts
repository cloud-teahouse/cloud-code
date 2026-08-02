/**
 * Shared scroll-window math for list/detail surfaces (takeover browsers).
 *
 * Both helpers are pure: render derives its window from them without
 * mutating state, and the input/scroll handlers apply them to normalize the
 * stored scroll before and after a selection or content change.
 */

/**
 * The scroll window that keeps `selected` visible, clamped to the item
 * count — a pure function: render derives its window from it without
 * mutating state, and the input/scroll handlers apply it to normalize the
 * stored scroll before and after a selection change (exactly what the
 * render sandwich did when render owned the adjustment).
 */
export function scrolledToSelection(
  scroll: number,
  selected: number,
  visibleRows: number,
  itemCount: number,
): number {
  if (visibleRows <= 0) return 0;
  let next = scroll;
  if (selected < next) {
    next = selected;
  } else if (selected >= next + visibleRows) {
    next = selected - visibleRows + 1;
  }
  const maxScroll = Math.max(0, itemCount - visibleRows);
  return Math.max(0, Math.min(next, maxScroll));
}

export interface FollowScroll {
  readonly scroll: number;
  readonly follow: boolean;
}

/**
 * Tail-pinned scroll window, pure: `follow` pins to the tail of the content;
 * otherwise the position clamps against the content height and re-engages
 * follow once it reaches the bottom.
 */
export function followScroll(state: FollowScroll, contentRows: number, visibleRows: number): FollowScroll {
  const maxScroll = Math.max(0, contentRows - visibleRows);
  if (state.follow) return { scroll: maxScroll, follow: true };
  const scroll = Math.max(0, Math.min(state.scroll, maxScroll));
  return { scroll, follow: scroll >= maxScroll };
}

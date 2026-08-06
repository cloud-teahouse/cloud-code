/**
 * TakeoverNoticeMirror — renders the slot's current transient notice while a
 * full-screen takeover (tasks/workflows/teams browser, approval preview) owns
 * the screen. A takeover swaps the real layout out of ui.children, so the
 * notice row would otherwise render invisibly until the takeover closes.
 *
 * The mirror never holds state: it re-renders whatever component currently
 * sits in the notice container, which stays the single source of truth for
 * replacement and the auto-clear timer. Mounted once as a non-capturing
 * bottom-anchored overlay gated on "takeover active AND a notice exists".
 */

import type { Component } from '@cloud-code/pi-tui';

interface TakeoverNoticeSource {
  readonly noticeContainer: {
    readonly children: readonly Component[];
  };
}

export class TakeoverNoticeMirror implements Component {
  constructor(private readonly source: TakeoverNoticeSource) {}

  render(width: number): string[] {
    const notice = this.source.noticeContainer.children[0];
    if (notice === undefined) return [];
    return notice.render(width);
  }

  invalidate(): void {
    this.source.noticeContainer.children[0]?.invalidate();
  }
}

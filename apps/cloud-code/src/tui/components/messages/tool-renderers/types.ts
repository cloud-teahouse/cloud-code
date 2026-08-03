import type { Component } from '@cloud-code/pi-tui';

import { RESULT_PREVIEW_LINES } from '#/tui/constant/rendering';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

export interface RendererContext {
  readonly expanded: boolean;
}

export interface ResultRenderer {
  (toolCall: ToolCallBlockData, result: ToolResultBlockData, ctx: RendererContext): Component[];
  /**
   * Present on renderers whose collapsed body hides content that expansion
   * reveals (e.g. the summary renderers, which show nothing until expanded).
   * ToolCallComponent uses it to decide whether the card has anything to
   * expand into — a card with nothing hidden declares no click/hover zone.
   * Renderers that cap by visual rows (TruncatedOutputComponent) report
   * through {@link CollapsedRowProbe} instead, since that depends on width.
   */
  hidesContentWhenCollapsed?: (result: ToolResultBlockData) => boolean;
}

export const PREVIEW_LINES = RESULT_PREVIEW_LINES;

/**
 * Width-aware counterpart of `hidesContentWhenCollapsed`: how many visual
 * rows the component's collapsed cap hides at this render width (0 when it
 * is expanded or everything fits). Containers forward to their inners with
 * the same width reduction their `render` applies, so the answer reuses the
 * wrap cache the render pass just warmed.
 */
export interface CollapsedRowProbe {
  collapsedHiddenRows(width: number): number;
}

/** Reads the probe when the component implements it; 0 otherwise. */
export function collapsedHiddenRows(component: Component, width: number): number {
  const probe = (component as Partial<CollapsedRowProbe>).collapsedHiddenRows;
  return typeof probe === 'function' ? probe.call(component, width) : 0;
}

export function strArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

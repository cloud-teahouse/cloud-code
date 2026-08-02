/**
 * Floating dialog surface: the fullscreen presentation of a dialog-kind
 * editor-slot panel. Wraps the panel in the same chrome the editor slot would
 * paint (chrome gutter + `▔` top separator) and is shown as a bottom-anchored
 * pi-tui overlay, so the dialog floats over the lower transcript rows and the
 * input area instead of replacing the editor (Claude's modal-slot analogue).
 *
 * Focusable facade for the wrapped panel: pi-tui focuses the overlay component
 * itself, so keyboard and mouse input arrive here and are delegated to the
 * panel translated into its own frame (separator row and gutter stripped) —
 * exactly what the panel receives when mounted in the slot. Hit zones need no
 * delegation: the TUI resolves them from the focused component and container
 * composition already accumulates the separator/gutter offsets.
 */

import type { Component, Focusable, MouseEvent } from '@cloud-code/pi-tui';

import { EditorSlotContainer } from './gutter-container';

export class FloatingDialogSurface extends EditorSlotContainer implements Focusable {
  constructor(
    leftPad: number,
    rightPad: number,
    private readonly panel: Component & Focusable,
  ) {
    super(leftPad, rightPad);
    this.topSeparator = true;
    this.addChild(panel);
  }

  get focused(): boolean {
    return this.panel.focused;
  }

  set focused(value: boolean) {
    this.panel.focused = value;
  }

  get wantsKeyRelease(): boolean | undefined {
    return this.panel.wantsKeyRelease;
  }

  handleInput(data: string): void {
    this.panel.handleInput?.(data);
  }

  wantsMouseEvent(event: MouseEvent): boolean {
    return this.panel.wantsMouseEvent?.(this.toPanelEvent(event)) ?? true;
  }

  handleMouse(event: MouseEvent): void | boolean {
    // A press on the separator row has no panel target; motion there (or
    // outside) is forwarded as row -1 so the panel clears its hover state.
    if (event.type === 'press' && event.row < this.rowsBeforeChild(this.panel)) {
      return true;
    }
    return this.panel.handleMouse?.(this.toPanelEvent(event));
  }

  private toPanelEvent(event: MouseEvent): MouseEvent {
    return {
      ...event,
      row: event.row - this.rowsBeforeChild(this.panel),
      col: event.col - this.leftInset(),
    };
  }
}

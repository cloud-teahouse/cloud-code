import { Container, type Component, type SlotClipResult } from '@cloud-code/pi-tui';

/**
 * Slot layers in clipping priority order: `pinned` chrome (editor/footer) and
 * the transient `status` layers (notice/activity/swarm) keep every line;
 * `panel` layers (todo/queue/btw) yield their top lines first when the slot
 * is taller than the screen.
 */
type SlotLayer = 'status' | 'panel' | 'pinned';

/**
 * The fullscreen bottom slot with layer-aware clipping. Everywhere except the
 * fullscreen composer's overflow path this renders as a plain Container;
 * `renderSlot` is the layered clip: walking bottom-up, pinned and status
 * segments keep their lines while panels take whatever budget remains
 * (bottom-most panel first), each top-clipped inside its own segment. When
 * even status + pinned overflow, the assembled view is flat top-clipped —
 * the pre-layering outcome. The returned lineMap keeps mouse hit-tests in the
 * full-render coordinate space.
 */
export class LayeredSlotContainer extends Container {
  private readonly layers = new Map<Component, SlotLayer>();

  /** Classify a direct child; unclassified children default to `panel`. */
  setLayer(child: Component, layer: SlotLayer): void {
    this.layers.set(child, layer);
  }

  renderSlot(width: number, maxLines: number): SlotClipResult {
    const segments = this.children.map((child) => ({
      layer: this.layers.get(child) ?? 'panel',
      lines: child.render(width),
    }));

    // Panels share what the uncut layers leave behind, bottom-most first.
    const uncutLines = segments.reduce(
      (total, segment) => (segment.layer === 'panel' ? total : total + segment.lines.length),
      0,
    );
    let panelBudget = Math.max(0, maxLines - uncutLines);
    const keep = segments.map((segment) => (segment.layer === 'panel' ? 0 : segment.lines.length));
    for (let i = segments.length - 1; i >= 0 && panelBudget > 0; i--) {
      const segment = segments[i]!;
      if (segment.layer !== 'panel') continue;
      const take = Math.min(segment.lines.length, panelBudget);
      keep[i] = take;
      panelBudget -= take;
    }

    const lines: string[] = [];
    const lineMap: number[] = [];
    let base = 0;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      const kept = keep[i]!;
      for (let j = segment.lines.length - kept; j < segment.lines.length; j++) {
        lines.push(segment.lines[j]!);
        lineMap.push(base + j);
      }
      base += segment.lines.length;
    }

    if (lines.length > maxLines) {
      const drop = lines.length - maxLines;
      lines.splice(0, drop);
      lineMap.splice(0, drop);
    }
    return { lines, lineMap };
  }
}

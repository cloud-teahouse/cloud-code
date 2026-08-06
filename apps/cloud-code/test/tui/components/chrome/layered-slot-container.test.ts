import { Text } from '@cloud-code/pi-tui';
import { describe, expect, it } from 'vitest';

import { LayeredSlotContainer } from '#/tui/components/chrome/layered-slot-container';

const WIDTH = 80;

function block(prefix: string, count: number): Text {
  return new Text(
    Array.from({ length: count }, (_, i) => `${prefix}${i}`).join('\n'),
    0,
    0,
  );
}

/**
 * Layout under test: status (notice 2 / activity 2 / swarm 2), panels
 * (todo 5 / queue 4 / btw 3), pinned (editor 3 / footer 1) — 22 lines total.
 */
function buildSlot(): LayeredSlotContainer {
  const slot = new LayeredSlotContainer();
  const add = (prefix: string, count: number, layer: 'status' | 'panel' | 'pinned') => {
    const child = block(prefix, count);
    slot.addChild(child);
    slot.setLayer(child, layer);
  };
  add('notice', 2, 'status');
  add('activity', 2, 'status');
  add('swarm', 2, 'status');
  add('todo', 5, 'panel');
  add('queue', 4, 'panel');
  add('btw', 3, 'panel');
  add('editor', 3, 'pinned');
  add('footer', 1, 'pinned');
  return slot;
}

describe('LayeredSlotContainer', () => {
  it('returns every line with an identity map when the slot fits', () => {
    const slot = buildSlot();
    const { lines, lineMap } = slot.renderSlot(WIDTH, 25);
    expect(lines).toHaveLength(22);
    expect(lineMap).toEqual(Array.from({ length: 22 }, (_, i) => i));
  });

  it('clips panels bottom-up and keeps status and pinned intact', () => {
    const slot = buildSlot();
    // Status + pinned = 10, so the three panels share 5 lines: btw keeps all
    // 3, queue keeps its bottom 2, todo drops entirely.
    const { lines: rawLines, lineMap } = slot.renderSlot(WIDTH, 15);
    const lines = rawLines.map((line) => line.trimEnd());
    expect(lines).toEqual([
      'notice0',
      'notice1',
      'activity0',
      'activity1',
      'swarm0',
      'swarm1',
      'queue2',
      'queue3',
      'btw0',
      'btw1',
      'btw2',
      'editor0',
      'editor1',
      'editor2',
      'footer0',
    ]);
    // Full-render bases: notice 0, activity 2, swarm 4, todo 6, queue 11,
    // btw 15, editor 18, footer 21.
    expect(lineMap).toEqual([0, 1, 2, 3, 4, 5, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  });

  it('top-clips a panel that partially fits', () => {
    const slot = buildSlot();
    // Panels share 3 lines: btw keeps its bottom 3, todo and queue drop.
    const { lines: rawLines, lineMap } = slot.renderSlot(WIDTH, 13);
    const lines = rawLines.map((line) => line.trimEnd());
    expect(lines.slice(6, 9)).toEqual(['btw0', 'btw1', 'btw2']);
    expect(lineMap.slice(6, 9)).toEqual([15, 16, 17]);
    expect(lines).toHaveLength(13);
  });

  it('falls back to a flat top-clip when status + pinned alone overflow', () => {
    const slot = buildSlot();
    // Status + pinned = 10 > 8: panels vanish and the assembled block is
    // top-clipped flat, matching the pre-layering behavior.
    const { lines: rawLines, lineMap } = slot.renderSlot(WIDTH, 8);
    const lines = rawLines.map((line) => line.trimEnd());
    expect(lines).toEqual([
      'activity0',
      'activity1',
      'swarm0',
      'swarm1',
      'editor0',
      'editor1',
      'editor2',
      'footer0',
    ]);
    expect(lineMap).toEqual([2, 3, 4, 5, 18, 19, 20, 21]);
  });
});

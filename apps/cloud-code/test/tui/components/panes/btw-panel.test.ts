// BtwPanelComponent wheel scrolling — hover-to-scroll pans the conversation
// with the same follow-tail semantics as the ↑/↓ scroll keys.

import { describe, expect, it } from 'vitest';

import { BtwPanelComponent } from '#/tui/components/panes/btw-panel';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';

function makePanel(terminalRows = 12): BtwPanelComponent {
  return new BtwPanelComponent({
    markdownTheme: createMarkdownTheme(),
    canUseScrollKeys: () => true,
    onPrompt: () => {},
    terminalRows: () => terminalRows,
  });
}

const wheel = (button: 64 | 65) => ({
  type: 'wheel' as const,
  button,
  col: 1,
  row: 1,
  slotRelative: true,
});

describe('BtwPanelComponent wheel scrolling', () => {
  it('pans three rows per tick and re-engages follow-tail at the bottom', () => {
    const panel = makePanel(12);
    // Fill the panel well past its collapsed body limit (~rows/3).
    for (let i = 0; i < 10; i++) {
      panel.submit(`question-${i}`);
      panel.appendAnswer(`answer line ${i}a\nanswer line ${i}b\nanswer line ${i}c\n`);
      panel.markDone();
    }
    const full = panel.render(100).join('\n');

    // At the tail by default (followTail). Wheel up pans three rows.
    panel.handleMouse(wheel(64));
    const scrolledUp = panel.render(100).join('\n');
    expect(scrolledUp).not.toBe(full);

    // Wheel back down to the tail re-engages following.
    panel.handleMouse(wheel(65));
    panel.handleMouse(wheel(65));
    expect(panel.render(100).join('\n')).toBe(full);

    // New content while unfollowed stays out of view; at the tail it follows.
    panel.handleMouse(wheel(64));
    panel.appendAnswer('fresh line');
    const unfollowed = panel.render(100).join('\n');
    expect(unfollowed).not.toContain('fresh line');
    panel.handleMouse(wheel(65));
    panel.handleMouse(wheel(65));
    expect(panel.render(100).join('\n')).toContain('fresh line');
  });

  it('ignores wheel when the body fits without scrolling', () => {
    const panel = makePanel(30);
    panel.submit('q');
    panel.appendAnswer('short answer');
    const before = panel.render(100).join('\n');
    panel.handleMouse(wheel(64));
    panel.handleMouse(wheel(65));
    expect(panel.render(100).join('\n')).toBe(before);
  });
});

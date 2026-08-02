import { describe, expect, it } from 'vitest';

import { TurnCompletionComponent } from '#/tui/components/messages/turn-completion';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('TurnCompletionComponent', () => {
  it('renders one blank line followed by the completion line', () => {
    const component = new TurnCompletionComponent('✻ Cogitated for 10s');

    const lines = component.render(120).map((line) => strip(line));
    expect(lines[0]).toBe('');
    expect(lines[1]).toContain('✻ Cogitated for 10s');
  });

  it('re-renders the same content after invalidate (theme refresh)', () => {
    const component = new TurnCompletionComponent('✢ 忙活了 3 秒');
    component.invalidate();

    const text = component
      .render(120)
      .map((line) => strip(line))
      .join('\n');
    expect(text).toContain('✢ 忙活了 3 秒');
  });

  it('aligns the symbol with the dialog ● bullet column and the text with the dialog text column', () => {
    const component = new TurnCompletionComponent('✻ Cogitated for 10s');

    const lines = component.render(120).map((line) => strip(line));
    // Flush left: the symbol sits on the bullet column (0), the text on the
    // message text column (2) — no leading indent.
    expect(lines[1]).toMatch(/^✻ Cogitated/u);
  });
});

import { describe, expect, it } from 'vitest';

import { darkColors, lightColors } from '#/tui/theme';

const HEX = /^#[0-9a-fA-F]{6}$/;

describe('ColorPalette hover tokens', () => {
  it('defines hoverBackground in both built-in themes as a valid hex', () => {
    expect(darkColors.hoverBackground).toMatch(HEX);
    expect(lightColors.hoverBackground).toMatch(HEX);
  });

  it('keeps the hover background distinct from the selection fill', () => {
    // Hover must never read as selected (primary) or as the user-echo block.
    for (const palette of [darkColors, lightColors]) {
      expect(palette.hoverBackground).not.toBe(palette.primary);
      expect(palette.hoverBackground).not.toBe(palette.userMessageBackground);
    }
  });

  it('keeps both palettes token-aligned (every token present in both)', () => {
    expect(Object.keys(darkColors).sort()).toEqual(Object.keys(lightColors).sort());
  });
});

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

describe('ColorPalette onPrimary token', () => {
  const linearise = (channel: number): number => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex: string): number => {
    const value = Number.parseInt(hex.slice(1), 16);
    return (
      0.2126 * linearise((value >> 16) & 0xff) +
      0.7152 * linearise((value >> 8) & 0xff) +
      0.0722 * linearise(value & 0xff)
    );
  };
  const contrastRatio = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  it('defines onPrimary in both built-in themes as a valid hex', () => {
    expect(darkColors.onPrimary).toMatch(HEX);
    expect(lightColors.onPrimary).toMatch(HEX);
  });

  it('keeps WCAG AA contrast (≥ 4.5:1) against its own primary fill', () => {
    for (const palette of [darkColors, lightColors]) {
      expect(contrastRatio(palette.onPrimary, palette.primary)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

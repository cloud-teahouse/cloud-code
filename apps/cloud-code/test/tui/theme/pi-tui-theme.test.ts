import chalk from 'chalk';
import { afterEach, describe, expect, it } from 'vitest';

import { currentTheme } from '#/tui/theme';
import { darkColors, lightColors } from '#/tui/theme/colors';
import { createScrollIndicatorStyle } from '#/tui/theme/pi-tui-theme';

describe('createScrollIndicatorStyle', () => {
  const previousChalkLevel = chalk.level;
  const previousPalette = currentTheme.palette;

  afterEach(() => {
    chalk.level = previousChalkLevel;
    currentTheme.setPalette(previousPalette);
  });

  it('paints white text on the user-message gray', () => {
    chalk.level = 3;
    const style = createScrollIndicatorStyle();
    expect(style(' ↓ 3 ', false)).toBe(
      chalk.bgHex(darkColors.userMessageBackground).hex('#FFFFFF')(' ↓ 3 '),
    );
  });

  it('lifts the fill toward white on hover', () => {
    chalk.level = 3;
    const style = createScrollIndicatorStyle();
    const base = style(' ↓ 3 ', false);
    const hovered = style(' ↓ 3 ', true);
    expect(hovered).not.toBe(base);
    // #2A2A2A blended 18% toward white lands on #505050.
    expect(hovered).toBe(chalk.bgHex('#505050').hex('#FFFFFF')(' ↓ 3 '));
  });

  it('follows the live palette on a theme switch', () => {
    chalk.level = 3;
    currentTheme.setPalette(lightColors);
    const style = createScrollIndicatorStyle();
    // Light-theme fill is near-white, so the foreground flips to dark.
    expect(style(' ↓ 3 ', false)).toBe(
      chalk.bgHex(lightColors.userMessageBackground).hex('#1A1A1A')(' ↓ 3 '),
    );
    // #E9E9E9 blended 18% toward white lands on #EDEDED — still a light fill.
    expect(style(' ↓ 3 ', true)).toBe(chalk.bgHex('#EDEDED').hex('#1A1A1A')(' ↓ 3 '));
  });
});

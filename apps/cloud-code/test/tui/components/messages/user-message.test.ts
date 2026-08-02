import { resetCapabilitiesCache, setCapabilities, visibleWidth } from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UserMessageComponent } from '#/tui/components/messages/user-message';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('UserMessageComponent', () => {
  afterEach(() => {
    resetCapabilitiesCache();
  });

  it('renders video placeholders as plain text, not inline image escapes', () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });

    const component = new UserMessageComponent(
      'please inspect [video #1 sample.mov]',
      [],
    );

    const out = stripAnsi(component.render(80).join('\n'));

    expect(out).toContain('[video #1 sample.mov]');
    expect(out).not.toContain('\u001B_G');
    expect(out).not.toContain('\u001B]1337;File=');
  });

  it('keeps user lines within very narrow widths', () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });

    const component = new UserMessageComponent('please inspect the attached output', []);

    for (const width of [1, 2, 4, 10, 39]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('does not truncate inline image escape sequences', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });

    // Minimal 2000x1302 PNG bytes so the inline Kitty sequence is long enough
    // to exceed a typical terminal width if treated as visible text.
    const pngSignature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdrLength = new Uint8Array([0x00, 0x00, 0x00, 0x0d]);
    const ihdrType = new Uint8Array([0x49, 0x48, 0x44, 0x52]);
    const widthBytes = new Uint8Array([
      (2000 >> 24) & 0xff,
      (2000 >> 16) & 0xff,
      (2000 >> 8) & 0xff,
      2000 & 0xff,
    ]);
    const heightBytes = new Uint8Array([
      (1302 >> 24) & 0xff,
      (1302 >> 16) & 0xff,
      (1302 >> 8) & 0xff,
      1302 & 0xff,
    ]);
    const rest = new Uint8Array([0x08, 0x02, 0x00, 0x00, 0x00]);
    const bytes = new Uint8Array([
      ...pngSignature,
      ...ihdrLength,
      ...ihdrType,
      ...widthBytes,
      ...heightBytes,
      ...rest,
    ]);

    const attachment: ImageAttachment = {
      id: 1,
      kind: 'image',
      bytes,
      mime: 'image/png',
      width: 2000,
      height: 1302,
      placeholder: '[image #1 (2000×1302)]',
    };

    const component = new UserMessageComponent('', [attachment]);
    const lines = component.render(80);

    const imageLine = lines.find((l) => l.includes('\u001B_G'));
    expect(imageLine).toBeDefined();
    expect(imageLine).not.toContain('\u001B[0m');
    expect(imageLine).not.toContain('…');
    expect(imageLine).toContain('\u001B\\'); // intact Kitty terminator
  });

  it('omits the sparkles bullet when an empty bullet is provided', () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });

    const withBullet = stripAnsi(new UserMessageComponent('hello', []).render(80).join('\n'));
    expect(withBullet).toContain('✨');
    expect(withBullet).toContain('hello');

    const lines = new UserMessageComponent('$ ls', [], '').render(80).map(stripAnsi);
    const contentLine = lines.find((l) => l.includes('$ ls'));
    expect(contentLine).toBeDefined();
    expect(stripAnsi(lines.join('\n'))).not.toContain('✨');
    // The `$` sits at the leading column where the bullet used to be.
    expect(contentLine?.startsWith('$ ls')).toBe(true);
  });

  describe('background block', () => {
    // darkColors.userMessageBackground = #2A2A2A, roleUser = #FFCB6B.
    const BG_OPEN = '\u001B[48;2;42;42;42m';
    const FG_USER_OPEN = '\u001B[38;2;255;203;107m';
    const previousChalkLevel = chalk.level;

    beforeEach(() => {
      chalk.level = 3;
    });

    afterEach(() => {
      chalk.level = previousChalkLevel;
    });

    it('pads the echo to full width with the theme background, keeping ✨ and bold yellow text', () => {
      setCapabilities({ images: null, trueColor: true, hyperlinks: true });

      const lines = new UserMessageComponent('hello world', []).render(40);
      const content = lines.find((l) => l.includes('hello'));
      expect(content).toBeDefined();
      expect(content).toContain(BG_OPEN);
      // Bullet, colour and weight survive inside the painted block.
      expect(content).toContain('✨');
      expect(content).toContain(FG_USER_OPEN);
      expect(content).toContain('\u001B[1m');
      // The background block spans the whole render width.
      expect(visibleWidth(content!)).toBe(40);
      // The spacer row above the echo stays unpainted.
      expect(lines[0]).not.toContain(BG_OPEN);
    });

    it('paints every wrapped row of a multi-line message', () => {
      setCapabilities({ images: null, trueColor: true, hyperlinks: true });

      const long = 'word '.repeat(30).trim();
      const lines = new UserMessageComponent(long, []).render(30);
      const textRows = lines.filter((l) => l.includes('word'));
      expect(textRows.length).toBeGreaterThan(1);
      for (const row of textRows) {
        expect(row).toContain(BG_OPEN);
        expect(visibleWidth(row)).toBe(30);
      }
    });

    it('paints the shell-command echo (empty bullet) with the same background', () => {
      setCapabilities({ images: null, trueColor: true, hyperlinks: true });

      const lines = new UserMessageComponent('$ ls', [], '').render(24);
      const content = lines.find((l) => l.includes('$ ls'));
      expect(content).toBeDefined();
      expect(content).toContain(BG_OPEN);
      expect(visibleWidth(content!)).toBe(24);
      expect(stripAnsi(content!)).not.toContain('✨');
    });
  });
});

import chalk from 'chalk';
import { visibleWidth } from '@cloud-code/pi-tui';
import { afterEach, describe, expect, it } from 'vitest';

import { getActiveLocale, setLocalePreference, t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { renderSearchBox, SEARCH_BOX_ROWS } from '#/tui/utils/search-box';

const ANSI_SGR = /\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

// Restore the concrete locale, not the preference: 'auto' re-runs system
// detection, which may resolve to zh-CN on a Chinese-language machine.
const originalLocale = getActiveLocale();

afterEach(() => {
  setLocalePreference(originalLocale);
});

describe('renderSearchBox', () => {
  it('renders a SEARCH_BOX_ROWS rounded box with a dim placeholder when unfocused and empty', () => {
    setLocalePreference('en');
    const lines = renderSearchBox({ width: 40, query: '', focused: false });

    expect(lines).toHaveLength(SEARCH_BOX_ROWS);
    expect(SEARCH_BOX_ROWS).toBe(3);
    // Rounded border in the unfocused border tone.
    expect(lines[0]).toBe(currentTheme.fg('border', `╭${'─'.repeat(38)}╮`));
    expect(lines[2]).toBe(currentTheme.fg('border', `╰${'─'.repeat(38)}╯`));
    // The placeholder is visible and dimmed; no cursor while unfocused.
    expect(strip(lines[1] ?? '')).toContain('⌕ Search…');
    expect(lines[1]).toContain(currentTheme.fg('textMuted', 'Search…'));
  });

  it('highlights the border and shows an inverse cursor while focused', () => {
    setLocalePreference('en');
    const lines = renderSearchBox({ width: 40, query: 'tur', focused: true });

    expect(lines[0]).toBe(currentTheme.fg('borderFocus', `╭${'─'.repeat(38)}╮`));
    expect(lines[2]).toBe(currentTheme.fg('borderFocus', `╰${'─'.repeat(38)}╯`));
    expect(strip(lines[1] ?? '')).toContain('⌕ tur ');
    // Block cursor at the (append-only) query tail.
    expect(lines[1]).toContain(currentTheme.fg('text', 'tur') + chalk.inverse(' '));
  });

  it('sits the cursor on the first placeholder cell when focused and empty (Claude Code idiom)', () => {
    setLocalePreference('en');
    const lines = renderSearchBox({ width: 40, query: '', focused: true });

    expect(lines[1]).toContain(chalk.inverse('S') + currentTheme.fg('textMuted', 'earch…'));
    expect(strip(lines[1] ?? '')).toContain('⌕ Search…');
  });

  it('shows the active query dimmed when unfocused', () => {
    const lines = renderSearchBox({ width: 40, query: 'needle', focused: false });
    expect(lines[1]).toContain(currentTheme.fg('textMuted', 'needle'));
  });

  it('keeps every row within the width and the tail of an over-long query visible', () => {
    const query = 'a-very-long-query-that-exceeds-the-box-width-by-far';
    for (const focused of [false, true]) {
      const lines = renderSearchBox({ width: 24, query, focused });
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(24);
      }
      const content = strip(lines[1] ?? '');
      expect(content).toContain('…');
      expect(content).toContain('by-far'); // tail kept — the cursor lives at the end
      expect(content).not.toContain('a-very-long');
    }
  });

  it('honours a custom placeholder and the zh-CN locale', () => {
    expect(strip(renderSearchBox({ width: 40, query: '', focused: false, placeholder: 'Type here…' })[1] ?? '')).toContain(
      'Type here…',
    );

    setLocalePreference('zh-CN');
    const lines = renderSearchBox({ width: 40, query: '', focused: false });
    expect(strip(lines[1] ?? '')).toContain(`⌕ ${t('common.searchPlaceholder')}`);
    expect(strip(lines[1] ?? '')).toContain('搜索…');
  });
});

describe('search hint segments', () => {
  it('advertises the `/` and ↑ focus keys when unfocused and the Esc exit when focused', () => {
    setLocalePreference('en');
    expect(t('common.hint.searchFocus')).toBe('/ ↑ search');
    expect(t('common.hint.searchExit')).toBe('Esc back to list');

    setLocalePreference('zh-CN');
    expect(t('common.hint.searchFocus')).toBe('/ ↑ 搜索');
    expect(t('common.hint.searchExit')).toBe('Esc 返回列表');
  });
});

import { visibleWidth } from '@cloud-code/pi-tui';
import { describe, expect, it } from 'vitest';

import { wrapHint, wrapHintText } from '#/tui/utils/hint';

describe('wrapHint', () => {
  it('keeps everything on one line when it fits', () => {
    expect(wrapHint(['↑↓ navigate', 'Enter select', 'Esc cancel'], 80)).toEqual([
      '↑↓ navigate · Enter select · Esc cancel',
    ]);
  });

  it('wraps at segment boundaries when the line overflows', () => {
    const lines = wrapHint(['↑↓ navigate', 'Enter select', 'Alt+E edit', 'Alt+D delete'], 30);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(30);
    }
    // No segment is split mid-token, and nothing is dropped.
    expect(lines.join(' · ')).toBe('↑↓ navigate · Enter select · Alt+E edit · Alt+D delete');
    // Continuation lines do not lead with the separator.
    for (const line of lines.slice(1)) {
      expect(line.startsWith('·')).toBe(false);
    }
  });

  it('wraps zh-CN segments by visible width (double-width characters)', () => {
    const parts = ['Tab 切换服务商', '↑↓ 移动', 'Enter 选择', 'Alt+S 仅本会话', 'Alt+E 编辑', 'Alt+D 删除'];
    const lines = wrapHint(parts, 34);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(34);
    }
    expect(lines.join(' · ')).toBe(parts.join(' · '));
  });

  it('hard-truncates a single segment wider than the line', () => {
    const lines = wrapHint(['a very long single segment that cannot fit'], 12);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(12);
    expect(lines[0]!).toContain('…');
  });

  it('returns one empty line for no parts and floors tiny widths', () => {
    expect(wrapHint([], 10)).toEqual(['']);
    const floored = wrapHint(['abc'], 0);
    expect(floored).toHaveLength(1);
    expect(visibleWidth(floored[0]!)).toBeLessThanOrEqual(1);
  });

  it('wrapHintText re-wraps an already-joined hint on its separator', () => {
    expect(wrapHintText('a · bb · ccc', 7)).toEqual(['a · bb', 'ccc']);
  });

  it('honours a custom separator', () => {
    expect(wrapHint(['↑↓ select', '↵ confirm'], 14, '  ')).toEqual(['↑↓ select', '↵ confirm']);
  });
});

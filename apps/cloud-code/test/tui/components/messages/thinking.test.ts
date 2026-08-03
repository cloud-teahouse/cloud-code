import { visibleWidth, type MouseEvent, type TUI } from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { describe, expect, it, vi } from 'vitest';

import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

const longThinking = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7'].join('\n');

describe('ThinkingComponent', () => {
  it('shows the live spinner header before thinking content', () => {
    const component = new ThinkingComponent('working it out', true, 'live');
    const out = strip(component.render(80).join('\n'));

    expect(out).toContain('⠋ thinking...');
    expect(out).not.toContain('  ⠋ thinking...');
    expect(out).not.toContain(`${STATUS_BULLET}⠋`);
    expect(out).toContain('  working it out');
  });

  it('keeps live thinking height-limited to the tail', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');
    const out = strip(component.render(80).join('\n'));

    expect(out).not.toContain('line1');
    expect(out).not.toContain('line4');
    expect(out).not.toContain('line5');
    expect(out).toContain('line6');
    expect(out).toContain('line7');
    expect(out).not.toContain('ctrl+o to expand');
  });

  it('animates the live spinner and stops on finalize', () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const component = new ThinkingComponent('step', true, 'live', {
      requestRender,
    } as unknown as TUI);

    expect(strip(component.render(80).join('\n'))).toContain('⠋ thinking...');

    vi.advanceTimersByTime(80);
    expect(requestRender).toHaveBeenCalled();
    expect(strip(component.render(80).join('\n'))).toContain('⠙ thinking...');

    component.finalize();
    requestRender.mockClear();
    vi.advanceTimersByTime(160);
    expect(requestRender).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('finalizes in place into a collapsed preview', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');

    component.finalize();

    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('line1');
    expect(out).toContain('line2');
    expect(out).not.toContain('line3');
    expect(out).not.toContain('line4');
    expect(out).toContain('... (5 more lines, ctrl+o to expand)');
  });

  it('expands and collapses after finalization', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');
    component.finalize();

    component.setExpanded(true);
    const expanded = strip(component.render(80).join('\n'));
    expect(expanded).toContain('line7');
    expect(expanded).not.toContain('ctrl+o to expand');

    component.setExpanded(false);
    const collapsed = strip(component.render(80).join('\n'));
    expect(collapsed).not.toContain('line7');
    expect(collapsed).toContain('ctrl+o to expand');
  });

  it('keeps the finalized truncation footer within the requested render width', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');
    component.finalize();

    for (const line of component.render(37)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(37);
    }
  });

  describe('click/hover affordance', () => {
    const mouse = undefined as unknown as MouseEvent;

    it('declares a hit zone only while the folded block hides lines', () => {
      const folded = new ThinkingComponent(longThinking, true);
      folded.render(80);
      expect([...folded.hitZones()]).toHaveLength(1);

      // A block that fits the preview has nothing to expand into.
      const short = new ThinkingComponent('single thought', true);
      short.render(80);
      expect([...short.hitZones()]).toEqual([]);

      // The live tail window is not expansion-controlled: no zone either.
      const live = new ThinkingComponent(longThinking, true, 'live', {
        requestRender: () => {},
      } as unknown as TUI);
      live.render(80);
      expect([...live.hitZones()]).toEqual([]);
      live.dispose();
    });

    it('toggles expansion via clicks on the zone', () => {
      const component = new ThinkingComponent(longThinking, true);
      component.render(80);
      const zone = [...component.hitZones()][0]!;
      expect(strip(component.render(80).join('\n'))).toContain('ctrl+o to expand');

      component.onHitZone(zone.id, mouse);
      const expanded = strip(component.render(80).join('\n'));
      expect(expanded).toContain('line7');
      expect(expanded).not.toContain('ctrl+o to expand');

      // The zone stays while expanded so a click can collapse back.
      expect([...component.hitZones()]).toHaveLength(1);
      component.onHitZone(zone.id, mouse);
      const collapsed = strip(component.render(80).join('\n'));
      expect(collapsed).not.toContain('line7');
      expect(collapsed).toContain('ctrl+o to expand');
    });

    it('whitens the folded block on hover and restores on leave', () => {
      const previousLevel = chalk.level;
      chalk.level = 3;
      try {
        currentTheme.setPalette(darkColors);
        const component = new ThinkingComponent(longThinking, true);
        const normal = component.render(80);
        const zone = [...component.hitZones()][0]!;
        expect(component.setHoveredZone(zone.id)).not.toBe(false);
        const hovered = component.render(80);
        expect(hovered[1]).not.toBe(normal[1]);
        // Referentially stable per hover state (render-cache contract).
        expect(component.render(80)).toBe(hovered);
        expect(component.setHoveredZone(null)).not.toBe(false);
        expect(component.render(80)[1]).toBe(normal[1]);
      } finally {
        chalk.level = previousLevel;
      }
    });

    it('carries the shimmer on the live title only, and freezes on finalize', () => {
      const previousLevel = chalk.level;
      chalk.level = 3;
      try {
        currentTheme.setPalette(darkColors);
        vi.useFakeTimers();
        const component = new ThinkingComponent('a short thought', true, 'live', {
          requestRender: () => {},
        } as unknown as TUI);
        vi.advanceTimersByTime(80);
        const out = component.render(80);
        const titleRow = out[1]!;
        const contentRow = out[2]!;
        expect(strip(titleRow)).toContain('thinking...');
        // The title carries the RGB shimmer wave…
        const titleCodes = new Set(titleRow.match(/\u001B\[38;2;\d+;\d+;\d+m/g) ?? []);
        expect(titleCodes.size).toBeGreaterThan(1);
        // …while the content row stays in its single dim tone.
        const contentCodes = new Set(contentRow.match(/\u001B\[38;2;\d+;\d+;\d+m/g) ?? []);
        expect(contentCodes.size).toBeLessThanOrEqual(1);
        // The wave advances with the spinner tick…
        vi.advanceTimersByTime(80);
        expect(component.render(80)[1]).not.toBe(titleRow);
        // …and freezes with the block once finalized (the title row is gone).
        component.finalize();
        expect(strip(component.render(80).join('\n'))).not.toContain('thinking...');
        component.dispose();
      } finally {
        vi.useRealTimers();
        chalk.level = previousLevel;
      }
    });
  });
});

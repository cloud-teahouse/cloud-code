import type { MouseEvent, TUI } from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { ToolGroupComponent } from '#/tui/components/messages/tool-group';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { darkColors } from '#/tui/theme/colors';

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

function strip(text: string): string {
  return text
    .replaceAll(/\u001B\[[0-9;]*m/g, '')
    .replaceAll(new RegExp(`${ESC}\\]8;;[^${BEL}]*${BEL}`, 'g'), '');
}

function stubTui(): TUI {
  return {
    terminal: { rows: 40 },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function renderText(component: ToolGroupComponent, width = 120): string {
  return strip(component.render(width).join('\n'));
}

/** The header row of the rendered card (row 0 is the leading spacer). */
function headerLine(component: ToolGroupComponent): string {
  return component.render(120)[1] ?? '';
}

function createCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
  ui: TUI,
): ToolCallComponent {
  return new ToolCallComponent({ id, name, args }, undefined, ui);
}

function succeed(tc: ToolCallComponent, id: string, output: string): void {
  tc.setResult({ tool_call_id: id, output, is_error: false });
}

function fail(tc: ToolCallComponent, id: string, output: string): void {
  tc.setResult({ tool_call_id: id, output, is_error: true });
}

describe('ToolGroupComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a running header and one tree row per call', () => {
    const ui = stubTui();
    const group = new ToolGroupComponent('Bash', ui);
    const a = createCall('call_bash_1', 'Bash', { command: 'ls -la' }, ui);
    const b = createCall('call_bash_2', 'Bash', { command: 'npm test' }, ui);

    group.attach('call_bash_1', a);
    group.attach('call_bash_2', b);

    const output = renderText(group);
    expect(output).toContain('Bash ×2 · 2 running…');
    expect(output).toContain('$ ls -la · running…');
    expect(output).toContain('$ npm test · running…');

    group.dispose();
    a.dispose();
    b.dispose();
  });

  it('settles to a done header with per-row chips once results land', () => {
    const ui = stubTui();
    const group = new ToolGroupComponent('Grep', ui);
    const a = createCall('call_grep_1', 'Grep', { pattern: 'foo' }, ui);
    const b = createCall('call_grep_2', 'Grep', { pattern: 'bar' }, ui);

    group.attach('call_grep_1', a);
    group.attach('call_grep_2', b);
    succeed(a, 'call_grep_1', 'one\ntwo\nthree\n');
    succeed(b, 'call_grep_2', 'only\n');

    const output = renderText(group);
    expect(output).toContain(`${STATUS_BULLET}Grep ×2`);
    expect(output).not.toContain('running');
    expect(output).toContain('├─ foo · 3 matches');
    expect(output).toContain('└─ bar · 1 match');

    group.dispose();
    a.dispose();
    b.dispose();
  });

  it('styles command rows with the shell-mode $ prompt and other rows with a dim branch', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const ui = stubTui();
      const bashGroup = new ToolGroupComponent('Bash', ui);
      const a = createCall('call_bash_1', 'Bash', { command: 'ls -la' }, ui);
      const b = createCall('call_bash_2', 'Bash', { command: 'npm test' }, ui);
      bashGroup.attach('call_bash_1', a);
      bashGroup.attach('call_bash_2', b);

      const bashRows = bashGroup.render(120);
      const commandRow = bashRows.find((l) => l.includes('ls -la'));
      expect(commandRow).toBeDefined();
      expect(commandRow!).toContain(`   ${currentTheme.fg('shellMode', '$ ')}`);
      expect(commandRow!).not.toContain('├─');

      const grepGroup = new ToolGroupComponent('Grep', ui);
      const c = createCall('call_grep_1', 'Grep', { pattern: 'foo' }, ui);
      const d = createCall('call_grep_2', 'Grep', { pattern: 'bar' }, ui);
      grepGroup.attach('call_grep_1', c);
      grepGroup.attach('call_grep_2', d);

      const grepRows = grepGroup.render(120);
      const branchRow = grepRows.find((l) => l.includes('foo'));
      expect(branchRow).toBeDefined();
      expect(branchRow!).toContain(currentTheme.fg('textDim', '  ├─ '));

      bashGroup.dispose();
      grepGroup.dispose();
      a.dispose();
      b.dispose();
      c.dispose();
      d.dispose();
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('marks failed calls in the header count and the row tail', () => {
    const ui = stubTui();
    const group = new ToolGroupComponent('Bash', ui);
    const a = createCall('call_bash_1', 'Bash', { command: 'make build' }, ui);
    const b = createCall('call_bash_2', 'Bash', { command: 'make test' }, ui);

    group.attach('call_bash_1', a);
    group.attach('call_bash_2', b);
    succeed(a, 'call_bash_1', 'ok\n');
    fail(b, 'call_bash_2', 'boom\n');

    const output = renderText(group);
    expect(output).toContain('Bash ×2 · 1 failed');
    expect(output).toContain('$ make build');
    expect(output).toContain('$ make test · failed');

    group.dispose();
    a.dispose();
    b.dispose();
  });

  it('uses the all-failed header when every call failed', () => {
    const ui = stubTui();
    const group = new ToolGroupComponent('Glob', ui);
    const a = createCall('call_glob_1', 'Glob', { pattern: '*.ts' }, ui);
    const b = createCall('call_glob_2', 'Glob', { pattern: '*.js' }, ui);

    group.attach('call_glob_1', a);
    group.attach('call_glob_2', b);
    fail(a, 'call_glob_1', 'nope\n');
    fail(b, 'call_glob_2', 'nope\n');

    const output = renderText(group);
    expect(output).toContain('✗ Glob ×2 · failed');
    expect(output).not.toContain('1 failed');

    group.dispose();
    a.dispose();
    b.dispose();
  });

  it('grows live as more same-tool calls attach', () => {
    const ui = stubTui();
    const group = new ToolGroupComponent('Bash', ui);
    const a = createCall('call_bash_1', 'Bash', { command: 'ls' }, ui);
    const b = createCall('call_bash_2', 'Bash', { command: 'pwd' }, ui);
    const c = createCall('call_bash_3', 'Bash', { command: 'whoami' }, ui);

    group.attach('call_bash_1', a);
    group.attach('call_bash_2', b);
    expect(renderText(group)).toContain('Bash ×2');

    group.attach('call_bash_3', c);
    const output = renderText(group);
    expect(output).toContain('Bash ×3');
    expect(output).toContain('$ ls · running…');
    expect(output).toContain('$ pwd · running…');
    expect(output).toContain('$ whoami · running…');

    // Re-attaching the same id is a no-op.
    group.attach('call_bash_3', c);
    expect(renderText(group)).toContain('Bash ×3');
    expect(group.size()).toBe(3);

    group.dispose();
    a.dispose();
    b.dispose();
    c.dispose();
  });

  it('throttles non-phase updates but flushes phase transitions immediately', () => {
    vi.useFakeTimers();
    const ui = stubTui();
    const group = new ToolGroupComponent('Bash', ui);
    const a = createCall('call_bash_1', 'Bash', { command: 'ls' }, ui);
    const b = createCall('call_bash_2', 'Bash', { command: 'pwd' }, ui);

    group.attach('call_bash_1', a);
    group.attach('call_bash_2', b);

    // Streaming args growth is not a phase transition: the row update is
    // throttled.
    a.updateToolCall({ id: 'call_bash_1', name: 'Bash', args: { command: 'ls -la /tmp' } });
    expect(renderText(group)).toContain('$ ls · running…');
    vi.runOnlyPendingTimers();
    expect(renderText(group)).toContain('$ ls -la /tmp · running…');

    // The pending -> done transition renders without waiting for the throttle.
    succeed(a, 'call_bash_1', 'ok\n');
    const output = renderText(group);
    expect(output).toContain('$ ls -la /tmp');
    expect(output).not.toContain('$ ls -la /tmp · running…');
    expect(output).toContain('Bash ×2 · 1 running…');

    group.dispose();
    a.dispose();
    b.dispose();
  });

  it('animates the header while a call is in flight and freezes once all finish', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      vi.useFakeTimers();
      const requestRender = vi.fn();
      const ui = { terminal: { rows: 40 }, requestRender } as unknown as TUI;
      const group = new ToolGroupComponent('Bash', ui);
      const a = createCall('call_bash_1', 'Bash', { command: 'ls' }, ui);
      const b = createCall('call_bash_2', 'Bash', { command: 'pwd' }, ui);
      group.attach('call_bash_1', a);
      group.attach('call_bash_2', b);

      const bright = chalk.hex(darkColors.text)(STATUS_BULLET);
      const dim = chalk.hex(darkColors.textDim).dim(STATUS_BULLET);

      expect(headerLine(group)).toContain(bright);
      // 5 ticks × 100ms = 0.5s → the dim half-phase.
      vi.advanceTimersByTime(500);
      expect(headerLine(group)).toContain(dim);

      succeed(a, 'call_bash_1', 'ok\n');
      // One call still pending: the animation keeps running.
      vi.advanceTimersByTime(500);
      expect(strip(headerLine(group))).toContain('Bash ×2 · 1 running…');

      succeed(b, 'call_bash_2', 'ok\n');
      const doneHeader = headerLine(group);
      expect(doneHeader).toContain(chalk.hex(darkColors.success)(STATUS_BULLET));
      expect(strip(doneHeader)).toContain('Bash ×2');

      // No ticks after completion: the header is byte-identical and nothing
      // requests further renders.
      requestRender.mockClear();
      vi.advanceTimersByTime(2000);
      expect(headerLine(group)).toBe(doneHeader);
      expect(requestRender).not.toHaveBeenCalled();

      group.dispose();
      a.dispose();
      b.dispose();
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('stops refreshing after dispose', () => {
    vi.useFakeTimers();
    // The group gets its own ui mock so the borrowed cards' in-flight header
    // animation ticks (which request renders through the ui they were created
    // with) cannot pollute the assertion.
    const requestRender = vi.fn();
    const groupUi = { terminal: { rows: 40 }, requestRender } as unknown as TUI;
    const cardUi = stubTui();
    const group = new ToolGroupComponent('Bash', groupUi);
    const a = createCall('call_bash_1', 'Bash', { command: 'ls' }, cardUi);
    const b = createCall('call_bash_2', 'Bash', { command: 'pwd' }, cardUi);
    group.attach('call_bash_1', a);
    group.attach('call_bash_2', b);

    group.dispose();
    requestRender.mockClear();
    succeed(a, 'call_bash_1', 'ok\n');
    succeed(b, 'call_bash_2', 'ok\n');
    vi.runOnlyPendingTimers();
    expect(requestRender).not.toHaveBeenCalled();

    a.dispose();
    b.dispose();
  });

  describe('hover and click interaction', () => {
    const prevLevel = chalk.level;
    beforeAll(() => {
      chalk.level = 3;
      currentTheme.setPalette(darkColors);
    });
    afterAll(() => {
      chalk.level = prevLevel;
    });

    const SENTINEL = '\u0001';
    const fgOpen = (token: 'text' | 'textDim' | 'success'): string => {
      const sampled = currentTheme.fg(token, SENTINEL);
      return sampled.slice(0, sampled.indexOf(SENTINEL));
    };
    // Sampled after chalk.level is forced in beforeAll — sampling earlier
    // (at collection time) would capture the colorless sequences.
    let TEXT_OPEN = '';
    let BG_OPEN = '';
    const press: MouseEvent = { type: 'press', button: 0, col: 2, row: 2, slotRelative: false };

    beforeAll(() => {
      TEXT_OPEN = fgOpen('text');
      const sampled = currentTheme.bg('userMessageBackground', SENTINEL);
      BG_OPEN = sampled.slice(0, sampled.indexOf(SENTINEL));
      if (TEXT_OPEN.length === 0 || BG_OPEN.length === 0) {
        throw new Error('theme sampling produced no SGR sequences');
      }
    });

    function makeDoneGroup(): { group: ToolGroupComponent; a: ToolCallComponent; b: ToolCallComponent } {
      const ui = stubTui();
      const group = new ToolGroupComponent('Bash', ui);
      const a = createCall('call_bash_1', 'Bash', { command: 'ls -la' }, ui);
      const b = createCall('call_bash_2', 'Bash', { command: 'npm test' }, ui);
      group.attach('call_bash_1', a);
      group.attach('call_bash_2', b);
      succeed(a, 'call_bash_1', 'alpha\nbeta\n');
      succeed(b, 'call_bash_2', 'gamma\n');
      return { group, a, b };
    }

    it('declares one hit zone covering the group below its spacer', () => {
      const { group, a, b } = makeDoneGroup();
      const lines = group.render(120);
      const zones = [...group.hitZones()];
      expect(zones).toHaveLength(1);
      expect(zones[0]).toMatchObject({ row: 1, col: 1, width: 120, height: lines.length - 1 });
      group.dispose();
      a.dispose();
      b.dispose();
    });

    it('click unfolds into member cards on a gray background and re-folds', () => {
      const { group, a, b } = makeDoneGroup();
      const base = group.render(120);
      expect(strip(base.join('\n'))).toContain('Bash ×2');
      expect(strip(base.join('\n'))).not.toContain('alpha');

      group.onHitZone('card', press);
      const expanded = group.render(120);
      const text = strip(expanded.join('\n'));
      expect(text).toContain('alpha');
      expect(text).toContain('gamma');
      expect(text).toContain('Bash ×2');
      // The gray block covers header and member rows; the leading spacer
      // stays plain. The group header keeps its foreground colors.
      expect(expanded[0]).not.toContain(BG_OPEN);
      for (const line of expanded.slice(1)) {
        expect(line).toContain(BG_OPEN);
      }
      expect(strip(expanded[1]!).trimEnd()).toBe(strip(base[1]!).trimEnd());
      expect(expanded[1]).toContain(fgOpen('success'));

      group.onHitZone('card', press);
      expect(group.render(120)).toEqual(base);
      group.dispose();
      a.dispose();
      b.dispose();
    });

    it('hover whitens the summary rows and restores on leave', () => {
      const { group, a, b } = makeDoneGroup();
      const base = group.render(120);

      group.setHoveredZone('card');
      const hovered = group.render(120);
      expect(hovered[0]).toBe(base[0]); // spacer untouched
      expect(hovered[1]).toBe(base[1]); // header keeps its colors
      expect(strip(hovered.join('\n'))).toBe(strip(base.join('\n')));
      const body = hovered.slice(2).join('\n');
      expect(body).toContain(TEXT_OPEN);
      expect(body).not.toContain('\x1b[2m');
      expect(hovered.join('\n')).not.toContain(BG_OPEN);
      group.setHoveredZone(null);
      expect(group.render(120)).toEqual(base);
      group.dispose();
      a.dispose();
      b.dispose();
    });

    it('setClickExpanded(false) folds an expanded group (collapse-all)', () => {
      const { group, a, b } = makeDoneGroup();
      const base = group.render(120);
      group.setClickExpanded(true);
      expect(strip(group.render(120).join('\n'))).toContain('alpha');
      group.setClickExpanded(false);
      expect(group.render(120)).toEqual(base);
      group.dispose();
      a.dispose();
      b.dispose();
    });
  });
});

import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import { visibleWidth, type MouseEvent, type TUI } from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { setLocalePreference } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { darkColors } from '#/tui/theme/colors';

import { captureProcessWrite } from '../../../helpers/process';

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

function strip(text: string): string {
  return text
    .replaceAll(/\u001B\[[0-9;]*m/g, '')
    .replaceAll(new RegExp(`${ESC}\\]8;;[^${BEL}]*${BEL}`, 'g'), '');
}

function stubTui(rows: number): TUI {
  return {
    terminal: { rows },
    requestRender: () => {},
  } as unknown as TUI;
}

describe('ToolCallComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the shared non-emoji tool status bullet', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_read_marker',
        name: 'Read',
        args: { path: 'foo.ts' },
      },
      {
        tool_call_id: 'call_read_marker',
        output: 'content',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain(`${STATUS_BULLET}Used Read`);
    expect(out).not.toContain(`\u23FA Used Read`);
    expect(out).not.toContain(`${String.fromCodePoint(0x23fa, 0xfe0e)} Used Read`);
  });

  describe('detach hint for long-running foreground Bash/Agent', () => {
    it('shows the Ctrl+B hint after 10s for a running Bash call', () => {
      vi.useFakeTimers();
      const component = new ToolCallComponent(
        { id: 'call_bash_long', name: 'Bash', args: { command: 'sleep 30' } },
        undefined,
        stubTui(30),
      );

      expect(strip(component.render(100).join('\n'))).not.toContain(
        'Press Ctrl+B to run in background',
      );

      vi.advanceTimersByTime(10_000);
      expect(strip(component.render(100).join('\n'))).toContain(
        'Press Ctrl+B to run in background',
      );

      component.dispose();
    });

    it('shows the hint immediately for a running Agent call', () => {
      vi.useFakeTimers();
      const component = new ToolCallComponent(
        { id: 'call_agent_long', name: 'Agent', args: { description: 'explore' } },
        undefined,
        stubTui(30),
      );

      // No timer advancement — Agents advertise Ctrl+B immediately.
      expect(strip(component.render(100).join('\n'))).toContain(
        'Press Ctrl+B to run in background',
      );

      component.dispose();
    });

    it('does not show the hint for non-detachable tools', () => {
      vi.useFakeTimers();
      const component = new ToolCallComponent(
        { id: 'call_read_long', name: 'Read', args: { path: 'foo.ts' } },
        undefined,
        stubTui(30),
      );

      vi.advanceTimersByTime(15_000);
      expect(strip(component.render(100).join('\n'))).not.toContain(
        'Press Ctrl+B to run in background',
      );

      component.dispose();
    });

    it('does not show the hint when the result lands before 10s', () => {
      vi.useFakeTimers();
      const component = new ToolCallComponent(
        { id: 'call_bash_short', name: 'Bash', args: { command: 'echo hi' } },
        undefined,
        stubTui(30),
      );

      vi.advanceTimersByTime(5_000);
      component.setResult({ tool_call_id: 'call_bash_short', output: 'hi', is_error: false });
      vi.advanceTimersByTime(10_000);

      expect(strip(component.render(100).join('\n'))).not.toContain(
        'Press Ctrl+B to run in background',
      );

      component.dispose();
    });
  });

  describe('running header animation (blink ● + shimmer title)', () => {
    /** The header row of the rendered card (row 0 is the leading spacer). */
    function headerLine(component: ToolCallComponent): string {
      return component.render(100)[1] ?? '';
    }

    function animatedStubTui(requestRender: () => void): TUI {
      return {
        terminal: { rows: 30 },
        requestRender,
      } as unknown as TUI;
    }

    it('blinks the bullet bright/dim on a 0.5s cadence while running', () => {
      const previousLevel = chalk.level;
      chalk.level = 3;
      try {
        vi.useFakeTimers();
        // The blink phase is wall-clock derived: t=0 is the bright half.
        vi.setSystemTime(0);
        const component = new ToolCallComponent(
          { id: 'call_blink', name: 'Read', args: { path: 'foo.ts' } },
          undefined,
          animatedStubTui(() => {}),
        );
        const bright = chalk.hex(darkColors.text)(STATUS_BULLET);
        const dim = chalk.hex(darkColors.textDim).dim(STATUS_BULLET);

        expect(headerLine(component)).toContain(bright);
        expect(headerLine(component)).not.toContain(dim);

        // +0.5s → the dim half-phase.
        vi.advanceTimersByTime(500);
        expect(headerLine(component)).toContain(dim);
        expect(headerLine(component)).not.toContain(bright);

        // Another 0.5s → back to bright.
        vi.advanceTimersByTime(500);
        expect(headerLine(component)).toContain(bright);
        expect(headerLine(component)).not.toContain(dim);

        component.dispose();
      } finally {
        chalk.level = previousLevel;
      }
    });

    it('sweeps the shimmer wave across the running title text', () => {
      const previousLevel = chalk.level;
      chalk.level = 3;
      try {
        vi.useFakeTimers();
        const component = new ToolCallComponent(
          { id: 'call_shimmer', name: 'Read', args: { path: 'foo.ts' } },
          undefined,
          animatedStubTui(() => {}),
        );

        // Wavefront inside the title (frame 10 of a 19-char title): some
        // characters lift toward textStrong, the rest sit at textDim.
        vi.advanceTimersByTime(1000);
        const waved = headerLine(component);
        expect(strip(waved)).toContain('Using Read (foo.ts)');
        const codes = new Set(waved.match(/\u001B\[38;2;\d+;\d+;\d+m/g) ?? []);
        expect(codes.size).toBeGreaterThan(1);

        // The wave travels with the animation tick.
        vi.advanceTimersByTime(100);
        expect(headerLine(component)).not.toBe(waved);

        component.dispose();
      } finally {
        chalk.level = previousLevel;
      }
    });

    it('freezes bullet and title once the result lands', () => {
      const previousLevel = chalk.level;
      chalk.level = 3;
      try {
        vi.useFakeTimers();
        const component = new ToolCallComponent(
          { id: 'call_freeze', name: 'Read', args: { path: 'foo.ts' } },
          undefined,
          animatedStubTui(() => {}),
        );

        vi.advanceTimersByTime(300);
        component.setResult({ tool_call_id: 'call_freeze', output: 'ok', is_error: false });
        const doneHeader = headerLine(component);
        expect(strip(doneHeader)).toContain('Used Read (foo.ts)');
        expect(doneHeader).toContain(chalk.hex(darkColors.success)(STATUS_BULLET));

        // No tick rebuilds after completion: the header is byte-identical.
        vi.advanceTimersByTime(2000);
        expect(headerLine(component)).toBe(doneHeader);

        component.dispose();
      } finally {
        chalk.level = previousLevel;
      }
    });

    it('shimmers the running Agent card title while the braille glyph keeps its own animation', () => {
      const previousLevel = chalk.level;
      chalk.level = 3;
      try {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const component = new ToolCallComponent(
          { id: 'call_agent_shimmer', name: 'Agent', args: { description: 'explore' } },
          undefined,
          animatedStubTui(() => {}),
        );
        component.onSubagentSpawned({
          agentId: 'sub_agent_shimmer',
          agentName: 'explore',
          runInBackground: false,
        });
        component.onSubagentStarted({
          agentId: 'sub_agent_shimmer',
          agentName: 'explore',
          runInBackground: false,
        });

        // Wavefront inside the title: the label, status word, and description
        // sweep textDim → textStrong.
        vi.advanceTimersByTime(1000);
        const waved = headerLine(component);
        expect(strip(waved)).toContain('Explore Agent Running (explore)');
        const codes = new Set(waved.match(/\u001B\[38;2;\d+;\d+;\d+m/g) ?? []);
        expect(codes.size).toBeGreaterThan(1);

        // The braille marker is not part of the wave: it keeps its own
        // primary-colored animation frame.
        expect(waved).toMatch(/\u001B\[38;2;79;168;255m[\u2800-\u28FF] /);

        // The wave travels with the animation tick.
        vi.advanceTimersByTime(100);
        expect(headerLine(component)).not.toBe(waved);

        component.dispose();
      } finally {
        chalk.level = previousLevel;
      }
    });

    it('freezes the Agent card title once the subagent result lands', () => {
      const previousLevel = chalk.level;
      chalk.level = 3;
      try {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const component = new ToolCallComponent(
          { id: 'call_agent_freeze', name: 'Agent', args: { description: 'explore' } },
          undefined,
          animatedStubTui(() => {}),
        );
        component.onSubagentSpawned({
          agentId: 'sub_agent_freeze',
          agentName: 'explore',
          runInBackground: false,
        });
        component.onSubagentStarted({
          agentId: 'sub_agent_freeze',
          agentName: 'explore',
          runInBackground: false,
        });

        vi.advanceTimersByTime(300);
        component.setResult({ tool_call_id: 'call_agent_freeze', output: 'ok', is_error: false });
        const doneHeader = headerLine(component);
        expect(strip(doneHeader)).toContain('Explore Agent Completed');
        expect(doneHeader).toContain(chalk.hex(darkColors.success).bold('Explore Agent'));

        // No tick rebuilds after completion: the header is byte-identical.
        vi.advanceTimersByTime(2000);
        expect(headerLine(component)).toBe(doneHeader);

        component.dispose();
      } finally {
        chalk.level = previousLevel;
      }
    });

    it('requests no renders when nothing animates', () => {
      vi.useFakeTimers();

      // A finished card never starts the animation timer.
      const doneRender = vi.fn();
      const done = new ToolCallComponent(
        { id: 'call_idle_done', name: 'Read', args: { path: 'foo.ts' } },
        { tool_call_id: 'call_idle_done', output: 'ok', is_error: false },
        animatedStubTui(doneRender),
      );
      vi.advanceTimersByTime(5000);
      expect(doneRender).not.toHaveBeenCalled();
      done.dispose();

      // A running card ticks; once the result lands the renders stop.
      const runningRender = vi.fn();
      const running = new ToolCallComponent(
        { id: 'call_idle_running', name: 'Read', args: { path: 'foo.ts' } },
        undefined,
        animatedStubTui(runningRender),
      );
      vi.advanceTimersByTime(1000);
      expect(runningRender.mock.calls.length).toBeGreaterThan(0);
      running.setResult({ tool_call_id: 'call_idle_running', output: 'ok', is_error: false });
      const callsAfterResult = runningRender.mock.calls.length;
      vi.advanceTimersByTime(3000);
      expect(runningRender.mock.calls.length).toBe(callsAfterResult);
      running.dispose();
    });
  });

  it('keeps collapsed tool-call lines within very narrow widths', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_narrow_read',
        name: 'Read',
        args: { path: 'very/long/path/to/foo.ts' },
      },
      {
        tool_call_id: 'call_narrow_read',
        output: 'content',
        is_error: false,
      },
    );

    for (const width of [1, 2, 4, 10, 39]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('keeps collapsed tool results short and expands on demand', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_shell',
        name: 'Bash',
        args: { command: 'printf output' },
      },
      {
        tool_call_id: 'call_shell',
        output: ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n'),
        is_error: false,
      },
    );

    const collapsed = strip(component.render(100).join('\n'));
    expect(collapsed).toContain('line1');
    expect(collapsed).toContain('line2');
    expect(collapsed).toContain('line3');
    expect(collapsed).not.toContain('line4');
    expect(collapsed).toContain('... (2 more lines, ctrl+o to expand)');

    component.setExpanded(true);

    const expanded = strip(component.render(100).join('\n'));
    expect(expanded).toContain('line4');
    expect(expanded).toContain('line5');
    expect(expanded).not.toContain('ctrl+o to expand');
  });

  it('prefixes tool-result body rows with the dim tree gutter', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const component = new ToolCallComponent(
        {
          id: 'call_prefix',
          name: 'CustomTool',
          args: { input: 'x' },
        },
        {
          tool_call_id: 'call_prefix',
          output: 'alpha\nbeta',
          is_error: false,
        },
      );

      const lines = component.render(100);
      const alpha = lines.find((l) => l.includes('alpha'));
      const beta = lines.find((l) => l.includes('beta'));
      expect(alpha).toBeDefined();
      expect(beta).toBeDefined();
      // The generic result body is one logical entry: its first row opens
      // the (here closing) branch, and the second output line aligns under
      // the entry text as a blank continuation — not a new branch.
      expect(strip(alpha!)).toMatch(/^ {2}└─ /u);
      expect(strip(beta!)).toMatch(/^ {5}beta/u);
      expect(strip(beta!)).not.toContain('├─');
      expect(strip(beta!)).not.toContain('└─');
      // The gutter itself renders in the shared textDim detail tone.
      expect(alpha!).toContain(currentTheme.fg('textDim', '  └─ '));
      expect(beta!).toContain(currentTheme.fg('textDim', '     '));
      // Body rows use the shared textDim detail tone.
      expect(alpha!).toContain(currentTheme.fg('textDim', 'alpha'));
      // The call line keeps the status bullet — the gutter is result-only.
      const header = lines.find((l) => l.includes('CustomTool'));
      expect(header).toBeDefined();
      expect(strip(header!)).not.toContain('├─');
      expect(strip(header!)).not.toContain('└─');
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('keeps the tree gutter when the result is an error', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_prefix_err',
        name: 'CustomTool',
        args: { input: 'x' },
      },
      {
        tool_call_id: 'call_prefix_err',
        output: 'boom',
        is_error: true,
      },
    );

    const out = component.render(100);
    const row = out.find((l) => l.includes('boom'));
    expect(row).toBeDefined();
    expect(strip(row!)).toMatch(/^ {2}└─ /u);
  });

  it('renders an MCP tool result that is one JSON document with the single-bar gutter, not the tree', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_mcp_json',
        name: 'mcp__github__get_issue',
        args: { number: 1 },
      },
      {
        tool_call_id: 'call_mcp_json',
        output: '{\n  "title": "bug",\n  "state": "open"\n}',
        is_error: false,
      },
    );

    const lines = component.render(100);
    const title = lines.find((l) => l.includes('"title"'));
    const state = lines.find((l) => l.includes('"state"'));
    expect(title).toBeDefined();
    expect(state).toBeDefined();
    // Every body row carries the dim `│` bar on the tree branch's column.
    expect(strip(title!)).toMatch(/^ {2}│ /u);
    expect(strip(state!)).toMatch(/^ {2}│ /u);
    // The tree gutter never appears against the raw payload.
    const body = lines.filter((l) => l.includes('"'));
    expect(body.every((l) => !l.includes('├─') && !l.includes('└─'))).toBe(true);
  });

  it('keeps the tree gutter for an MCP tool result that is plain text', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_mcp_text',
        name: 'mcp__github__list_repos',
        args: {},
      },
      {
        tool_call_id: 'call_mcp_text',
        output: 'repo-a\nrepo-b',
        is_error: false,
      },
    );

    const lines = component.render(100);
    const rowA = lines.find((l) => l.includes('repo-a'));
    const rowB = lines.find((l) => l.includes('repo-b'));
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();
    // Tree shape: the body opens with a branch and continues aligned —
    // the raw-payload single bar would prefix every row with `  │ ` instead.
    expect(strip(rowA!)).toMatch(/^ {2}└─ /u);
    expect(strip(rowB!)).toMatch(/^ {5}repo-b/u);
  });

  describe('detail tree wrap continuations', () => {
    const GREP_OUTPUT = [
      "src/tui/foo.ts:133:        expect(text).toContain('dev 版本，可能不稳定');",
      'src/tui/bar.ts:45: const alpha = someFairlyLongFunctionCall(argumentOne, argumentTwo);',
      'src/tui/baz.ts:67: short();',
      'src/tui/qux.ts:89: medium.length.call.here();',
      'src/tui/quux.ts:101: another();',
    ].join('\n');

    function grepBodyLines(id: string, width: number, expanded: boolean): string[] {
      const component = new ToolCallComponent(
        { id, name: 'Grep', args: { pattern: 'dev' } },
        { tool_call_id: id, output: GREP_OUTPUT, is_error: false },
      );
      if (expanded) component.setExpanded(true);
      const all = component.render(width).map(strip);
      return all.slice(all.findIndex((l) => l.includes('Grep')) + 1);
    }

    it('keeps a wrapped grep match inside one tree node', () => {
      // Inner width is 35, so the long matches wrap onto continuation rows.
      const body = grepBodyLines('call_grep_wrap', 40, true);

      // Each match opens exactly one branch; its wrapped content continues on
      // the lighter `│` gutter aligned under the entry text — the content is
      // never hung on a sibling `├─` of its own.
      const fooBranch = body.findIndex((l) => l.startsWith('  ├─ src/tui/foo.ts:133:'));
      expect(fooBranch).toBeGreaterThanOrEqual(0);
      expect(body[fooBranch + 1]).toMatch(/^ {2}│ {2}expect\(text\)/u);
      expect(body[fooBranch + 2]).toMatch(/^ {2}│ {2}/u);

      // The closing entry carries `└─` on its first row.
      expect(body.at(-1)!).toMatch(/^ {2}└─ src\/tui\/quux\.ts:101: another\(\);/u);

      // No continuation row re-opens a branch.
      const continuations = body.filter((l) => l.startsWith('  │  ') || l.startsWith('     '));
      expect(continuations.length).toBeGreaterThan(0);
      for (const row of continuations) {
        expect(row).not.toContain('├─');
        expect(row).not.toContain('└─');
      }
    });

    it('wraps the collapsed glance inside one tree node, +N more tail included', () => {
      const body = grepBodyLines('call_grep_glance_wrap', 30, false);

      // The comma-joined glance is one logical entry: exactly one branch row
      // (the closing `└─`), and every wrapped fragment — including the split
      // `+2 more` tail — continues on blank space instead of a new node.
      expect(body.length).toBeGreaterThan(1);
      expect(body[0]).toMatch(/^ {2}└─ /u);
      for (const row of body.slice(1)) {
        expect(row).toMatch(/^ {5}\S/u);
      }
    });

    it('keeps the +N 更多 tail inside the glance node when CJK text wraps (zh-CN)', () => {
      setLocalePreference('zh-CN');
      try {
        const body = grepBodyLines('call_grep_glance_wrap_zh', 30, false);
        // The CJK tail may split mid-word (`更`/`多`), but the fragment stays
        // a blank continuation of the single glance node.
        expect(body.length).toBeGreaterThan(1);
        expect(body[0]).toMatch(/^ {2}└─ /u);
        for (const row of body.slice(1)) {
          expect(row).toMatch(/^ {5}\S/u);
        }
      } finally {
        setLocalePreference('en');
      }
    });

    it('keeps every rendered row within the render width (ANSI-aware wrap)', () => {
      for (const width of [30, 40, 55]) {
        const component = new ToolCallComponent(
          { id: `call_grep_w${width}`, name: 'Grep', args: { pattern: 'dev' } },
          { tool_call_id: `call_grep_w${width}`, output: GREP_OUTPUT, is_error: false },
        );
        component.setExpanded(true);
        for (const row of component.render(width)) {
          expect(visibleWidth(strip(row))).toBeLessThanOrEqual(width);
        }
      }
    });
  });

  it('keeps the tree gutter for a non-MCP tool even when the output parses as JSON', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_custom_json',
        name: 'CustomTool',
        args: { input: 'x' },
      },
      {
        tool_call_id: 'call_custom_json',
        output: '{"a":1}',
        is_error: false,
      },
    );

    const lines = component.render(100);
    const row = lines.find((l) => l.includes('"a"'));
    expect(row).toBeDefined();
    expect(strip(row!)).toMatch(/^ {2}└─ /u);
  });

  it('renders a Bash card in the command shape: $ command, then ⎿ output', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_tree_bash',
        name: 'Bash',
        args: { command: 'printf hi' },
      },
      {
        tool_call_id: 'call_tree_bash',
        output: 'hi',
        is_error: false,
      },
    );

    const lines = component.render(100).map((l) => strip(l));
    const command = lines.find((l) => l.includes('$ printf hi'));
    const output = lines.find((l) => l.includes('hi') && !l.includes('$'));
    expect(command).toBeDefined();
    expect(output).toBeDefined();
    // Command cards replace the tree gutter with the `$` / `⎿` shape.
    expect(command!).toMatch(/^ {3}\$ /u);
    expect(output!).toMatch(/^ {3}⎿ /u);
    expect(lines.every((l) => !l.includes('├─') && !l.includes('└─'))).toBe(true);
  });

  it('shows the dim no-output note when the command produced no output', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const component = new ToolCallComponent(
        {
          id: 'call_tree_bash_empty',
          name: 'Bash',
          args: { command: 'mkdir -p a/b/c' },
        },
        {
          tool_call_id: 'call_tree_bash_empty',
          output: '',
          is_error: false,
        },
      );

      const lines = component.render(100);
      const stripped = lines.map((l) => strip(l));
      const command = stripped.find((l) => l.includes('$ mkdir -p a/b/c'));
      const note = stripped.find((l) => l.includes('(no output)'));
      expect(command).toBeDefined();
      expect(command!).toMatch(/^ {3}\$ /u);
      expect(note).toBeDefined();
      expect(note!).toMatch(/^ {3}⎿ \(no output\)/u);
      expect(lines[stripped.indexOf(note!)]!).toContain(
        currentTheme.fg('textDim', '⎿ (no output)'),
      );
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('localizes the no-output note', () => {
    setLocalePreference('zh-CN');
    try {
      const component = new ToolCallComponent(
        {
          id: 'call_tree_bash_empty_zh',
          name: 'Bash',
          args: { command: 'mkdir -p a/b/c' },
        },
        {
          tool_call_id: 'call_tree_bash_empty_zh',
          output: '',
          is_error: false,
        },
      );

      const lines = component.render(100).map((l) => strip(l));
      expect(lines.some((l) => l.includes('⎿ （无输出）'))).toBe(true);
    } finally {
      setLocalePreference('en');
    }
  });

  it('renders an ExecSession card in the same command shape', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_exec_session',
        name: 'ExecSession',
        args: { command: 'bash' },
      },
      {
        tool_call_id: 'call_exec_session',
        output: 'started\n',
        is_error: false,
      },
    );

    const lines = component.render(100).map((l) => strip(l));
    const command = lines.find((l) => l.includes('$ bash'));
    const output = lines.find((l) => l.includes('started'));
    expect(command).toBeDefined();
    expect(command!).toMatch(/^ {3}\$ /u);
    expect(output).toBeDefined();
    expect(output!).toMatch(/^ {3}⎿ /u);
  });

  it('renders live Bash output while the command is running', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_shell_live',
        name: 'Bash',
        args: { command: 'printf output' },
      },
      undefined,
    );

    component.appendLiveOutput('line1\n');
    component.appendLiveOutput('line2\n');

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Running a command');
    expect(out).toContain('line1');
    expect(out).toContain('line2');
  });

  it('clears live Bash output when the final result arrives', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_shell_live_done',
        name: 'Bash',
        args: { command: 'printf output' },
      },
      undefined,
    );

    component.appendLiveOutput('streamed-only\n');
    component.setResult({
      tool_call_id: 'call_shell_live_done',
      output: 'final-only\n',
      is_error: false,
    });

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Ran a command');
    expect(out).toContain('final-only');
    expect(out).not.toContain('streamed-only');
  });

  describe('Bash command preview', () => {
    const longCommand = Array.from({ length: 15 }, (_, i) => `echo step${String(i + 1)}`).join(
      '\n',
    );

    it('shows the truncated command while running and reveals the rest when expanded', () => {
      const component = new ToolCallComponent(
        { id: 'call_bash_running', name: 'Bash', args: { command: longCommand } },
        undefined,
      );

      const collapsed = strip(component.render(100).join('\n'));
      expect(collapsed).toContain('Running a command');
      expect(collapsed).toContain('echo step1');
      expect(collapsed).toContain('echo step10');
      expect(collapsed).not.toContain('echo step11');

      component.setExpanded(true);

      const expanded = strip(component.render(100).join('\n'));
      expect(expanded).toContain('echo step11');
      expect(expanded).toContain('echo step15');
    });

    it('keeps the command preview after the result lands to avoid a height collapse', () => {
      const component = new ToolCallComponent(
        { id: 'call_bash_done', name: 'Bash', args: { command: longCommand } },
        undefined,
      );

      // Sanity: while running, the in-flight preview shows the command.
      expect(strip(component.render(100).join('\n'))).toContain('$ echo step1');

      component.setResult({ tool_call_id: 'call_bash_done', output: 'done', is_error: false });

      // Collapsed result view still shows the command preview (capped at
      // COMMAND_PREVIEW_LINES) so a multi-line command with short output does
      // not collapse the card. The command is owned by buildCallPreview, so it
      // must appear exactly once — the result renderer no longer renders it.
      const out = strip(component.render(100).join('\n'));
      expect(out).toContain('Ran a command');
      expect(out).toContain('$ echo step1');
      expect(out).toContain('echo step10');
      expect(out).not.toContain('echo step11');
      expect(out).toContain('done');
      expect(out.split('$ echo step1').length - 1).toBe(1);

      component.setExpanded(true);
      const expanded = strip(component.render(100).join('\n'));
      expect(expanded).toContain('echo step11');
      expect(expanded).toContain('echo step15');
    });

    it('keeps the command preview when the command produces no output', () => {
      const component = new ToolCallComponent(
        { id: 'call_bash_empty', name: 'Bash', args: { command: 'mkdir -p a/b/c\necho done' } },
        { tool_call_id: 'call_bash_empty', output: '', is_error: false },
      );

      // buildContent early-returns on empty output, but the command preview
      // (owned by buildCallPreview) must still render so the card does not
      // collapse to just the header.
      const out = strip(component.render(100).join('\n'));
      expect(out).toContain('Ran a command');
      expect(out).toContain('$ mkdir -p a/b/c');
      expect(out).toContain('echo done');
    });
  });

  it('hides tool output bodies that start with a <system-reminder tag', () => {
    const reminderOutput =
      '<system-reminder>\nThe task tools have not been used recently.\n</system-reminder>';
    const component = new ToolCallComponent(
      {
        id: 'call_hidden',
        name: 'Bash',
        args: { command: 'echo hi' },
      },
      {
        tool_call_id: 'call_hidden',
        output: reminderOutput,
        is_error: false,
      },
    );

    const collapsed = strip(component.render(100).join('\n'));
    expect(collapsed).toContain(`${STATUS_BULLET}Ran a command`);
    expect(collapsed).not.toContain('system-reminder');
    expect(collapsed).not.toContain('task tools');

    component.setExpanded(true);
    const expanded = strip(component.render(100).join('\n'));
    expect(expanded).not.toContain('system-reminder');
    expect(expanded).not.toContain('task tools');
  });

  it('hides <system-reminder-prefixed output even when the tool result is an error', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_hidden_err',
        name: 'Bash',
        args: { command: 'false' },
      },
      {
        tool_call_id: 'call_hidden_err',
        output: '<system-reminder>do not show</system-reminder>',
        is_error: true,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).not.toContain('system-reminder');
    expect(out).not.toContain('do not show');
  });

  it('renders output that merely starts with a literal <system> tag', () => {
    // Tool metadata no longer travels inside `output` (it rides the result's
    // `note` side channel), so real output starting with the literal tag —
    // a file that contains it, an MCP tool's text — must stay visible.
    const component = new ToolCallComponent(
      {
        id: 'call_literal',
        name: 'Bash',
        args: { command: 'cat notes.txt' },
      },
      {
        tool_call_id: 'call_literal',
        output: '<system>literal text from a user file</system>\nsecond line',
        is_error: false,
      },
    );

    component.setExpanded(true);
    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('<system>literal text from a user file</system>');
    expect(out).toContain('second line');
  });

  it('renders AgentSwarm results as a one-line summary without raw XML', () => {
    const output = [
      '<agent_swarm_result>',
      '<summary>completed: 1, failed: 1, aborted: 1</summary>',
      '<subagent index="1" outcome="completed">Reviewed src/a.ts.</subagent>',
      '<subagent index="2" outcome="failed">Agent timed out.</subagent>',
      '<subagent index="3" outcome="aborted">User aborted.</subagent>',
      '</agent_swarm_result>',
    ].join('\n');
    const component = new ToolCallComponent(
      {
        id: 'call_swarm',
        name: 'AgentSwarm',
        args: {
          description: 'Review changed files',
          items: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        },
      },
      {
        tool_call_id: 'call_swarm',
        output,
        is_error: false,
      },
    );

    const out = strip(component.render(120).join('\n'));

    expect(out).toContain('Agent swarm: ✓ 1 completed · ✗ 1 failed · ⊘ 1 aborted');
    expect(out).not.toContain('<agent_swarm_result>');
    expect(out).not.toContain('Reviewed src/a.ts.');
    expect(out).not.toContain('Agent timed out.');
  });

  it('renders an AgentSwarm fallback summary when the result is not structured', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_swarm_failed',
        name: 'AgentSwarm',
        args: { description: 'Review changed files' },
      },
      {
        tool_call_id: 'call_swarm_failed',
        output: 'provider request failed',
        is_error: true,
      },
    );

    const out = strip(component.render(120).join('\n'));

    expect(out).toContain('Agent swarm: ✗ Failed.');
    expect(out).not.toContain('provider request failed');
  });

  it('still renders tool output when the body merely contains <system later on', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_inline',
        name: 'Bash',
        args: { command: 'echo hi' },
      },
      {
        tool_call_id: 'call_inline',
        output: 'first line\n<system-reminder>nope</system-reminder>',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('first line');
  });

  it('renders ExitPlanMode plan from result output when args.plan is absent', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_exit',
        name: 'ExitPlanMode',
        args: {},
      },
      {
        tool_call_id: 'call_exit',
        output:
          'Exited plan mode. Plan mode deactivated. All tools are now available.\n' +
          'Plan saved to: /tmp/plan.md\n\n' +
          '## Approved Plan:\n# File Plan\n\n1. Do the focused fix.',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Current plan');
    expect(out).toContain('File Plan');
    expect(out).toContain('1. Do the focused fix.');
    expect(out).not.toContain('Plan saved to: /tmp/plan.md');
  });

  it('setPlanInfo injects plan body when args.plan is empty (plan-file mode)', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_exit_async',
        name: 'ExitPlanMode',
        args: {},
      },
      undefined,
      undefined,
    );

    // A fresh tool card only shows the 'Current plan' title; no plan box renders yet.
    const before = strip(component.render(100).join('\n'));
    expect(before).toContain('Current plan');
    expect(before).not.toContain('Refactor session');

    component.setPlanInfo({ plan: '# Refactor session\n\n- step', path: '/tmp/refactor.md' });

    const after = strip(component.render(100).join('\n'));
    expect(after).toContain('Refactor session');
    expect(after).toContain('plan:');
    expect(after).toContain('refactor.md');
    // Directory portion of the path must not leak into the visible header.
    expect(after).not.toContain('/tmp/refactor.md');
  });

  it('renders the full plan preview', () => {
    const longPlan = `# Refactor session\n\n${Array.from({ length: 40 }, (_, i) => `- step ${String(i + 1)}`).join('\n')}`;
    const component = new ToolCallComponent(
      {
        id: 'call_exit_long',
        name: 'ExitPlanMode',
        args: { plan: longPlan },
      },
      undefined,
      stubTui(24),
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('step 1');
    expect(out).toContain('step 40');
    expect(out).not.toContain('more lines');
  });

  it('plan preview controls are no-ops for non-ExitPlanMode tool calls', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_bash_plan',
        name: 'Bash',
        args: { command: 'echo hi' },
      },
      undefined,
      undefined,
    );

    component.setPlanInfo({ plan: 'should be ignored', path: '/etc/hosts' });

    const out = strip(component.render(100).join('\n'));
    expect(out).not.toContain('should be ignored');
    expect(out).not.toContain('plan:');
  });

  it('ctrl+o does not affect the full plan preview', () => {
    const longPlan = `# P\n\n${Array.from({ length: 40 }, (_, i) => `- step ${String(i + 1)}`).join('\n')}`;
    const component = new ToolCallComponent(
      {
        id: 'call_exit_isolation',
        name: 'ExitPlanMode',
        args: { plan: longPlan },
      },
      undefined,
      stubTui(24),
    );
    component.setExpanded(true);
    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('step 40');
    expect(out).not.toContain('more lines');
  });

  it('header chips an Approved status when ExitPlanMode result indicates approval', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_exit_approved',
        name: 'ExitPlanMode',
        args: {},
      },
      {
        tool_call_id: 'call_exit_approved',
        output:
          'Exited plan mode. Plan mode deactivated. All tools are now available.\n' +
          'Plan saved to: /tmp/plan.md\n\n' +
          '## Approved Plan:\n# Plan body',
        is_error: false,
      },
    );

    const header = strip(component.render(100).join('\n')).split('\n')[1] ?? '';
    expect(header).toMatch(/Current plan · Approved\s*$/);
  });

  it('header chips approved option label when the user picked one', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_exit_chosen',
        name: 'ExitPlanMode',
        args: {},
      },
      {
        tool_call_id: 'call_exit_chosen',
        output:
          'Exited plan mode. Selected approach: Pragmatic refactor\n' +
          'Execute ONLY the selected approach. Do not execute any unselected alternatives.\n\n' +
          'Plan mode deactivated. All tools are now available.\n' +
          'Plan saved to: /tmp/plan.md\n\n' +
          '## Approved Plan:\n# body',
        is_error: false,
      },
    );

    const header = strip(component.render(100).join('\n')).split('\n')[1] ?? '';
    expect(header).toContain('Current plan · Approved: Pragmatic refactor');
  });

  it('header chips Auto-approved when ExitPlanMode was auto-approved without user review', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_exit_auto',
        name: 'ExitPlanMode',
        args: {},
      },
      {
        tool_call_id: 'call_exit_auto',
        output:
          'Exited plan mode. Plan mode deactivated. All tools are now available.\n' +
          'Note: this plan was auto-approved without user review — the user has NOT explicitly approved it.\n' +
          'Plan saved to: /tmp/plan.md\n\n' +
          '## Plan (auto-approved, not user-reviewed):\n# Auto Plan\n\n1. Do the thing.',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    const header = out.split('\n')[1] ?? '';
    expect(header).toMatch(/Current plan · Auto-approved\s*$/);
    // The plan body renders from the auto-approved marker; the engine-side
    // note above the marker must not leak into the rendered plan box.
    expect(out).toContain('Auto Plan');
    expect(out).toContain('1. Do the thing.');
    expect(out).not.toContain('Note: this plan was auto-approved');
  });

  it('renders Rejected in the plan box title and keeps revise feedback visible', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_exit_reject_fb',
        name: 'ExitPlanMode',
        args: { plan: '# Rework Plan\n\n- step 1' },
      },
      {
        tool_call_id: 'call_exit_reject_fb',
        output: 'User rejected the plan. Feedback:\n\nplease rethink step 2',
        is_error: false,
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('plan · Rejected');
    expect(out).toContain('↪ Suggestion');
    expect(out).toContain('please rethink step 2');
  });

  it('renders is_error ExitPlanMode reject in the plan box title without raw error text', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_exit_reject',
        name: 'ExitPlanMode',
        args: { plan: '# Rejected Plan\n\n- keep investigating' },
      },
      {
        tool_call_id: 'call_exit_reject',
        output: 'Plan rejected by user. Plan mode remains active.',
        is_error: true,
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('plan · Rejected');
    expect(out).toContain('Rejected Plan');
    expect(out).not.toContain('Plan rejected by user.');
    expect(out).not.toContain('Plan mode remains active.');
  });

  it('reads the ExitPlanMode outcome from the structured payload', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_exit_structured',
        name: 'ExitPlanMode',
        args: {},
      },
      {
        tool_call_id: 'call_exit_structured',
        output:
          'Exited plan mode. Selected approach: Pragmatic refactor\n' +
          'Execute ONLY the selected approach. Do not execute any unselected alternatives.\n\n' +
          'Plan mode deactivated. All tools are now available.\n' +
          'Plan saved to: /tmp/plan.md\n\n' +
          '## Approved Plan:\n# body',
        is_error: false,
        structured: { outcome: 'approved', chosen: 'Pragmatic refactor', path: '/tmp/plan.md' },
      },
    );

    const header = strip(component.render(100).join('\n')).split('\n')[1] ?? '';
    expect(header).toContain('Current plan · Approved: Pragmatic refactor');
  });

  it('lets the structured outcome win over legacy output markers', () => {
    // Precedence guard: the structured payload is authoritative, the output
    // markers are only the fallback for older sessions.
    const component = new ToolCallComponent(
      {
        id: 'call_exit_precedence',
        name: 'ExitPlanMode',
        args: {},
      },
      {
        tool_call_id: 'call_exit_precedence',
        output:
          'Exited plan mode. Plan mode deactivated. All tools are now available.\n' +
          '## Approved Plan:\n# body',
        is_error: false,
        structured: { outcome: 'auto_approved' },
      },
    );

    const header = strip(component.render(100).join('\n')).split('\n')[1] ?? '';
    expect(header).toMatch(/Current plan · Auto-approved\s*$/);
  });

  it('renders structured rejected feedback like the legacy feedback output', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_exit_structured_reject',
        name: 'ExitPlanMode',
        args: { plan: '# Rework Plan\n\n- step 1' },
      },
      {
        tool_call_id: 'call_exit_structured_reject',
        output: 'User rejected the plan. Feedback:\n\nplease rethink step 2',
        is_error: false,
        structured: { outcome: 'rejected', feedback: 'please rethink step 2' },
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('plan · Rejected');
    expect(out).toContain('↪ Suggestion');
    expect(out).toContain('please rethink step 2');
  });

  it('ignores a malformed structured payload and falls back to the output markers', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_exit_malformed',
        name: 'ExitPlanMode',
        args: {},
      },
      {
        tool_call_id: 'call_exit_malformed',
        output:
          'Exited plan mode. Plan mode deactivated. All tools are now available.\n' +
          '## Approved Plan:\n# body',
        is_error: false,
        structured: { outcome: 'definitely-not-an-outcome' },
      },
    );

    const header = strip(component.render(100).join('\n')).split('\n')[1] ?? '';
    expect(header).toMatch(/Current plan · Approved\s*$/);
  });

  it('renders the revise-requested result localized via its display ref', () => {
    setLocalePreference('zh-CN');
    try {
      const component = new ToolCallComponent(
        {
          id: 'call_exit_revise',
          name: 'ExitPlanMode',
          args: {},
        },
        {
          tool_call_id: 'call_exit_revise',
          output: 'User requested revisions. Plan mode remains active.',
          is_error: false,
          structured: { outcome: 'revise_requested' },
          display: { key: 'toolResult.exitPlanMode.revisionsRequested' },
        },
      );

      const out = strip(component.render(100).join('\n'));
      expect(out).toContain('用户请求修改计划。计划模式仍然激活。');
      expect(out).not.toContain('User requested revisions.');
    } finally {
      setLocalePreference('en');
    }
  });

  it('renders the dismissed-approval result localized via its display ref', () => {
    setLocalePreference('zh-CN');
    try {
      const component = new ToolCallComponent(
        {
          id: 'call_exit_dismissed',
          name: 'ExitPlanMode',
          args: {},
        },
        {
          tool_call_id: 'call_exit_dismissed',
          output: 'Plan approval dismissed. Plan mode remains active.',
          is_error: false,
          structured: { outcome: 'dismissed' },
          display: { key: 'toolResult.exitPlanMode.dismissed' },
        },
      );

      const out = strip(component.render(100).join('\n'));
      expect(out).toContain('计划审批已取消。计划模式仍然激活。');
      expect(out).not.toContain('Plan approval dismissed.');
    } finally {
      setLocalePreference('en');
    }
  });

  it('reads the Agent id from the structured result payload', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_agent_structured',
        name: 'Agent',
        args: { description: 'do things' },
      },
      {
        tool_call_id: 'call_agent_structured',
        output: 'task_id: agent-abc12345\nstatus: running\nagent_id: agent-42',
        is_error: false,
        structured: {
          status: 'running',
          agentId: 'agent-42',
          subagentType: 'coder',
          taskId: 'agent-abc12345',
        },
      },
    );

    expect(component.getSubagentAgentId()).toBe('agent-42');
  });

  it('renders the background-agent launch localized via its display ref', () => {
    setLocalePreference('zh-CN');
    try {
      const component = new ToolCallComponent(
        {
          id: 'call_agent_bg',
          name: 'Agent',
          args: { description: 'do things', run_in_background: true },
        },
        {
          tool_call_id: 'call_agent_bg',
          output:
            'task_id: agent-abc12345\nstatus: running\nagent_id: agent-42\n' +
            'actual_subagent_type: coder\nautomatic_notification: true',
          is_error: false,
          structured: {
            status: 'running',
            agentId: 'agent-42',
            subagentType: 'coder',
            taskId: 'agent-abc12345',
          },
          display: {
            key: 'toolResult.agent.backgroundLaunched',
            params: { taskId: 'agent-abc12345', agentId: 'agent-42' },
          },
        },
      );

      const out = strip(component.render(100).join('\n'));
      expect(out).toContain('已在后台启动子代理 agent-42（任务 agent-abc12345）。');
      expect(out).not.toContain('automatic_notification');
    } finally {
      setLocalePreference('en');
    }
  });

  it('renders the goal status chip localized from the structured payload', () => {
    setLocalePreference('zh-CN');
    try {
      const component = new ToolCallComponent(
        {
          id: 'call_goal_chip',
          name: 'GetGoal',
          args: {},
        },
        {
          tool_call_id: 'call_goal_chip',
          output: JSON.stringify({ goal: { objective: 'ship it', status: 'active' } }),
          is_error: false,
          structured: { status: 'active' },
        },
      );

      const out = strip(component.render(100).join('\n'));
      expect(out).toContain('进行中');
    } finally {
      setLocalePreference('en');
    }
  });

  it('suppresses EnterPlanMode success body so prompt scaffolding does not leak into the transcript', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_enter',
        name: 'EnterPlanMode',
        args: { reason: 'plan a refactor' },
      },
      {
        tool_call_id: 'call_enter',
        output:
          'Plan mode is now active. Your workflow:\n\n' +
          'Plan file: /tmp/plan.md\n\n' +
          '1. Use read-only tools (Read, Grep, Glob) to investigate the codebase.\n' +
          '2. Design a concrete, step-by-step plan.\n' +
          '3. Write the plan to the plan file with Write or Edit.\n' +
          '4. When the plan is ready, call ExitPlanMode for user approval.\n\n' +
          'Do NOT edit files other than the plan file while plan mode is active.',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Used EnterPlanMode');
    expect(out).not.toContain('Plan mode is now active');
    expect(out).not.toContain('Plan file:');
    expect(out).not.toContain('read-only tools');
  });

  it('still surfaces EnterPlanMode error output', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_enter_err',
        name: 'EnterPlanMode',
        args: {},
      },
      {
        tool_call_id: 'call_enter_err',
        output: 'Plan mode is already active. Use ExitPlanMode when the plan is ready.',
        is_error: true,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Plan mode is already active');
  });

  it('renders AskUserQuestion with a friendly header instead of the raw tool name', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_question',
        name: 'AskUserQuestion',
        args: {},
      },
      {
        tool_call_id: 'call_question',
        output: JSON.stringify({
          answers: {
            'Favorite editor?': 'Vim',
          },
        }),
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Collected your answers');
    expect(out).toContain('Favorite editor?');
    expect(out).toContain('Vim');
    expect(out).not.toContain('AskUserQuestion');
  });

  it('renders background AskUserQuestion as a started task', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_background_question',
        name: 'AskUserQuestion',
        args: { background: true },
      },
      {
        tool_call_id: 'call_background_question',
        output: [
          'task_id: question-aaaaaaaa',
          'description: Which database?',
          'status: running',
        ].join('\n'),
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Started background question');
    expect(out).toContain('question-aaaaaaaa');
    expect(out).not.toContain('Collected your answers');
  });

  it('renders GetGoal as a goal check without raw JSON', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_get_goal',
        name: 'GetGoal',
        args: {},
      },
      {
        tool_call_id: 'call_get_goal',
        output: JSON.stringify({
          goal: {
            goalId: 'g1',
            objective: 'Ship feature X',
            status: 'active',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            startedBy: 'model',
            updatedBy: 'model',
            turnsUsed: 1,
            tokensUsed: 800,
            wallClockMs: 5000,
            budget: {
              tokenBudget: null,
              turnBudget: null,
              wallClockBudgetMs: null,
              remainingTokens: null,
              remainingTurns: null,
              remainingWallClockMs: null,
              tokenBudgetReached: false,
              turnBudgetReached: false,
              wallClockBudgetReached: false,
              overBudget: false,
            },
          },
        }),
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Checked goal');
    expect(out).toContain('Goal active: Ship feature X');
    expect(out).not.toContain('Used GetGoal');
    expect(out).not.toContain('"objective"');
  });

  it('renders SetGoalBudget with a readable budget argument', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_goal_budget',
        name: 'SetGoalBudget',
        args: { value: 10, unit: 'turns' },
      },
      {
        tool_call_id: 'call_goal_budget',
        output: 'Goal budget set: 10 turns.',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Set goal budget (10 turns)');
    expect(out).not.toContain('Set goal budget (10 turns) · 10 turns');
    expect(out).not.toContain('Used SetGoalBudget (turns)');
    expect(out).not.toContain('Goal budget set: 10 turns.');
  });

  it('renders successful SetGoalBudget headers with the primary goal marker', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const component = new ToolCallComponent(
        {
          id: 'call_goal_budget',
          name: 'SetGoalBudget',
          args: { value: 10, unit: 'turns' },
        },
        {
          tool_call_id: 'call_goal_budget',
          output: 'Goal budget set: 10 turns.',
          is_error: false,
        },
      );

      const out = component.render(100).join('\n');
      expect(out).toContain(chalk.hex(darkColors.primary)(STATUS_BULLET));
      expect(out).not.toContain(chalk.hex(darkColors.success)(STATUS_BULLET));
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('renders UpdateGoal as a model-reported status, not a user lifecycle marker', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_update_goal',
        name: 'UpdateGoal',
        args: { status: 'blocked' },
      },
      {
        tool_call_id: 'call_update_goal',
        output: 'Goal marked blocked.',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Reported goal blocked');
    expect(out).not.toContain('Updated goal (blocked)');
    expect(out).not.toContain('· blocked');
    expect(out).not.toContain('Goal marked blocked.');
    expect(out).not.toContain('● Goal blocked');
  });

  it('renders successful UpdateGoal report headers entirely in the primary goal color', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      for (const status of ['complete', 'blocked']) {
        const component = new ToolCallComponent(
          {
            id: `call_update_goal_${status}`,
            name: 'UpdateGoal',
            args: { status },
          },
          {
            tool_call_id: `call_update_goal_${status}`,
            output: `Goal marked ${status}.`,
            is_error: false,
          },
        );

        const out = component.render(100).join('\n');
        expect(out).toContain(chalk.hex(darkColors.primary)(STATUS_BULLET));
        expect(out).not.toContain(chalk.hex(darkColors.success)(STATUS_BULLET));
      }
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('appends a chip to the header once a result arrives', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_read',
        name: 'Read',
        args: { path: 'foo.ts' },
      },
      {
        tool_call_id: 'call_read',
        output: '1\tfoo\n2\tbar\n3\tbaz',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Used Read');
    expect(out).toContain('· 3 lines');
  });

  it('truncates a long file path from the head so the filename stays visible', () => {
    const longPath =
      'apps/cloud-code/src/tui/components/messages/tool-renderers/long-path/example/final-file.ts';
    const component = new ToolCallComponent(
      {
        id: 'call_long_path',
        name: 'Read',
        args: { path: longPath },
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('final-file.ts');
    expect(out).toContain('…');
    expect(out).not.toContain('apps/cloud-code/src/tui/components/messages/tool-renderers/long-pa…');
  });

  it('shows Read paths relative to the active workspace', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_workspace_read',
        name: 'Read',
        args: { path: '/tmp/proj-a/apps/cloud-code/src/main.ts' },
      },
      {
        tool_call_id: 'call_workspace_read',
        output: '1\tcontent',
        is_error: false,
      },
      undefined,
      '/tmp/proj-a',
    );

    const out = strip(component.render(100).join('\n'));
    const expectedReadPath =
      process.platform === 'win32' ? 'apps\\cloud-code\\src\\main.ts' : 'apps/cloud-code/src/main.ts';
    expect(out).toContain(`Used Read (${expectedReadPath})`);
    expect(out).not.toContain('/tmp/proj-a/apps');
    expect(component.getReadSnapshot().filePath).toBe(expectedReadPath);
  });

  it('keeps Read paths outside the active workspace absolute', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_external_read',
        name: 'Read',
        args: { path: '/tmp/proj-ab/src/main.ts' },
      },
      undefined,
      undefined,
      '/tmp/proj-a',
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Using Read (/tmp/proj-ab/src/main.ts)');
    expect(component.getReadSnapshot().filePath).toBe('/tmp/proj-ab/src/main.ts');
  });

  it('does not append a chip while a tool is still running', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_pending',
        name: 'Read',
        args: { path: 'foo.ts' },
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Using Read');
    expect(out).not.toContain('lines');
  });

  it('renders a single foreground subagent without the generic Agent tool header', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const component = new ToolCallComponent(
      {
        id: 'call_agent',
        name: 'Agent',
        args: { description: 'explore project xxx' },
      },
      undefined,
    );

    component.onSubagentSpawned({
      agentId: 'sub_explore_123456',
      agentName: 'explore',
      runInBackground: false,
    });

    let out = strip(component.render(120).join('\n'));
    expect(out).toContain('Explore Agent Queued (explore project xxx) · 0 tools · 0s');
    expect(out).not.toContain('Using Agent');
    expect(out).not.toContain('Used Agent');

    vi.setSystemTime(20_000);
    component.appendSubagentText('think1\nthink2\nthink3', 'thinking');
    component.appendSubagentText('answer1\nanswer2\nanswer3', 'text');
    component.appendSubToolCall({
      id: 'sub_explore_123456:read',
      name: 'Read',
      args: { path: 'apps/cloud-code/src/tui/utils/background-agent-status.ts' },
    });

    out = strip(component.render(120).join('\n'));
    expect(out).toContain('Explore Agent Running (explore project xxx) · 1 tool · 10s');
    expect(out).toContain('Using Read (apps/cloud-code/src/tui/utils/background-agent-status.ts)');
    // Thinking and text are mutually exclusive in the active window: the most
    // recently streamed (text) wins, so thinking is hidden entirely.
    expect(out).not.toContain('think1');
    expect(out).not.toContain('think2');
    expect(out).not.toContain('think3');
    expect(out).not.toContain('answer1');
    expect(out).toContain('answer2');
    expect(out).toContain('answer3');
    expect(out).toContain('│ answer3');

    vi.setSystemTime(22_000);
    component.onSubagentCompleted({ resultSummary: 'summary fallback' });
    component.setResult({
      tool_call_id: 'call_agent',
      output: 'parent duplicate result',
      is_error: false,
    });
    vi.setSystemTime(30_000);

    out = strip(component.render(120).join('\n'));
    expect(out).toContain('Explore Agent Completed (explore project xxx) · 1 tool · 12s');
    expect(out).not.toContain('think3');
    expect(out).toContain('│ answer3');
    expect(out).not.toContain('Used Agent');
    expect(out).not.toContain('parent duplicate result');
    expect(out).not.toContain('summary fallback');
  });

  it('shows the bound model in the subagent header and group snapshot once reported', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const component = new ToolCallComponent(
      {
        id: 'call_agent_model',
        name: 'Agent',
        args: { description: 'explore project' },
      },
      undefined,
    );
    component.onSubagentSpawned({
      agentId: 'sub_model_1',
      agentName: 'explore',
      runInBackground: false,
    });

    let out = strip(component.render(120).join('\n'));
    expect(out).toContain('Explore Agent Queued (explore project) · 0 tools');
    expect(out).not.toContain('Kimi K2.5');

    component.updateSubagentMetrics({ modelDisplay: 'Kimi K2.5' });

    out = strip(component.render(120).join('\n'));
    expect(out).toContain('Explore Agent Queued (explore project) · Kimi K2.5 · 0 tools');
    expect(component.getSubagentSnapshot().model).toBe('Kimi K2.5');
  });

  it('shows Backgrounded after a foreground subagent is detached, even after setResult', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const component = new ToolCallComponent(
      {
        id: 'call_agent_detach',
        name: 'Agent',
        args: { description: 'long task' },
      },
      undefined,
      stubTui(30),
    );
    component.onSubagentSpawned({
      agentId: 'sub_detach_1',
      agentName: 'explore',
      runInBackground: false,
    });
    component.onSubagentStarted({
      agentId: 'sub_detach_1',
      agentName: 'explore',
      runInBackground: false,
    });

    // Sanity: running before detach.
    expect(strip(component.render(120).join('\n'))).toContain('Running');

    component.markBackgrounded();
    let out = strip(component.render(120).join('\n'));
    expect(out).toContain('Backgrounded');
    expect(out).not.toContain('Completed');

    // The spawn-success ToolResult landing must NOT flip the card to Completed.
    component.setResult({
      tool_call_id: 'call_agent_detach',
      output: 'agent_id: sub_detach_1\nactual_subagent_type: explore\n',
      is_error: false,
    });
    out = strip(component.render(120).join('\n'));
    expect(out).toContain('Backgrounded');
    expect(out).not.toContain('Completed');

    component.dispose();
  });

  it('summarizes subagent tools as a count plus the current tool', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const component = new ToolCallComponent(
      {
        id: 'call_agent_tools',
        name: 'Agent',
        args: { description: 'inspect tools' },
      },
      undefined,
    );
    component.onSubagentSpawned({
      agentId: 'sub_tools',
      agentName: 'explore',
      runInBackground: false,
    });

    for (let i = 1; i <= 4; i++) {
      const id = `sub_tools:read-${String(i)}`;
      component.appendSubToolCall({ id, name: 'Read', args: { path: `file${String(i)}.ts` } });
      component.finishSubToolCall({ tool_call_id: id, output: 'ok', is_error: false });
    }
    component.appendSubToolCall({
      id: 'sub_tools:grep',
      name: 'Grep',
      args: { pattern: 'auth' },
    });

    const out = strip(component.render(120).join('\n'));
    expect(out).toContain('Explore Agent Running (inspect tools) · 5 tools · 0s');
    // Only the current (most recent ongoing) tool appears in the summary line.
    expect(out).toContain('Using Grep (auth)');
    // No per-tool activity rows are rendered.
    expect(out).not.toContain('file1.ts');
    expect(out).not.toContain('file2.ts');
    expect(out).not.toContain('file3.ts');
    expect(out).not.toContain('file4.ts');
    expect(out).not.toContain('Used Read');
  });

  it('keeps the subagent tool summary pinned to the most recent tool', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const component = new ToolCallComponent(
      {
        id: 'call_agent_stable_tools',
        name: 'Agent',
        args: { description: 'inspect tools' },
      },
      undefined,
    );
    component.onSubagentSpawned({
      agentId: 'sub_tools',
      agentName: 'explore',
      runInBackground: false,
    });

    for (let i = 1; i <= 5; i++) {
      component.appendSubToolCall({
        id: `sub_tools:read-${String(i)}`,
        name: 'Read',
        args: { path: `file${String(i)}.ts` },
      });
    }
    component.appendSubToolCallDelta({
      id: 'sub_tools:read-1',
      name: 'Read',
      argumentsPart: '{"path":"file1-updated.ts"}',
    });
    component.finishSubToolCall({
      tool_call_id: 'sub_tools:read-1',
      output: 'ok',
      is_error: false,
    });

    const out = strip(component.render(120).join('\n'));
    // The updated/finished older tool must not surface in the summary.
    expect(out).not.toContain('file1-updated.ts');
    expect(out).not.toContain('file2.ts');
    expect(out).not.toContain('file3.ts');
    expect(out).not.toContain('file4.ts');
    // Only the most recent ongoing tool is shown.
    expect(out).toContain('Using Read (file5.ts)');
  });

  it('wraps the single subagent active window with a hanging gutter', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const component = new ToolCallComponent(
      {
        id: 'call_agent_wrapped_text',
        name: 'Agent',
        args: { description: 'inspect wrapping' },
      },
      undefined,
    );
    component.onSubagentSpawned({
      agentId: 'sub_wrapped',
      agentName: 'explore',
      runInBackground: false,
    });
    component.appendSubagentText(
      'output words that should also wrap with a clean hanging indent',
      'text',
    );

    const joined = strip(component.render(34).join('\n'));
    // The two-row window drops the head of the wrapped paragraph.
    expect(joined).not.toContain('output words that should');
    // Every kept row carries the `│` gutter as a hanging indent.
    expect(joined).toContain('│ wrap with a clean hanging');
    expect(joined).toContain('│ indent');
  });

  it('scrolls single subagent thinking to the last two display rows', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const component = new ToolCallComponent(
      {
        id: 'call_agent_scroll',
        name: 'Agent',
        args: { description: 'long think' },
      },
      undefined,
    );
    component.onSubagentSpawned({
      agentId: 'sub_scroll',
      agentName: 'explore',
      runInBackground: false,
    });
    // A single long logical line (no newlines) wraps to many display rows;
    // only the last THINKING_PREVIEW_LINES (2) should remain visible.
    const segs = Array.from({ length: 30 }, (_, i) => `seg${String(i).padStart(2, '0')}`);
    component.appendSubagentText(segs.join(' '), 'thinking');

    const lines = strip(component.render(40).join('\n')).split('\n');
    const thinkingRows = lines.filter((l) => /seg\d\d/.test(l));
    expect(thinkingRows.length).toBe(2);
    expect(lines.join('\n')).toContain('seg29');
    expect(lines.join('\n')).not.toContain('seg00');
  });

  it('shows a two-row tail of an ongoing subagent Bash output', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const component = new ToolCallComponent(
      {
        id: 'call_agent_bash_out',
        name: 'Agent',
        args: { description: 'run bash' },
      },
      undefined,
    );
    component.onSubagentSpawned({
      agentId: 'sub_bash',
      agentName: 'explore',
      runInBackground: false,
    });
    component.appendSubToolCall({
      id: 'sub_bash:cmd',
      name: 'Bash',
      args: { command: 'ls -la' },
    });
    const output = Array.from({ length: 10 }, (_, i) => `bash-line-${String(i)}`).join('\n');
    component.appendSubToolLiveOutput('sub_bash:cmd', output);

    let out = strip(component.render(120).join('\n'));
    expect(out).toContain('Using Bash (ls -la)');
    // The active window keeps only the last two rows of live output.
    expect(out).toContain('bash-line-8');
    expect(out).toContain('bash-line-9');
    expect(out).not.toContain('bash-line-7');
    // No ctrl+o promise for the subagent window.
    expect(out).not.toContain('ctrl+o');

    // The global ctrl+o expand toggle must NOT expand the window.
    component.setExpanded(true);
    out = strip(component.render(120).join('\n'));
    expect(out).toContain('bash-line-9');
    expect(out).not.toContain('bash-line-7');
  });

  it('shows live output for generic subagent tools but not for recognized ones', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const component = new ToolCallComponent(
      {
        id: 'call_agent_mixed',
        name: 'Agent',
        args: { description: 'mixed tools' },
      },
      undefined,
    );
    component.onSubagentSpawned({
      agentId: 'sub_mixed',
      agentName: 'explore',
      runInBackground: false,
    });
    // A finished recognized tool: its output body never reaches the window.
    component.appendSubToolCall({
      id: 'sub_mixed:read',
      name: 'Read',
      args: { path: 'foo.ts' },
    });
    component.finishSubToolCall({
      tool_call_id: 'sub_mixed:read',
      output: 'recognized-read-body\nhidden-read-line',
      is_error: false,
    });
    // An ongoing generic (MCP) tool: its live output is the active stream.
    component.appendSubToolCall({
      id: 'sub_mixed:mcp',
      name: 'mcp__server__do',
      args: {},
    });
    const mcpOut = Array.from({ length: 5 }, (_, i) => `mcp-line-${String(i)}`).join('\n');
    component.appendSubToolLiveOutput('sub_mixed:mcp', mcpOut);

    const out = strip(component.render(120).join('\n'));
    // Recognized tool output never appears.
    expect(out).not.toContain('recognized-read-body');
    // Generic tool output shows as the two-row active window tail.
    expect(out).toContain('mcp-line-3');
    expect(out).toContain('mcp-line-4');
    expect(out).not.toContain('mcp-line-2');
    expect(out).not.toContain('ctrl+o');
  });

  it('renders failed single subagents with the dedicated header and error text', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const component = new ToolCallComponent(
      {
        id: 'call_agent_failed',
        name: 'Agent',
        args: { description: 'check failure' },
      },
      undefined,
    );
    component.onSubagentSpawned({
      agentId: 'sub_failed',
      agentName: 'explore',
      runInBackground: false,
    });

    vi.setSystemTime(4000);
    component.onSubagentFailed({ error: 'subagent exceeded max_steps' });

    const out = strip(component.render(120).join('\n'));
    expect(out).toContain('Explore Agent Failed (check failure) · 0 tools · 3s');
    expect(out).toContain('│ subagent exceeded max_steps');
    expect(out).not.toContain('Using Agent');
    expect(out).not.toContain('Used Agent');
  });

  it('keeps the same card height between running and done', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const component = new ToolCallComponent(
      {
        id: 'call_agent_height',
        name: 'Agent',
        args: { description: 'height stable' },
      },
      undefined,
    );
    component.onSubagentSpawned({
      agentId: 'sub_height',
      agentName: 'explore',
      runInBackground: false,
    });
    component.appendSubToolCall({ id: 'sub_height:read', name: 'Read', args: { path: 'a.ts' } });
    component.appendSubagentText('short answer', 'text');

    const runningLines = strip(component.render(120).join('\n')).split('\n').length;

    component.onSubagentCompleted({ resultSummary: 'short answer' });
    component.setResult({ tool_call_id: 'call_agent_height', output: 'done', is_error: false });

    const doneLines = strip(component.render(120).join('\n')).split('\n').length;

    expect(doneLines).toBe(runningLines);
  });

  describe('background agent terminal state vs spawn-success ToolResult', () => {
    // The Agent tool returns a "task spawned" result the moment a
    // run_in_background=true call lands. That result is not an error and its
    // body says `status: running`, so for backgrounded agents `this.result`
    // alone cannot distinguish a successful completion from a failure / lost
    // task. The fix is `setBackgroundTaskTerminalStatus`, which overrides the
    // result-based derivation with the actual BackgroundTaskInfo status.
    const spawnSuccessResult = {
      tool_call_id: 'call_bg_agent',
      output: [
        'task_id: agent-deadbeef',
        'status: running',
        'agent_id: agent-0',
        'actual_subagent_type: coder',
        'automatic_notification: true',
      ].join('\n'),
      is_error: false,
    };

    function makeBackgroundAgentComponent(): ToolCallComponent {
      const component = new ToolCallComponent(
        {
          id: 'call_bg_agent',
          name: 'Agent',
          args: {
            description: 'background agent 1',
            run_in_background: true,
          },
        },
        spawnSuccessResult,
      );
      component.onSubagentSpawned({
        agentId: 'agent-0',
        agentName: 'coder',
        runInBackground: true,
      });
      return component;
    }

    it('reads as "done" by default after spawn — the existing behavior the fix replaces', () => {
      // This pins the legacy behavior. Without overrides the snapshot
      // trusts the spawn-success result and reports phase='done'. The
      // 'lost' / 'killed' / 'failed' overrides below must beat this.
      const component = makeBackgroundAgentComponent();
      expect(component.getSubagentSnapshot().phase).toBe('done');
    });

    it('setBackgroundTaskTerminalStatus("lost") flips the snapshot phase to "failed"', () => {
      const component = makeBackgroundAgentComponent();
      component.setBackgroundTaskTerminalStatus('lost');
      const snap = component.getSubagentSnapshot();
      expect(snap.phase).toBe('failed');
      // The agent-group renderer uses snap.errorText for the "Error:" line.
      // The spawn-success ToolResult must NOT leak as the failure message.
      expect(snap.errorText).toContain('lost');
      expect(snap.errorText).not.toContain('task_id:');
    });

    it('setBackgroundTaskTerminalStatus("killed") flips the snapshot phase to "failed"', () => {
      const component = makeBackgroundAgentComponent();
      component.setBackgroundTaskTerminalStatus('killed');
      const snap = component.getSubagentSnapshot();
      expect(snap.phase).toBe('failed');
      expect(snap.errorText).toContain('killed');
      expect(snap.errorText).not.toContain('task_id:');
    });

    it('setBackgroundTaskTerminalStatus("failed") flips the snapshot phase to "failed"', () => {
      const component = makeBackgroundAgentComponent();
      component.setBackgroundTaskTerminalStatus('failed');
      const snap = component.getSubagentSnapshot();
      expect(snap.phase).toBe('failed');
      expect(snap.errorText).toContain('failed');
      expect(snap.errorText).not.toContain('task_id:');
    });

    it('setBackgroundTaskTerminalStatus("completed") keeps the snapshot phase at "done"', () => {
      const component = makeBackgroundAgentComponent();
      component.setBackgroundTaskTerminalStatus('completed');
      const snap = component.getSubagentSnapshot();
      expect(snap.phase).toBe('done');
      expect(snap.errorText).toBeUndefined();
    });

    it('overrides win even when set before the spawn-success result is recorded', () => {
      // Order-independence guard: reconcile may run before tool result
      // has been replayed back into the component on some boot paths.
      const component = new ToolCallComponent(
        {
          id: 'call_bg_agent',
          name: 'Agent',
          args: { description: 'background agent A', run_in_background: true },
        },
        undefined,
      );
      component.setBackgroundTaskTerminalStatus('lost');
      component.setResult({ ...spawnSuccessResult, tool_call_id: 'call_bg_agent' });
      expect(component.getSubagentSnapshot().phase).toBe('failed');
    });

    // Standalone render path — when only ONE Agent tool call lands in a
    // step, the card is never upgraded into an `AgentGroupComponent` and is
    // mounted on its own. The standalone header derives its label from
    // `getDerivedSubagentPhase()` (separate from `getSubagentSnapshot`).
    // Without the override threading into that path AND a header rebuild,
    // a lost bg agent keeps the green "✓ Completed" label.
    it('standalone render: lost bg agent must show Failed/Lost, not Completed', () => {
      const component = makeBackgroundAgentComponent();
      component.setBackgroundTaskTerminalStatus('lost');
      const out = strip(component.render(120).join('\n'));
      expect(out).not.toContain('Completed');
      expect(out).toMatch(/Failed|Lost/);
      // Friendly failure message must reach the rendered card.
      expect(out).toContain('lost');
      expect(out).not.toContain('task_id:');
    });

    it('standalone render: completed bg agent still shows Completed', () => {
      const component = makeBackgroundAgentComponent();
      component.setBackgroundTaskTerminalStatus('completed');
      const out = strip(component.render(120).join('\n'));
      expect(out).toContain('Completed');
      expect(out).not.toMatch(/Failed/);
      expect(out).not.toContain('task_id:');
    });

    // Stable id routing — `tc.subagentAgentId` is left undefined for
    // backgrounded agents both live (`handleSubagentSpawned` early-returns
    // for `runInBackground`, never calling tc.onSubagentSpawned) and on
    // resume (the wire format does not carry a `subagent` block back into
    // `applySubagentReplay`). The AgentTool's spawn-success ToolResult,
    // however, always carries `agent_id: agent-N` — fall back to parsing
    // that so callers asking `getSubagentAgentId` always get the right id,
    // and `applyBackgroundTaskTerminalStatus` can route by id instead of
    // by description (which collides between unrelated cards).
    it('getSubagentAgentId parses agent_id from the spawn-success ToolResult', () => {
      const component = new ToolCallComponent(
        {
          id: 'call_bg_agent',
          name: 'Agent',
          args: { description: 'background agent 1', run_in_background: true },
        },
        spawnSuccessResult,
      );
      // No spawn metadata was wired in — exactly the resume / backgrounded
      // case we are guarding against.
      expect(component.getSubagentAgentId()).toBe('agent-0');
    });

    it('getSubagentAgentId still prefers in-memory subagent metadata when set', () => {
      // If `setSubagentMeta` / `onSubagentSpawned` did wire an id, that one
      // is authoritative — it survived the in-flight phase before any
      // ToolResult landed and can disambiguate concurrent calls.
      const component = new ToolCallComponent(
        {
          id: 'call_bg_agent',
          name: 'Agent',
          args: { description: 'X', run_in_background: true },
        },
        spawnSuccessResult,
      );
      component.setSubagentMeta('agent-explicit', 'coder');
      expect(component.getSubagentAgentId()).toBe('agent-explicit');
    });

    it('getSubagentAgentId returns undefined for non-Agent tool calls even when output looks similar', () => {
      const component = new ToolCallComponent(
        {
          id: 'call_bash',
          name: 'Bash',
          args: { command: 'echo agent_id: agent-fake' },
        },
        {
          tool_call_id: 'call_bash',
          output: 'agent_id: agent-fake\nstatus: running',
          is_error: false,
        },
      );
      expect(component.getSubagentAgentId()).toBeUndefined();
    });

    it('setBackgroundTaskTerminalStatus errorText overwrites the friendly generic', () => {
      // Live failures arrive via `subagent.failed` with the real error from
      // the subagent loop. That string is far more informative than the
      // generic "Background agent failed" fallback the friendly path emits.
      // When the caller supplies errorText it must win, regardless of
      // whether the friendly message was written first.
      const component = makeBackgroundAgentComponent();
      component.setBackgroundTaskTerminalStatus('failed');
      expect(component.getSubagentSnapshot().errorText).toBe('Background agent failed');

      component.setBackgroundTaskTerminalStatus('failed', {
        errorText: 'subagent exceeded max_steps',
      });
      expect(component.getSubagentSnapshot().errorText).toBe('subagent exceeded max_steps');
    });

    it('setBackgroundTaskTerminalStatus errorText is written even on first call', () => {
      const component = makeBackgroundAgentComponent();
      component.setBackgroundTaskTerminalStatus('failed', {
        errorText: 'OAuth refresh failed',
      });
      expect(component.getSubagentSnapshot().errorText).toBe('OAuth refresh failed');
    });

    it('setBackgroundTaskTerminalStatus does not overwrite a real onSubagentFailed error with the generic', () => {
      const component = makeBackgroundAgentComponent();
      component.onSubagentFailed({ error: 'real crash from subagent' });
      // background.task.terminated event arrives later without an errorText
      // override; the friendly generic must NOT clobber the real message.
      component.setBackgroundTaskTerminalStatus('failed');
      expect(component.getSubagentSnapshot().errorText).toBe('real crash from subagent');
    });
  });

  it('scrolls the Write streaming preview to the last COMMAND_PREVIEW_LINES', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`line${String(i)}`);
    const escaped = lines.join('\\n');
    const component = new ToolCallComponent(
      {
        id: 'call_write_stream',
        name: 'Write',
        args: { file_path: 'foo.ts', content: lines.join('\n') },
        streamingArguments: `{"file_path":"foo.ts","content":"${escaped}`,
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Using Write');
    // Streaming preview caps at COMMAND_PREVIEW_LINES (10) and shows the tail.
    expect(out).not.toContain('line1');
    expect(out).not.toContain('line20');
    expect(out).toContain('line21');
    expect(out).toContain('line30');
    // Line numbers should reflect actual file positions.
    expect(out).toContain('  21');
    expect(out).toContain('  30');
    expect(out).not.toContain('ctrl+o to expand');
  });

  it('switches a streaming tool call to Truncated when the step ended with max_tokens', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 10; i++) lines.push(`line${String(i)}`);
    const escaped = lines.join('\\n');
    const component = new ToolCallComponent(
      {
        id: 'call_write_truncated',
        name: 'Write',
        args: { file_path: 'foo.ts', content: lines.join('\n') },
        streamingArguments: `{"file_path":"foo.ts","content":"${escaped}`,
        truncated: true,
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Truncated Write');
    expect(out).not.toContain('Preparing Write');
    expect(out).toContain('Tool call arguments truncated by max_tokens');
    // The live argument preview must NOT render once the call is
    // truncated — leaving the half-streamed Write content on screen
    // was the original "preparing write" bug.
    expect(out).not.toContain('line1');
    expect(out).not.toContain('line10');
  });

  it('renders a stable Edit progress placeholder during the streaming delta window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(4000);
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (let i = 1; i <= 20; i++) {
      oldLines.push(`old${String(i)}`);
      newLines.push(`new${String(i)}`);
    }
    const oldEscaped = oldLines.join('\\n');
    const newEscaped = newLines.join('\\n');
    const streaming = `{"file_path":"foo.ts","old_string":"${oldEscaped}","new_string":"${newEscaped}`;
    const component = new ToolCallComponent(
      {
        id: 'call_edit_stream',
        name: 'Edit',
        args: {
          file_path: 'foo.ts',
          old_string: oldLines.join('\n'),
          new_string: newLines.join('\n'),
        },
        streamingArguments: streaming,
        streamingStartedAtMs: 0,
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Using Edit');
    expect(out).toContain('foo.ts');
    expect(out).toContain('Preparing changes for foo.ts...');
    expect(out).toContain('4s elapsed');
    expect(out).toMatch(/\d+(?:\.\d+)? (?:B|KB|MB)/);
    expect(out).not.toContain('old20');
    expect(out).not.toContain('new20');
    expect(out).not.toMatch(/^\s*\d+\s+[+-]\s/m);
    expect(out).not.toContain('ctrl+o to expand');
  });

  it('caps the Write preview between finalized args and result to keep transcript height stable', () => {
    // The wire sequence is: tool.call.delta → ... → tool.call (final
    // args, no streamingArguments) → tool.result. Between tool.call and
    // tool.result we briefly sit with finalized args and no result yet —
    // even without an approval panel, at least one render tick can land
    // in this state. The preview must stay capped so the transcript
    // height does not balloon and then snap back when the result lands;
    // a big shrink triggers pi-tui's full-redraw path which wipes the
    // terminal scrollback (history before TUI start).
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`line${String(i)}`);
    const component = new ToolCallComponent(
      {
        id: 'call_write_pending',
        name: 'Write',
        args: { file_path: 'foo.ts', content: lines.join('\n') },
        // No streamingArguments → finalized args; no result yet.
      },
      undefined,
    );
    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('line1');
    expect(out).toContain('line10');
    expect(out).not.toContain('line11');
    expect(out).not.toContain('line25');
    expect(out).toContain('ctrl+o to expand');
  });

  it('snaps a long Write preview to the collapsed cap when the result arrives', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`line${String(i)}`);
    const escaped = lines.join('\\n');
    const component = new ToolCallComponent(
      {
        id: 'call_write_snap',
        name: 'Write',
        args: { file_path: 'big.txt', content: lines.join('\n') },
        streamingArguments: `{"file_path":"big.txt","content":"${escaped}"}`,
      },
      undefined,
    );
    expect(strip(component.render(100).join('\n'))).toContain('line25');

    component.setResult({
      tool_call_id: 'call_write_snap',
      output: 'Wrote big.txt',
      is_error: false,
    });

    const after = strip(component.render(100).join('\n'));
    expect(after).toContain('line1');
    expect(after).not.toContain('line25');
    expect(after).toContain('ctrl+o to expand');
  });

  it('refreshes the header when file_path arrives in a later streaming delta', () => {
    // First delta: only an opening brace, no file_path yet.
    const component = new ToolCallComponent(
      {
        id: 'call_write_path',
        name: 'Write',
        args: {},
        streamingArguments: '{',
      },
      undefined,
    );
    const before = strip(component.render(100).join('\n'));
    expect(before).toContain('Using Write');
    expect(before).not.toContain('foo.ts');

    // Later delta: file_path is now parseable from streamingArguments.
    component.updateToolCall({
      id: 'call_write_path',
      name: 'Write',
      args: { file_path: 'foo.ts' },
      streamingArguments: '{"file_path":"foo.ts","content":"hello',
    });
    const after = strip(component.render(100).join('\n'));
    expect(after).toContain('foo.ts');
  });

  it('builds the call preview when finalized args arrive after streaming', () => {
    // Mimic the wire sequence: tool.call.delta → ... → tool.call (finalized).
    const component = new ToolCallComponent(
      {
        id: 'call_write_seq',
        name: 'Write',
        args: { file_path: 'foo.ts', content: 'a\nb' },
        streamingArguments: '{"file_path":"foo.ts","content":"a\\nb',
      },
      undefined,
    );
    // While streaming, body is rendered live from streamingArguments.
    expect(strip(component.render(100).join('\n'))).toMatch(/^\s*1\s+a\s*$/m);

    // Finalized tool.call: streamingArguments is undefined; the body
    // re-renders from finalized args, content unchanged.
    component.updateToolCall({
      id: 'call_write_seq',
      name: 'Write',
      args: { file_path: 'foo.ts', content: 'a\nb' },
    });
    const out = strip(component.render(100).join('\n'));
    expect(out).toMatch(/^\s*1\s+a\s*$/m);
    expect(out).toMatch(/^\s*2\s+b\s*$/m);
  });

  it('builds the Edit diff when finalized args arrive after streaming', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_edit_seq',
        name: 'Edit',
        args: { file_path: 'foo.ts' },
        streamingArguments: '{"file_path":"foo.ts","old_string":"a\\nb","new_string":"a\\nB',
        streamingStartedAtMs: Date.now(),
      },
      undefined,
    );
    expect(strip(component.render(100).join('\n'))).toContain('Preparing changes');
    expect(strip(component.render(100).join('\n'))).not.toMatch(/^\s*\d+\s+[+-]\s/m);

    component.updateToolCall({
      id: 'call_edit_seq',
      name: 'Edit',
      args: { file_path: 'foo.ts', old_string: 'a\nb', new_string: 'a\nB' },
    });
    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('foo.ts');
    expect(out).toMatch(/^\s*2\s+- b\s*$/m);
    expect(out).toMatch(/^\s*2\s+\+ B\s*$/m);
  });

  it('refreshes and stops the Edit streaming progress timer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ui = { requestRender: vi.fn() };
    const component = new ToolCallComponent(
      {
        id: 'call_edit_timer',
        name: 'Edit',
        args: { file_path: 'foo.ts' },
        streamingArguments: '{"file_path":"foo.ts","old_string":"a',
        streamingStartedAtMs: 0,
      },
      undefined,
      ui as never,
    );

    expect(strip(component.render(100).join('\n'))).toContain('0s elapsed');
    vi.advanceTimersByTime(1000);
    expect(ui.requestRender).toHaveBeenCalled();
    expect(strip(component.render(100).join('\n'))).toContain('1s elapsed');

    ui.requestRender.mockClear();
    component.setResult({
      tool_call_id: 'call_edit_timer',
      output: 'Replaced 1 occurrence in foo.ts',
      is_error: false,
    });
    vi.advanceTimersByTime(1000);
    expect(ui.requestRender).not.toHaveBeenCalled();

    const componentToDispose = new ToolCallComponent(
      {
        id: 'call_edit_dispose',
        name: 'Edit',
        args: { file_path: 'bar.ts' },
        streamingArguments: '{"file_path":"bar.ts","old_string":"a',
        streamingStartedAtMs: 0,
      },
      undefined,
      ui as never,
    );
    ui.requestRender.mockClear();
    componentToDispose.dispose();
    vi.advanceTimersByTime(1000);
    expect(ui.requestRender).not.toHaveBeenCalled();
  });

  it('expands the Write call preview when ctrl+o expansion is set', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`line${String(i)}`);
    const component = new ToolCallComponent(
      {
        id: 'call_write_done',
        name: 'Write',
        args: { file_path: 'big.txt', content: lines.join('\n') },
      },
      {
        tool_call_id: 'call_write_done',
        output: 'Wrote big.txt',
        is_error: false,
      },
    );

    const collapsed = strip(component.render(100).join('\n'));
    expect(collapsed).toContain('line1');
    expect(collapsed).toContain('line10');
    expect(collapsed).not.toContain('line25');
    expect(collapsed).toContain('ctrl+o to expand');

    component.setExpanded(true);

    const expanded = strip(component.render(100).join('\n'));
    expect(expanded).toContain('line25');
    expect(expanded).toContain('line30');
    expect(expanded).not.toContain('ctrl+o to expand');
  });

  it('renders unknown Write file extensions as plain text without stderr noise', () => {
    const stderr = captureProcessWrite('stderr');
    try {
      const component = new ToolCallComponent(
        {
          id: 'call_write_unknown_ext',
          name: 'Write',
          args: { file_path: 'demo.abcxyz', content: 'hello\nworld' },
        },
        {
          tool_call_id: 'call_write_unknown_ext',
          output: 'Wrote demo.abcxyz',
          is_error: false,
        },
      );

      const collapsed = strip(component.render(100).join('\n'));
      expect(collapsed).toContain('hello');

      component.setExpanded(true);
      const expanded = strip(component.render(100).join('\n'));
      expect(expanded).toContain('world');
      expect(stderr.text()).not.toContain('Could not find the language');
    } finally {
      stderr.restore();
    }
  });

  describe('lazy rebuild coalescing', () => {
    // Streaming subagent deltas arrive in bursts between render frames. The
    // component must not rebuild its child components per delta: mutations
    // only mark the body dirty and the rebuild happens once inside render().
    function spyOnRebuild(method: 'rebuildBody' | 'rebuildContent') {
      return vi.spyOn(
        ToolCallComponent.prototype as unknown as Record<typeof method, () => void>,
        method,
      );
    }

    it('rebuilds at most once per render across a burst of subagent deltas', () => {
      const bodySpy = spyOnRebuild('rebuildBody');
      const contentSpy = spyOnRebuild('rebuildContent');
      try {
        const component = new ToolCallComponent(
          { id: 'call_agent_coalesce', name: 'Agent', args: { description: 'explore' } },
          undefined,
          stubTui(30),
        );
        bodySpy.mockClear();
        contentSpy.mockClear();

        component.onSubagentSpawned({
          agentId: 'sub_coalesce',
          agentName: 'explore',
          runInBackground: false,
        });
        component.appendSubagentText('first chunk ', 'text');
        component.appendSubagentText('second chunk ', 'text');
        component.appendSubToolCall({ id: 'sub_coalesce:read', name: 'Read', args: { path: 'a.ts' } });
        component.appendSubToolCallDelta({ id: 'sub_coalesce:read', argumentsPart: '{"path":' });
        component.appendSubToolCallDelta({ id: 'sub_coalesce:read', argumentsPart: '"b.ts"}' });
        component.appendSubToolLiveOutput('sub_coalesce:read', 'live output line');

        // No rebuild happened yet — children are rebuilt lazily at render time.
        expect(bodySpy).not.toHaveBeenCalled();
        expect(contentSpy).not.toHaveBeenCalled();

        const out = strip(component.render(120).join('\n'));
        // One rebuild total (the constructor's Agent detach hint marks the
        // body dirty, so the single flush takes the body path, which
        // includes the content region).
        expect(bodySpy.mock.calls.length + contentSpy.mock.calls.length).toBe(1);

        // The single rebuild picked up every buffered delta.
        expect(out).toContain('first chunk second chunk');
        expect(out).toContain('b.ts');

        // A render with no intervening mutation does not rebuild again.
        component.render(120);
        expect(bodySpy.mock.calls.length + contentSpy.mock.calls.length).toBe(1);

        component.appendSubagentText('third', 'text');
        component.render(120);
        expect(bodySpy.mock.calls.length + contentSpy.mock.calls.length).toBe(2);
        component.dispose();
      } finally {
        bodySpy.mockRestore();
        contentSpy.mockRestore();
      }
    });

    it('renders identically whether or not renders happen between deltas', () => {
      const make = (
        renderBetween: boolean,
      ): { component: ToolCallComponent; run: () => void } => {
        const component = new ToolCallComponent(
          { id: 'call_agent_parity', name: 'Agent', args: { description: 'explore' } },
          undefined,
          stubTui(30),
        );
        const deltas: Array<() => void> = [
          () => component.onSubagentSpawned({ agentId: 'sub_parity', agentName: 'explore', runInBackground: false }),
          () => component.appendSubagentText('alpha ', 'text'),
          () => component.appendSubagentText('beta\n', 'text'),
          () => component.appendSubToolCall({ id: 'sub_parity:bash', name: 'Bash', args: { command: 'ls' } }),
          () => component.appendSubToolLiveOutput('sub_parity:bash', 'file1\nfile2\n'),
          () => component.finishSubToolCall({ tool_call_id: 'sub_parity:bash', output: 'file1\nfile2\n', is_error: false }),
          () => component.onSubagentCompleted({ resultSummary: 'done summary' }),
          () => component.setResult({ tool_call_id: 'call_agent_parity', output: 'agent_id: sub_parity\nok', is_error: false }),
        ];
        return {
          component,
          run: () => {
            for (const apply of deltas) {
              apply();
              if (renderBetween) component.render(100);
            }
          },
        };
      };

      const eager = make(true);
      eager.run();
      const lazy = make(false);
      lazy.run();

      expect(strip(lazy.component.render(100).join('\n'))).toBe(
        strip(eager.component.render(100).join('\n')),
      );
      eager.component.dispose();
      lazy.component.dispose();
    });
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
    const bgOpen = (): string => {
      const sampled = currentTheme.bg('userMessageBackground', SENTINEL);
      return sampled.slice(0, sampled.indexOf(SENTINEL));
    };
    // Sampled after chalk.level is forced in beforeAll — sampling earlier
    // (at collection time) would capture the colorless sequences.
    let TEXT_OPEN = '';
    let DIM_OPEN = '';
    let BG_OPEN = '';
    const press: MouseEvent = { type: 'press', button: 0, col: 2, row: 2, slotRelative: false };

    beforeAll(() => {
      TEXT_OPEN = fgOpen('text');
      DIM_OPEN = fgOpen('textDim');
      BG_OPEN = bgOpen();
      if (TEXT_OPEN.length === 0 || BG_OPEN.length === 0) {
        throw new Error('theme sampling produced no SGR sequences');
      }
    });

    function makeCard(): ToolCallComponent {
      return new ToolCallComponent(
        { id: 'call_bash_inter', name: 'Bash', args: { command: 'seq 1 20' } },
        {
          tool_call_id: 'call_bash_inter',
          output: Array.from({ length: 20 }, (_, i) => `output line ${i + 1}`).join('\n'),
          is_error: false,
        },
        stubTui(30),
      );
    }

    it('declares one hit zone covering the card below its spacer', () => {
      const component = makeCard();
      const lines = component.render(100);
      const zones = [...component.hitZones()];
      expect(zones).toHaveLength(1);
      expect(zones[0]).toMatchObject({ row: 1, col: 1, width: 100, height: lines.length - 1 });
      component.dispose();
    });

    it('hover whitens the detail body only and restores on leave', () => {
      const component = makeCard();
      const base = component.render(100);
      expect(base.slice(2).join('\n')).toContain(DIM_OPEN);

      component.setHoveredZone('card');
      const hovered = component.render(100);
      expect(hovered[0]).toBe(base[0]); // spacer untouched
      // The header is painted by the hover background but keeps its text and
      // foreground colors.
      expect(hovered[1]).not.toBe(base[1]);
      expect(strip(hovered[1]!).trimEnd()).toBe(strip(base[1]!).trimEnd());
      expect(
        hovered
          .slice(1)
          .map((line) => strip(line).trimEnd())
          .join('\n'),
      ).toBe(
        base
          .slice(1)
          .map((line) => strip(line).trimEnd())
          .join('\n'),
      );
      const body = hovered.slice(2).join('\n');
      expect(body).toContain(TEXT_OPEN);
      expect(body).not.toContain(DIM_OPEN);
      expect(body).not.toContain('\x1b[2m');
      expect(hovered.join('\n')).not.toContain(BG_OPEN);

      component.setHoveredZone(null);
      expect(component.render(100)).toEqual(base);
      component.dispose();
    });

    it('click expands with gray background and white content; re-click collapses', () => {
      const component = makeCard();
      const base = component.render(100);
      expect(strip(base.join('\n'))).not.toContain('output line 20');

      component.onHitZone('card', press);
      const expanded = component.render(100);
      const text = strip(expanded.join('\n'));
      expect(text).toContain('output line 20');
      // The gray block covers header and body; the leading spacer stays plain.
      expect(expanded[0]).not.toContain(BG_OPEN);
      for (const line of expanded.slice(1)) {
        expect(line).toContain(BG_OPEN);
      }
      // The header row keeps its foreground colors inside the block.
      expect(strip(expanded[1]!).trimEnd()).toBe(strip(base[1]!).trimEnd());
      expect(expanded[1]).toContain(fgOpen('success'));
      // The expanded content renders white, not gray.
      const body = expanded.slice(2).join('\n');
      expect(body).toContain(TEXT_OPEN);
      expect(body).not.toContain(DIM_OPEN);

      component.onHitZone('card', press);
      expect(component.render(100)).toEqual(base);
      component.dispose();
    });

    it('keyboard expansion stays gray without background; hover whitens; click re-collapses', () => {
      const component = makeCard();
      const base = component.render(100);

      component.setExpanded(true);
      const keyboard = component.render(100);
      expect(strip(keyboard.join('\n'))).toContain('output line 20');
      expect(keyboard.join('\n')).not.toContain(BG_OPEN);
      expect(keyboard.slice(2).join('\n')).toContain(DIM_OPEN);

      component.setHoveredZone('card');
      const hovered = component.render(100);
      expect(hovered.slice(2).join('\n')).toContain(TEXT_OPEN);
      expect(hovered.join('\n')).not.toContain(BG_OPEN);

      // A click on a keyboard-expanded card collapses just that card.
      component.onHitZone('card', press);
      component.setHoveredZone(null);
      expect(component.render(100)).toEqual(base);
      component.dispose();
    });

    it('keeps the click state through a keyboard expand pass', () => {
      const component = makeCard();
      component.onHitZone('card', press);
      component.setExpanded(true);
      expect(component.render(100).join('\n')).toContain(BG_OPEN);
      component.dispose();
    });

    it('setExpanded(false) clears a click expansion (collapse-all)', () => {
      const component = makeCard();
      const base = component.render(100);
      component.onHitZone('card', press);
      expect(strip(component.render(100).join('\n'))).toContain('output line 20');
      component.setExpanded(false);
      expect(component.render(100)).toEqual(base);
      component.dispose();
    });
  });

  describe('hover and click on Edit/Write/Read preview cards', () => {
    // cli-highlight styles through its own chalk v4 instance; force colors on
    // for both chalk copies so the syntax-highlighted previews emit their
    // real SGR sequences.
    const req = createRequire(import.meta.url);
    const chalkV4 = req(
      req.resolve('chalk', { paths: [dirname(req.resolve('cli-highlight'))] }),
    ) as { level: number };
    const prevLevel = chalk.level;
    const prevV4Level = chalkV4.level;
    beforeAll(() => {
      chalk.level = 3;
      chalkV4.level = 3;
      currentTheme.setPalette(darkColors);
    });
    afterAll(() => {
      chalk.level = prevLevel;
      chalkV4.level = prevV4Level;
    });

    const SENTINEL = '\u0001';
    const fgOpen = (token: 'text' | 'textDim'): string => {
      const sampled = currentTheme.fg(token, SENTINEL);
      return sampled.slice(0, sampled.indexOf(SENTINEL));
    };
    const hexOpen = (hex: string): string => {
      const sampled = chalk.hex(hex)(SENTINEL);
      return sampled.slice(0, sampled.indexOf(SENTINEL));
    };
    const bgOpen = (): string => {
      const sampled = currentTheme.bg('userMessageBackground', SENTINEL);
      return sampled.slice(0, sampled.indexOf(SENTINEL));
    };
    // Sampled after chalk.level is forced in beforeAll — sampling earlier
    // (at collection time) would capture the colorless sequences.
    let TEXT_OPEN = '';
    let DIM_OPEN = '';
    let BG_OPEN = '';
    beforeAll(() => {
      TEXT_OPEN = fgOpen('text');
      DIM_OPEN = fgOpen('textDim');
      BG_OPEN = bgOpen();
      if (TEXT_OPEN.length === 0 || BG_OPEN.length === 0) {
        throw new Error('theme sampling produced no SGR sequences');
      }
    });

    const press: MouseEvent = { type: 'press', button: 0, col: 2, row: 2, slotRelative: false };

    const writeContent = `const x = "s"; // c\nfunction f() { return 1; }\n${Array.from(
      { length: 12 },
      (_, i) => `let v${String(i)} = ${String(i)};`,
    ).join('\n')}`;

    function makeWriteCard(): ToolCallComponent {
      return new ToolCallComponent(
        {
          id: 'call_write_inter',
          name: 'Write',
          args: { file_path: 'foo.ts', content: writeContent },
        },
        { tool_call_id: 'call_write_inter', output: 'wrote file', is_error: false },
        stubTui(30),
      );
    }

    function makeEditCard(): ToolCallComponent {
      return new ToolCallComponent(
        {
          id: 'call_edit_inter',
          name: 'Edit',
          args: {
            file_path: 'foo.ts',
            old_string: Array.from({ length: 12 }, (_, i) => `line ${i + 1} old`).join('\n'),
            new_string: Array.from({ length: 12 }, (_, i) => `line ${i + 1} new`).join('\n'),
          },
        },
        { tool_call_id: 'call_edit_inter', output: 'ok', is_error: false },
        stubTui(30),
      );
    }

    function makeSingleChangeEditCard(): ToolCallComponent {
      return new ToolCallComponent(
        {
          id: 'call_edit_single_change',
          name: 'Edit',
          args: {
            file_path: 'README.md',
            old_string: '**门禁**：旧',
            new_string: '**门禁**：新',
          },
        },
        {
          tool_call_id: 'call_edit_single_change',
          output: 'Replaced 1 occurrence in README.md',
          is_error: false,
        },
        stubTui(30),
      );
    }

    function makeReadCard(): ToolCallComponent {
      return new ToolCallComponent(
        { id: 'call_read_inter', name: 'Read', args: { file_path: 'foo.ts' } },
        {
          tool_call_id: 'call_read_inter',
          output: Array.from({ length: 8 }, (_, i) => `file line ${i + 1}`).join('\n'),
          is_error: false,
        },
        stubTui(30),
      );
    }

    it('declares one hit zone covering the Write header and preview rows', () => {
      const component = makeWriteCard();
      const lines = component.render(100);
      expect(lines.length).toBeGreaterThan(3);
      const zones = [...component.hitZones()];
      expect(zones).toHaveLength(1);
      expect(zones[0]).toMatchObject({ row: 1, col: 1, width: 100, height: lines.length - 1 });
      component.dispose();
    });

    it('declares a hit zone even when the card is header-only (collapsed Read)', () => {
      const component = makeReadCard();
      const lines = component.render(100);
      const zones = [...component.hitZones()];
      expect(zones).toHaveLength(1);
      expect(zones[0]).toMatchObject({ row: 1, col: 1, width: 100, height: lines.length - 1 });
      component.dispose();
    });

    it('hover over the Write preview whitens the line numbers and keeps the syntax colors', () => {
      const component = makeWriteCard();
      const base = component.render(100);
      const baseBody = base.slice(2).join('\n');
      // Default rendering: dim line numbers, cli-highlight colors, capped preview.
      expect(baseBody).toContain('\x1b[2m');
      expect(baseBody).toContain('\x1b[34m'); // keyword
      expect(baseBody).toContain('\x1b[32m'); // comment / number
      expect(strip(baseBody)).toContain('let v7');
      expect(strip(baseBody)).not.toContain('let v11');

      component.setHoveredZone('card');
      const hovered = component.render(100);
      expect(hovered[0]).toBe(base[0]); // spacer untouched
      // The header is painted by the hover background but keeps its text and
      // foreground colors.
      expect(hovered[1]).not.toBe(base[1]);
      expect(strip(hovered[1]!).trimEnd()).toBe(strip(base[1]!).trimEnd());
      expect(
        hovered
          .slice(1)
          .map((line) => strip(line).trimEnd())
          .join('\n'),
      ).toBe(
        base
          .slice(1)
          .map((line) => strip(line).trimEnd())
          .join('\n'),
      );
      const body = hovered.slice(2).join('\n');
      expect(body).toContain(TEXT_OPEN); // whitened line numbers and hint
      expect(body).not.toContain('\x1b[2m');
      expect(body).toContain('\x1b[34m'); // syntax colors are not flattened
      expect(body).toContain('\x1b[32m');
      expect(hovered.join('\n')).not.toContain(BG_OPEN);

      component.setHoveredZone(null);
      expect(component.render(100)).toEqual(base);
      component.dispose();
    });

    it('click expands the full Write preview on gray background, keeping syntax colors; re-click collapses', () => {
      const component = makeWriteCard();
      const base = component.render(100);
      expect(strip(base.join('\n'))).not.toContain('let v11');

      component.onHitZone('card', press);
      const expanded = component.render(100);
      const text = strip(expanded.join('\n'));
      expect(text).toContain('let v11');
      expect(text).toContain('wrote file');
      // The gray block covers header and body; the leading spacer stays plain.
      expect(expanded[0]).not.toContain(BG_OPEN);
      for (const line of expanded.slice(1)) {
        expect(line).toContain(BG_OPEN);
      }
      const body = expanded.slice(2).join('\n');
      expect(body).toContain(TEXT_OPEN); // white line numbers on the block
      expect(body).not.toContain('\x1b[2m');
      expect(body).toContain('\x1b[34m'); // syntax colors survive the click state
      expect(body).toContain('\x1b[32m');

      component.onHitZone('card', press);
      expect(component.render(100)).toEqual(base);
      component.dispose();
    });

    it('keyboard expansion of the Write preview shows the full file gray, without background', () => {
      const component = makeWriteCard();
      const base = component.render(100);

      component.setExpanded(true);
      const keyboard = component.render(100);
      expect(strip(keyboard.join('\n'))).toContain('let v11');
      expect(keyboard.join('\n')).not.toContain(BG_OPEN);
      const body = keyboard.slice(2).join('\n');
      expect(body).toContain('\x1b[2m'); // line numbers stay dim
      expect(body).toContain('\x1b[34m'); // syntax colors intact

      // A click collapses the keyboard-expanded card back to its base form.
      component.onHitZone('card', press);
      expect(component.render(100)).toEqual(base);
      component.dispose();
    });

    it('hover over the Edit diff keeps add/remove/gutter colors and whitens only dim meta text', () => {
      const component = makeEditCard();
      const base = component.render(100);
      const baseBody = base.slice(2).join('\n');
      // Capped clustered diff: leading change rows plus a hidden-changes footer.
      expect(strip(baseBody)).toContain('- line 9 old');
      expect(strip(baseBody)).not.toContain('line 11 old');
      const delOpen = hexOpen(currentTheme.palette.diffRemoved);
      const gutterOpen = hexOpen(currentTheme.palette.diffGutter);
      expect(baseBody).toContain(delOpen);
      expect(baseBody).toContain(gutterOpen);
      expect(baseBody).toContain(DIM_OPEN); // diff meta shares textDim in this palette

      component.setHoveredZone('card');
      const hovered = component.render(100);
      expect(strip(hovered.join('\n'))).toBe(strip(base.join('\n')));
      const body = hovered.slice(2).join('\n');
      expect(body).toContain(delOpen);
      expect(body).toContain(gutterOpen);
      expect(body).toContain(hexOpen(currentTheme.palette.diffAddedStrong)); // diff header row
      // Only the textDim-toned meta footer whitens.
      expect(body).not.toContain(DIM_OPEN);
      expect(body).toContain(TEXT_OPEN);
      expect(hovered.join('\n')).not.toContain(BG_OPEN);

      component.setHoveredZone(null);
      expect(component.render(100)).toEqual(base);
      component.dispose();
    });

    it('shows an expand hint when a single-change Edit card hides result details', () => {
      const component = makeSingleChangeEditCard();
      const base = component.render(100);
      const text = strip(base.join('\n'));

      expect(text).toContain('+1 -1 README.md');
      expect(text).toMatch(/\d+ more lines?[, ]+.*ctrl\+o to expand/);
      expect([...component.hitZones()]).toHaveLength(1);
      component.dispose();
    });

    it('whitens a single-change Edit diff while its card is hovered', () => {
      const component = makeSingleChangeEditCard();
      const base = component.render(100);
      component.setHoveredZone('card');

      const hovered = component.render(100);
      expect(strip(hovered.join('\n'))).toBe(strip(base.join('\n')));
      expect(hovered.join('\n')).not.toBe(base.join('\n'));
      expect(hovered.slice(2).join('\n')).toContain(TEXT_OPEN);
      expect(hovered.join('\n')).not.toContain(BG_OPEN);

      component.setHoveredZone(null);
      expect(component.render(100)).toEqual(base);
      component.dispose();
    });

    it('click expands the full Edit diff on gray background with colors intact; re-click collapses', () => {
      const component = makeEditCard();
      const base = component.render(100);
      expect(strip(base.join('\n'))).not.toContain('line 12 new');

      component.onHitZone('card', press);
      const expanded = component.render(100);
      const text = strip(expanded.join('\n'));
      expect(text).toContain('- line 12 old');
      expect(text).toContain('+ line 12 new');
      expect(expanded[0]).not.toContain(BG_OPEN);
      for (const line of expanded.slice(1)) {
        expect(line).toContain(BG_OPEN);
      }
      const body = expanded.slice(2).join('\n');
      expect(body).toContain(hexOpen(currentTheme.palette.diffAdded));
      expect(body).toContain(hexOpen(currentTheme.palette.diffRemoved));

      component.onHitZone('card', press);
      expect(component.render(100)).toEqual(base);
      component.dispose();
    });

    it('Read expands from a header-only card to the full output, white on gray; re-click collapses', () => {
      const component = makeReadCard();
      const base = component.render(100);
      expect(base).toHaveLength(2); // spacer + header; the body stays empty while collapsed
      expect(strip(base.join('\n'))).not.toContain('file line 1');

      component.onHitZone('card', press);
      const expanded = component.render(100);
      const text = strip(expanded.join('\n'));
      expect(text).toContain('file line 1');
      expect(text).toContain('file line 8');
      const body = expanded.slice(2).join('\n');
      expect(body).toContain(TEXT_OPEN);
      expect(body).not.toContain(DIM_OPEN);
      for (const line of expanded.slice(1)) {
        expect(line).toContain(BG_OPEN);
      }

      component.onHitZone('card', press);
      expect(component.render(100)).toEqual(base);
      component.dispose();
    });

    it('keyboard expansion of Read shows the output gray without background', () => {
      const component = makeReadCard();
      component.setExpanded(true);
      const keyboard = component.render(100);
      expect(strip(keyboard.join('\n'))).toContain('file line 8');
      expect(keyboard.slice(2).join('\n')).toContain(DIM_OPEN);
      expect(keyboard.join('\n')).not.toContain(BG_OPEN);
      component.dispose();
    });
  });

  describe('hit zone registration gating (expandable content only)', () => {
    function zoneCount(component: ToolCallComponent, width = 100): number {
      component.render(width);
      return [...component.hitZones()].length;
    }

    it('declares no zone for an in-flight header-only card', () => {
      const component = new ToolCallComponent(
        { id: 'hz_inflight', name: 'Grep', args: { pattern: 'foo' } },
        undefined,
        stubTui(30),
      );
      expect(zoneCount(component)).toBe(0);
      component.dispose();
    });

    it('declares no zone when a finished command card fits the preview caps', () => {
      const component = new ToolCallComponent(
        { id: 'hz_short_bash', name: 'Bash', args: { command: 'echo hi' } },
        { tool_call_id: 'hz_short_bash', output: 'hi', is_error: false },
        stubTui(30),
      );
      expect(zoneCount(component)).toBe(0);
      component.dispose();
    });

    it('declares no zone for a running single-subagent Agent card (fixed-height body)', () => {
      vi.useFakeTimers();
      const component = new ToolCallComponent(
        { id: 'hz_agent', name: 'Agent', args: { description: 'x' } },
        undefined,
        stubTui(30),
      );
      component.onSubagentSpawned({
        agentId: 'sub_hz_agent',
        agentName: 'explore',
        runInBackground: false,
      });
      expect(zoneCount(component)).toBe(0);
      component.dispose();
    });

    it('declares a zone only at widths where wrapped output exceeds the cap', () => {
      const longOutput = `{"data":"${'x'.repeat(200)}","ok":true}`;
      const component = new ToolCallComponent(
        { id: 'hz_mcp', name: 'mcp__srv__tool', args: {} },
        { tool_call_id: 'hz_mcp', output: longOutput, is_error: false },
        stubTui(30),
      );
      expect(zoneCount(component, 40)).toBe(1);
      expect(zoneCount(component, 400)).toBe(0);
      component.dispose();
    });

    it('declares a zone when the call preview hides rows (command lines, Write content, Edit diff)', () => {
      const command = Array.from({ length: 15 }, (_, i) => `echo ${i}`).join('\n');
      const bash = new ToolCallComponent(
        { id: 'hz_multiline', name: 'Bash', args: { command } },
        undefined,
        stubTui(30),
      );
      expect(zoneCount(bash)).toBe(1);
      bash.dispose();

      const content = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`).join('\n');
      const write = new ToolCallComponent(
        { id: 'hz_write', name: 'Write', args: { file_path: 'f.ts', content } },
        { tool_call_id: 'hz_write', output: '', is_error: false },
        stubTui(30),
      );
      expect(zoneCount(write)).toBe(1);
      write.dispose();

      const edit = new ToolCallComponent(
        {
          id: 'hz_edit',
          name: 'Edit',
          args: {
            file_path: 'f.ts',
            old_string: Array.from({ length: 30 }, (_, i) => `old${i}`).join('\n'),
            new_string: Array.from({ length: 30 }, (_, i) => `new${i}`).join('\n'),
          },
        },
        { tool_call_id: 'hz_edit', output: '', is_error: false },
        stubTui(30),
      );
      expect(zoneCount(edit)).toBe(1);
      edit.dispose();
    });

    it('declares no zone for a Write card whose preview and result both fit', () => {
      const component = new ToolCallComponent(
        { id: 'hz_write_short', name: 'Write', args: { file_path: 'f.ts', content: 'a\nb\nc\n' } },
        { tool_call_id: 'hz_write_short', output: '', is_error: false },
        stubTui(30),
      );
      expect(zoneCount(component)).toBe(0);
      component.dispose();
    });
  });

  describe('hover whitening on a header-only expandable card', () => {
    it('whitens the collapsed Read header dim runs while colored parts keep tones', () => {
      const previousLevel = chalk.level;
      chalk.level = 3;
      try {
        currentTheme.setPalette(darkColors);
        const SENTINEL = '';
        const fgOpen = (token: 'text' | 'textDim' | 'success'): string => {
          const sampled = currentTheme.fg(token, SENTINEL);
          return sampled.slice(0, sampled.indexOf(SENTINEL));
        };
        const component = new ToolCallComponent(
          { id: 'hv_read', name: 'Read', args: { path: 'src/foo.ts' } },
          { tool_call_id: 'hv_read', output: 'line one\nline two', is_error: false },
          stubTui(30),
        );
        const normal = component.render(100);
        const zone = [...component.hitZones()][0];
        expect(zone).toBeDefined();
        expect(component.setHoveredZone(zone!.id)).not.toBe(false);
        const hovered = component.render(100);
        expect(hovered[1]).not.toBe(normal[1]);
        // The dim argument run turns white…
        expect(hovered[1]).toContain(`${fgOpen('text')} (src/foo.ts)`);
        // …while the success ● and the bold tool name keep their tones.
        expect(hovered[1]).toContain(`${fgOpen('success')}${STATUS_BULLET}`);
        expect(component.setHoveredZone(null)).not.toBe(false);
        expect(component.render(100)[1]).toBe(normal[1]);
        component.dispose();
      } finally {
        chalk.level = previousLevel;
      }
    });
  });
});

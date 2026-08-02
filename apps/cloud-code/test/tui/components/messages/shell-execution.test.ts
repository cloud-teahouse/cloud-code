import chalk from 'chalk';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CommandBodyComponent,
  ShellExecutionComponent,
  commandCardNoOutputRow,
  isCommandCardToolName,
  prefixCommandOutputRows,
  shellExecutionResultRenderer,
} from '#/tui/components/messages/shell-execution';
import { COMMAND_BODY_INDENT } from '#/tui/constant/symbols';
import { setLocalePreference } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

describe('isCommandCardToolName', () => {
  it('marks Bash and ExecSession as command cards', () => {
    expect(isCommandCardToolName('Bash')).toBe(true);
    expect(isCommandCardToolName('ExecSession')).toBe(true);
    expect(isCommandCardToolName('Read')).toBe(false);
  });
});

describe('prefixCommandOutputRows', () => {
  const previousLevel = chalk.level;
  afterEach(() => {
    chalk.level = previousLevel;
  });

  it('opens the first row with a dim ⎿ and aligns continuation rows under the text', () => {
    chalk.level = 3;
    const rows = prefixCommandOutputRows(['alpha', 'beta', 'gamma']);
    expect(rows.map(strip)).toEqual(['⎿ alpha', '  beta', '  gamma']);
    // The ⎿ glyph is dim/gray; the row text keeps its own styling.
    expect(rows[0]).toContain(currentTheme.fg('textDim', '⎿ '));
  });
});

describe('commandCardNoOutputRow', () => {
  const previousLevel = chalk.level;
  afterEach(() => {
    chalk.level = previousLevel;
    setLocalePreference('en');
  });

  it('renders the dim no-output note behind the ⎿ mark', () => {
    chalk.level = 3;
    const row = commandCardNoOutputRow();
    expect(strip(row)).toBe('⎿ (no output)');
    expect(row).toContain(currentTheme.fg('textDim', '⎿ (no output)'));
  });

  it('localizes the no-output note', () => {
    setLocalePreference('zh-CN');
    expect(strip(commandCardNoOutputRow())).toBe('⎿ （无输出）');
  });
});

describe('CommandBodyComponent', () => {
  it('indents every row one level without a tree gutter', () => {
    const component = new CommandBodyComponent([
      new ShellExecutionComponent({ command: 'ls', showCommand: true }),
    ]);
    const rows = component.render(100).map((line) => strip(line).trimEnd());
    expect(rows).toEqual([`${COMMAND_BODY_INDENT}$ ls`]);
  });
});

describe('ShellExecutionComponent', () => {
  it('renders the command preview with the prompt marker and aligned continuations', () => {
    const component = new CommandBodyComponent([
      new ShellExecutionComponent({
        command: 'printf hello\nprintf world',
        showCommand: true,
      }),
    ]);

    const output = component.render(100).map((line) => strip(line).trimEnd());

    // Multi-line commands: the first line takes the `$` prompt, later lines
    // align under the command text.
    expect(output).toContain('   $ printf hello');
    expect(output).toContain('     printf world');
  });

  it('renders the result behind the ⎿ output mark', () => {
    const component = new CommandBodyComponent([
      new ShellExecutionComponent({
        result: {
          tool_call_id: 'call_shell',
          output: 'AGENTS.md\napps\nbuild',
          is_error: false,
        },
      }),
    ]);

    const output = component.render(100).map((line) => strip(line).trimEnd());
    expect(output).toEqual(['   ⎿ AGENTS.md', '     apps', '     build']);
  });

  it('keeps collapsed shell output short and expands on demand', () => {
    const collapsed = new ShellExecutionComponent({
      result: {
        tool_call_id: 'call_shell',
        output: ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n'),
        is_error: false,
      },
    });

    const collapsedOutput = collapsed.render(100).map(strip).join('\n');
    expect(collapsedOutput).toContain('line1');
    expect(collapsedOutput).toContain('line3');
    expect(collapsedOutput).not.toContain('line4');
    expect(collapsedOutput).toContain('... (2 more lines, ctrl+o to expand)');

    const expanded = new ShellExecutionComponent({
      result: {
        tool_call_id: 'call_shell',
        output: ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n'),
        is_error: false,
      },
      expanded: true,
    });

    const expandedOutput = expanded.render(100).map(strip).join('\n');
    expect(expandedOutput).toContain('line4');
    expect(expandedOutput).toContain('line5');
    expect(expandedOutput).not.toContain('ctrl+o to expand');
  });

  it('renders unbounded command preview when previewLines is undefined', () => {
    const cmd = Array.from({ length: 20 }, (_, i) => `step${String(i + 1)}`).join('\n');
    const component = new ShellExecutionComponent({
      command: cmd,
      showCommand: true,
      commandPreviewLines: undefined,
    });

    const output = component.render(100).map(strip).join('\n');
    expect(output).toContain('$ step1');
    expect(output).toContain('step20');
  });

  it('does not count trailing empty lines toward the preview cap', () => {
    const component = new ShellExecutionComponent({
      result: {
        tool_call_id: 'call_shell',
        output: 'hello\n\n\n', // 1 content line + 2 trailing empty lines
        is_error: false,
      },
    });

    const output = component.render(100).map(strip).join('\n');
    expect(output).toContain('hello');
    expect(output).not.toContain('... (2 more lines');
  });

  it('preserves internal empty lines while trimming only trailing ones', () => {
    const component = new ShellExecutionComponent({
      result: {
        tool_call_id: 'call_shell',
        output: 'a\n\nb\n\n\n', // 1 internal empty line + 2 trailing empty lines
        is_error: false,
      },
    });

    const output = component.render(100).map(strip).join('\n');
    expect(output).toContain('a');
    expect(output).toContain('b');
    expect(output).not.toContain('... (2 more lines');
  });

  it('truncates long single-line output by wrapped visual lines', () => {
    const component = new ShellExecutionComponent({
      result: {
        tool_call_id: 'call_shell',
        output: 'x'.repeat(500),
        is_error: false,
      },
    });

    const out = strip(component.render(20).join('\n'));
    expect(out).toContain('x');
    expect(out).not.toContain('x'.repeat(500));
    expect(out).toContain('... (');
  });

  describe('shellExecutionResultRenderer', () => {
    const longCmd = `echo ${'a'.repeat(200)}\necho done`;

    it('renders only the result and leaves the command to the call preview', () => {
      const components = shellExecutionResultRenderer(
        {
          id: 'call_1',
          name: 'Bash',
          args: { command: longCmd },
        },
        {
          tool_call_id: 'call_1',
          output: 'ok',
          is_error: false,
        },
        { expanded: false },
      );

      const rendered = components
        .flatMap((c) => c.render(100))
        .map(strip)
        .join('\n');
      // Command is owned by ToolCallComponent.buildCallPreview, not the
      // renderer — rendering it here too would duplicate it once the result
      // lands.
      expect(rendered).not.toContain('$ echo');
      expect(rendered).toContain('ok');
    });

    it('still renders only the result when expanded', () => {
      const components = shellExecutionResultRenderer(
        {
          id: 'call_1',
          name: 'Bash',
          args: { command: longCmd },
        },
        {
          tool_call_id: 'call_1',
          output: ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n'),
          is_error: false,
        },
        { expanded: true },
      );

      const rendered = components
        .flatMap((c) => c.render(300))
        .map(strip)
        .join('\n');
      expect(rendered).not.toContain('$ echo');
      expect(rendered).toContain('line4');
      expect(rendered).toContain('line5');
    });
  });
});

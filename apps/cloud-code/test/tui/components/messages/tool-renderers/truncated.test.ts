import { visibleWidth } from '@cloud-code/pi-tui';
import { afterEach, describe, expect, it } from 'vitest';

import {
  TruncatedOutputComponent,
  renderTruncated,
  toolResultDisplayText,
} from '#/tui/components/messages/tool-renderers/truncated';
import { setLocalePreference } from '#/tui/i18n';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

// The display-preference tests switch locales; reset to en after each.
afterEach(() => {
  setLocalePreference('en');
});

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

describe('TruncatedOutputComponent', () => {
  it('renders content and the truncation hint flush left (the tree gutter owns alignment)', () => {
    const component = new TruncatedOutputComponent(['a', 'b', 'c', 'd', 'e'].join('\n'), {
      expanded: false,
      isError: false,
      maxLines: 2,
    });

    const lines = strip(component.render(80).join('\n')).split('\n').map((l) => l.trimEnd());
    expect(lines[0]).toBe('a');
    expect(lines[1]).toBe('b');
    expect(lines[2]).toBe('... (3 more lines, ctrl+o to expand)');
  });

  it('omits the ctrl+o promise when expandHint is false', () => {
    const component = new TruncatedOutputComponent('a\nb\nc\nd', {
      expanded: false,
      isError: false,
      maxLines: 2,
      expandHint: false,
    });

    const lines = strip(component.render(80).join('\n')).split('\n');
    expect(lines[2]).toBe('... (2 more lines)');
  });

  it('renders all lines without a hint when expanded', () => {
    const component = new TruncatedOutputComponent('a\nb\nc\nd', {
      expanded: true,
      isError: false,
      maxLines: 2,
    });

    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('d');
    expect(out).not.toContain('more lines, ctrl+o');
  });

  it('keeps the truncation footer within the requested render width', () => {
    const output = Array.from({ length: 20 }, (_, i) => `line ${String(i)}`).join('\n');
    const component = new TruncatedOutputComponent(output, {
      expanded: false,
      isError: false,
      maxLines: 3,
    });

    for (const line of component.render(37)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(37);
    }
  });

  it('renders output verbatim, including literal <system> text in file content', () => {
    // Tool metadata no longer travels inside `output` (it rides the result's
    // `note` side channel), so the renderer must not eat user data that
    // merely contains the literal tag.
    const component = new TruncatedOutputComponent(
      '<system>literal text from a user file</system>\n<image path="/tmp/x.png">',
      { expanded: true, isError: false },
    );
    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('<system>literal text from a user file</system>');
    expect(out).toContain('<image path="/tmp/x.png">');
  });
});


describe('renderTruncated — display ref preference', () => {
  const call: ToolCallBlockData = { id: 'tc', name: 'CronDelete', args: {} };
  const ctx = { expanded: true };

  function renderBody(result: ToolResultBlockData): string {
    return strip(
      renderTruncated(call, result, ctx)
        .flatMap((c) => c.render(100))
        .join('\n'),
    );
  }

  it('renders the localized display text when the key is known (en)', () => {
    const out = renderBody({
      tool_call_id: 'tc',
      output: 'Deleted cron job abc12345.',
      display: { key: 'toolResult.cron.deleted', params: { id: 'abc12345' } },
    });
    expect(out).toContain('Deleted cron job abc12345.');
  });

  it('renders the zh-CN display text after a locale switch', () => {
    setLocalePreference('zh-CN');
    const out = renderBody({
      tool_call_id: 'tc',
      output: 'Deleted cron job abc12345.',
      display: { key: 'toolResult.cron.deleted', params: { id: 'abc12345' } },
    });
    expect(out).toContain('已删除定时任务 abc12345。');
    expect(out).not.toContain('Deleted cron job');
  });

  it('falls back to the raw output when the key is unknown to this TUI', () => {
    const out = renderBody({
      tool_call_id: 'tc',
      output: 'Deleted cron job abc12345.',
      display: { key: 'toolResult.cron.futureKey', params: { id: 'abc12345' } },
    });
    expect(out).toContain('Deleted cron job abc12345.');
  });

  it('renders raw output unchanged when there is no display ref', () => {
    const out = renderBody({
      tool_call_id: 'tc',
      output: 'No cron job with id abc12345.',
    });
    expect(out).toContain('No cron job with id abc12345.');
  });

  it('keeps the error tone while showing the localized text', () => {
    setLocalePreference('zh-CN');
    const components = renderTruncated(
      call,
      {
        tool_call_id: 'tc',
        output: 'No cron job with id abc12345.',
        is_error: true,
        display: { key: 'toolResult.cron.notFound', params: { id: 'abc12345' } },
      },
      ctx,
    );
    const raw = components.flatMap((c) => c.render(100)).join('\n');
    expect(strip(raw)).toContain('没有 id 为 abc12345 的定时任务。');
    // The ANSI error colour wraps the localized body, not the raw English.
    expect(raw).not.toContain('No cron job with id');
  });
});

describe('toolResultDisplayText', () => {
  it('prefers the display ref and interpolates its params', () => {
    expect(
      toolResultDisplayText({
        tool_call_id: 'tc',
        output: 'Task #7 was not found in team "core".',
        display: {
          key: 'toolResult.teamTask.notFound',
          params: { id: 7, team: 'core' },
        },
      }),
    ).toBe('Task #7 was not found in team "core".');
  });

  it('returns raw output for unknown keys and missing refs', () => {
    expect(
      toolResultDisplayText({
        tool_call_id: 'tc',
        output: 'raw',
        display: { key: 'toolResult.nope' },
      }),
    ).toBe('raw');
    expect(toolResultDisplayText({ tool_call_id: 'tc', output: 'raw' })).toBe('raw');
  });
});

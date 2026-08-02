import { CURSOR_MARKER } from '@cloud-code/pi-tui';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import chalk from 'chalk';

import { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import { setLocalePreference } from '#/tui/i18n';
import type {
  DiffDisplayBlock,
  FileContentDisplayBlock,
  PendingApproval,
} from '#/tui/reverse-rpc/types';

import { captureProcessWrite } from '../../../helpers/process';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makePending(): PendingApproval {
  return {
    data: {
      id: 'approval_1',
      tool_call_id: 'tool_1',
      tool_name: 'WriteFile',
      action: 'write a file',
      description: 'Update README.md',
      display: [],
      choices: [
        { label: 'Approve once', response: 'approved' },
        { label: 'Approve for this session', response: 'approved_for_session' },
        { label: 'Reject', response: 'rejected' },
        { label: 'Reject with feedback', response: 'rejected', requires_feedback: true },
      ],
    },
  };
}

function makeDialog(): {
  dialog: ApprovalPanelComponent;
  responses: Array<{
    response: string;
    feedback?: string | undefined;
    selected_label?: string | undefined;
  }>;
} {
  const responses: Array<{
    response: string;
    feedback?: string | undefined;
    selected_label?: string | undefined;
  }> = [];
  const dialog = new ApprovalPanelComponent(
    makePending(),
    (response) => responses.push(response),
  );
  return { dialog, responses };
}

describe('ApprovalPanelComponent', () => {
  it('renders only numeric approval shortcuts in the hint', () => {
    const { dialog } = makeDialog();
    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('1/2/3/4 choose');
    expect(out).not.toContain('y/a/n/f');
  });

  it('renders choice descriptions beneath the label when present', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_goal',
        tool_call_id: 'tool_goal',
        tool_name: 'CreateGoal',
        action: 'Creating a goal',
        description: '',
        display: [],
        choices: [
          {
            label: 'Switch to Auto and start',
            response: 'approved',
            selected_label: 'auto',
            description: 'Tools are approved automatically, and questions are skipped.',
          },
          { label: 'Do not start', response: 'cancelled', selected_label: 'cancel' },
        ],
      },
    };
    const out = strip(new ApprovalPanelComponent(pending, () => {}).render(80).join('\n'));
    expect(out).toContain('1. Switch to Auto and start');
    expect(out).toContain('Tools are approved automatically, and questions are skipped.');
    // A choice without a description stays label-only — no stray blank helper line.
    expect(out).toContain('2. Do not start');
  });

  it('renders the worker badge for a bridged teammate ask (A4)', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_teammate',
        tool_call_id: 'tool_teammate',
        tool_name: 'Bash',
        action: 'run',
        description: '',
        display: [],
        choices: [{ label: 'Approve once', response: 'approved' }],
        requester: { name: 'researcher', teamName: 'core' },
      },
    };
    const out = strip(new ApprovalPanelComponent(pending, () => {}).render(80).join('\n'));
    expect(out).toContain('Requested by teammate researcher (team: core)');
  });

  it('renders no badge line for the leader\'s own ask', () => {
    const { dialog } = makeDialog();
    const out = strip(dialog.render(80).join('\n'));
    expect(out).not.toContain('Requested by teammate');
  });

  it('renders search and background_task display blocks in zh-CN', () => {
    setLocalePreference('zh-CN');
    const pending: PendingApproval = {
      data: {
        ...makePending().data,
        display: [
          { type: 'search', query: 'localization sweep', scope: 'src/' },
          {
            type: 'background_task',
            status: 'running',
            kind: 'shell',
            task_id: 'task_9',
            description: 'nightly build',
          },
        ],
      },
    };
    const out = strip(new ApprovalPanelComponent(pending, () => {}).render(80).join('\n'));
    expect(out).toContain('搜索 localization sweep');
    expect(out).toContain('running shell 任务 task_9：nightly build');
    setLocalePreference('en');
  });

  it('renders dangerous shell warnings with simple copy and no icon', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_danger',
        tool_call_id: 'tool_danger',
        tool_name: 'Bash',
        action: 'run',
        description: '',
        display: [
          {
            type: 'shell',
            language: 'bash',
            command: 'rm -rf /tmp/cache',
            danger: 'recursive delete',
          },
        ],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    const dialog = new ApprovalPanelComponent(pending, () => {});

    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('Dangerous: recursive delete');
    expect(out).not.toContain('potentially destructive');
    expect(out).not.toContain('⚠');
  });

  it('wraps a long single-line shell command instead of truncating it', () => {
    const head = 'approve-long-command-head';
    const tail = 'approve-long-command-tail';
    const command = `printf ${head}_${'x'.repeat(220)}_${tail}`;
    const pending: PendingApproval = {
      data: {
        id: 'approval_long_command',
        tool_call_id: 'tool_long_command',
        tool_name: 'Bash',
        action: 'run',
        description: '',
        display: [
          {
            type: 'shell',
            language: 'bash',
            command,
          },
        ],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    const dialog = new ApprovalPanelComponent(pending, () => {});

    const rendered = dialog.render(60);
    const out = strip(rendered.join('\n'));
    expect(rendered.length).toBeGreaterThan(8);
    expect(out).toContain(head);
    expect(out).toContain(tail);
    expect(out).not.toContain('...');
    expect(out).not.toContain('…');
  });

  it('numeric shortcuts still drive approval actions', () => {
    const { dialog, responses } = makeDialog();
    dialog.handleInput('2');
    expect(responses).toEqual([{ response: 'approved_for_session', feedback: undefined }]);
  });

  it('shortcut 4 enters feedback mode and submits the typed feedback', () => {
    const { dialog, responses } = makeDialog();
    dialog.handleInput('4');
    dialog.handleInput('n');
    dialog.handleInput('o');
    dialog.handleInput('\r');
    expect(responses).toEqual([{ response: 'rejected', feedback: 'no' }]);
  });

  it('renders feedback input inline with the selected choice', () => {
    const { dialog } = makeDialog();
    dialog.handleInput('4');

    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('▶ 4. Reject with feedback');
    expect(out).not.toContain('\n  > ');
  });

  it('legacy y/a/n/f shortcuts no longer trigger approval actions', () => {
    for (const key of ['y', 'a', 'n', 'f']) {
      const { dialog, responses } = makeDialog();
      dialog.handleInput(key);
      expect(responses).toEqual([]);
    }
  });

  it('feedback input supports left/right cursor editing', () => {
    const { dialog, responses } = makeDialog();
    dialog.handleInput('4');
    dialog.handleInput('n');
    dialog.handleInput('o');
    dialog.handleInput('\u001B[D');
    dialog.handleInput('!');
    dialog.handleInput('\r');
    expect(responses).toEqual([{ response: 'rejected', feedback: 'n!o' }]);
  });

  it('feedback input keeps editor shortcuts like ctrl+b / ctrl+f', () => {
    const { dialog, responses } = makeDialog();
    dialog.handleInput('4');
    dialog.handleInput('a');
    dialog.handleInput('b');
    dialog.handleInput('c');
    dialog.handleInput('\u0002');
    dialog.handleInput('\u0002');
    dialog.handleInput('X');
    dialog.handleInput('\u0006');
    dialog.handleInput('Y');
    dialog.handleInput('\r');
    expect(responses).toEqual([{ response: 'rejected', feedback: 'aXbYc' }]);
  });

  it('renders an IME cursor marker while editing feedback', () => {
    const { dialog } = makeDialog();
    dialog.focused = true;
    dialog.handleInput('4');

    const out = dialog.render(80).join('\n');
    expect(out).toContain(CURSOR_MARKER);
  });

  it.each(['\u0003', '\u0004', '\u001B'])(
    'shortcut %j rejects approval immediately',
    (key) => {
      const { dialog, responses } = makeDialog();
      dialog.handleInput(key);
      expect(responses).toEqual([{ response: 'rejected' }]);
    },
  );

  it('renders ExitPlanMode with plan-specific header and plan-review choices', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_plan',
        tool_call_id: 'tool_plan',
        tool_name: 'ExitPlanMode',
        action: 'review plan',
        description: '',
        display: [],
        choices: [
          { label: 'Approve', response: 'approved' },
          { label: 'Reject', response: 'rejected' },
          { label: 'Revise', response: 'rejected', requires_feedback: true },
        ],
      },
    };
    const dialog = new ApprovalPanelComponent(pending, () => {});

    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('Ready to build with this plan?');
    expect(out).not.toContain('Approve ExitPlanMode?');
    expect(out).toContain('Approve');
    expect(out).toContain('Reject');
    expect(out).toContain('Revise');
    expect(out).not.toContain('Approve for this session');
    expect(out).not.toContain('Investigate');
  });

  // Inline expand-in-place used to inflate the panel past the viewport on
  // any non-trivial Edit, which then collided with pi-tui's inline scroll
  // and made the terminal flicker / refuse to scroll. The panel now always
  // renders the diff in its compact cluster form; ctrl+e instead asks the
  // host to open a dedicated full-screen preview that can manage its own
  // scrolling.
  it('renders an Edit diff in compact form and asks the host to open a preview on ctrl+e', () => {
    const responses: Array<{ response: string }> = [];
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (let i = 1; i <= 30; i++) {
      oldLines.push(`old${String(i)}`);
      newLines.push(`new${String(i)}`);
    }
    const diffBlock: DiffDisplayBlock = {
      type: 'diff',
      path: 'src/foo.ts',
      old_text: oldLines.join('\n'),
      new_text: newLines.join('\n'),
    };
    const pending: PendingApproval = {
      data: {
        id: 'approval_diff',
        tool_call_id: 'tool_diff',
        tool_name: 'Edit',
        action: 'edit',
        description: '',
        display: [diffBlock],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    let toolOutputToggles = 0;
    const previewCalls: Array<DiffDisplayBlock | FileContentDisplayBlock> = [];
    const dialog = new ApprovalPanelComponent(
      pending,
      (r) => responses.push(r),
      () => toolOutputToggles++,
      (block) => previewCalls.push(block),
    );

    const before = strip(dialog.render(120).join('\n'));
    expect(before).toContain('+30');
    expect(before).toContain('-30');
    expect(before).toContain('ctrl+e preview');
    expect(before).not.toContain('new30'); // compact view stays compact

    dialog.handleInput('\u0005'); // Ctrl+E

    // The panel itself does not expand; it delegates to the host.
    const after = strip(dialog.render(120).join('\n'));
    expect(after).not.toContain('new30');
    expect(after).toContain('ctrl+e preview');
    expect(previewCalls).toEqual([diffBlock]);
    // The unrelated forward-only callback must not fire for ctrl+e.
    expect(toolOutputToggles).toBe(0);
    expect(responses).toEqual([]);
  });

  it('forwards ctrl+o to the global tool-output toggle without affecting the panel', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_forward',
        tool_call_id: 'tool_forward',
        tool_name: 'Edit',
        action: 'edit',
        description: '',
        display: [
          {
            type: 'diff',
            path: 'src/foo.ts',
            old_text: Array.from({ length: 30 }, (_, i) => `old${String(i + 1)}`).join('\n'),
            new_text: Array.from({ length: 30 }, (_, i) => `new${String(i + 1)}`).join('\n'),
          },
        ],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    let globalToggleCalls = 0;
    const dialog = new ApprovalPanelComponent(pending, () => {}, () => globalToggleCalls++);

    dialog.handleInput('\u000F'); // Ctrl+O

    const after = strip(dialog.render(120).join('\n'));
    expect(globalToggleCalls).toBe(1);
    expect(after).toContain('ctrl+e preview');
    expect(after).not.toContain('new30');
  });

  it('does nothing on ctrl+e when there is nothing to preview', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_plan_only',
        tool_call_id: 'tool_plan_only',
        tool_name: 'ExitPlanMode',
        action: 'review plan',
        description: '',
        display: [],
        choices: [{ label: 'Approve', response: 'approved' }],
      },
    };
    const previewCalls: Array<DiffDisplayBlock | FileContentDisplayBlock> = [];
    const dialog = new ApprovalPanelComponent(
      pending,
      () => {},
      undefined,
      (block) => previewCalls.push(block),
    );

    dialog.handleInput('\u0005'); // Ctrl+E
    expect(previewCalls).toEqual([]);
  });

  it('renders Write as a syntax-highlighted code block (file_content), not a diff', () => {
    const responses: Array<{ response: string }> = [];
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`const x${String(i)} = ${String(i)};`);
    const contentBlock: FileContentDisplayBlock = {
      type: 'file_content',
      path: 'src/new.ts',
      content: lines.join('\n'),
    };
    const pending: PendingApproval = {
      data: {
        id: 'approval_write',
        tool_call_id: 'tool_write',
        tool_name: 'Write',
        action: 'write',
        description: '',
        display: [contentBlock],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    const previewCalls: Array<DiffDisplayBlock | FileContentDisplayBlock> = [];
    const dialog = new ApprovalPanelComponent(
      pending,
      (r) => responses.push(r),
      undefined,
      (block) => previewCalls.push(block),
    );

    const collapsed = strip(dialog.render(120).join('\n'));
    // No diff markers, no +N -M header.
    expect(collapsed).not.toMatch(/^\s*\+\d+/m);
    expect(collapsed).not.toMatch(/^\s*-\d+/m);
    expect(collapsed).toContain('src/new.ts');
    expect(collapsed).toContain('const x1 = 1;');
    expect(collapsed).toContain('const x10 = 10;');
    expect(collapsed).not.toContain('const x25 = 25;');
    expect(collapsed).toContain('20 more lines hidden (ctrl+e to preview)');
    expect(collapsed).toContain('ctrl+e preview');

    dialog.handleInput('\u0005'); // Ctrl+E hands off to the host preview.
    const after = strip(dialog.render(120).join('\n'));
    // The panel itself stays compact; the full content is opened elsewhere.
    expect(after).not.toContain('const x30 = 30;');
    expect(previewCalls).toEqual([contentBlock]);
    expect(responses).toEqual([]);
  });

  it('renders unknown file_content extensions as plain text without stderr noise', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_unknown_write',
        tool_call_id: 'tool_unknown_write',
        tool_name: 'Write',
        action: 'write',
        description: '',
        display: [{ type: 'file_content', path: 'demo.abcxyz', content: 'hello\nworld' }],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    const stderr = captureProcessWrite('stderr');
    try {
      const previewCalls: Array<DiffDisplayBlock | FileContentDisplayBlock> = [];
      const dialog = new ApprovalPanelComponent(
        pending,
        () => {},
        undefined,
        (block) => previewCalls.push(block),
      );
      const collapsed = strip(dialog.render(120).join('\n'));
      expect(collapsed).toContain('hello');

      dialog.handleInput('\u0005'); // Ctrl+E
      expect(previewCalls).toHaveLength(1);
      expect(stderr.text()).not.toContain('Could not find the language');
    } finally {
      stderr.restore();
    }
  });

  it('returns feedback for plan-review revise choice', () => {
    const responses: Array<{
      response: string;
      feedback?: string | undefined;
      selected_label?: string | undefined;
    }> = [];
    const pending: PendingApproval = {
      data: {
        id: 'approval_plan',
        tool_call_id: 'tool_plan',
        tool_name: 'ExitPlanMode',
        action: 'review plan',
        description: '',
        display: [],
        choices: [
          { label: 'Approve', response: 'approved' },
          {
            label: 'Revise',
            response: 'rejected',
            selected_label: 'Revise',
            requires_feedback: true,
          },
        ],
      },
    };
    const dialog = new ApprovalPanelComponent(
      pending,
      (response) => responses.push(response),
    );

    dialog.handleInput('2');
    dialog.handleInput('n');
    dialog.handleInput('o');
    dialog.handleInput('\r');
    expect(responses).toEqual([
      { response: 'rejected', feedback: 'no', selected_label: 'Revise' },
    ]);
  });

  it('Esc while typing feedback exits the input first; a second Esc rejects', () => {
    const { dialog, responses } = makeDialog();

    dialog.handleInput('4'); // arms the "Reject with feedback" choice
    dialog.handleInput('x'); // typing reaches the inline input
    expect(responses).toEqual([]);

    // Innermost state first: the first Esc only leaves the feedback input…
    dialog.handleInput('\u001B');
    expect(responses).toEqual([]);

    // …and the draft is discarded — re-arming starts from an empty input.
    dialog.handleInput('4');
    dialog.handleInput('\r');
    expect(responses).toEqual([
      { response: 'rejected', feedback: undefined, selected_label: undefined },
    ]);
  });

  it('Esc outside feedback mode rejects immediately', () => {
    const { dialog, responses } = makeDialog();
    dialog.handleInput('\u001B');
    expect(responses).toEqual([{ response: 'rejected' }]);
  });
});

describe('ApprovalPanelComponent mouse support', () => {
  // chalk auto-disables without a TTY; force colors on so the hover
  // assertions observe real SGR sequences.
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
  });
  afterAll(() => {
    chalk.level = prevLevel;
  });

  /** Component-relative row of the rendered line containing `marker`. */
  function rowOf(dialog: ApprovalPanelComponent, marker: string): number {
    dialog.render(80); // primes the cached choice row ranges
    const lines = dialog.render(80).map(strip);
    const idx = lines.findIndex((line) => line.includes(marker));
    if (idx < 0) throw new Error(`marker not rendered: ${marker}`);
    return idx;
  }

  const press = (dialog: ApprovalPanelComponent, row: number, button = 0): void => {
    dialog.handleMouse({ type: 'press', button, col: 1, row, slotRelative: false });
  };
  const motion = (dialog: ApprovalPanelComponent, row: number): void | boolean =>
    dialog.handleMouse({ type: 'motion', button: 3, col: 1, row, slotRelative: false });

  it('highlights a choice on click and submits it on re-click', () => {
    const { dialog, responses } = makeDialog();
    const approveRow = rowOf(dialog, '1. Approve once');
    const sessionRow = rowOf(dialog, '2. Approve for this session');

    press(dialog, sessionRow); // moves the highlight
    expect(responses).toEqual([]);
    expect(strip(dialog.render(80).join('\n'))).toContain('▶ 2. Approve for this session');

    press(dialog, approveRow); // moves the highlight again
    expect(responses).toEqual([]);

    press(dialog, approveRow); // re-click submits, like Enter
    expect(responses).toEqual([{ response: 'approved', feedback: undefined, selected_label: undefined, mode: undefined }]);
  });

  it('enters feedback mode when a requires-feedback choice is re-clicked', () => {
    const { dialog, responses } = makeDialog();
    const feedbackRow = rowOf(dialog, '4. Reject with feedback');

    press(dialog, feedbackRow);
    expect(responses).toEqual([]);
    press(dialog, feedbackRow); // re-click: not a submit — feedback input opens
    expect(responses).toEqual([]);
    expect(strip(dialog.render(80).join('\n'))).toContain('feedback');

    // While typing feedback a press on another choice leaves feedback mode
    // and highlights it (arrow-key behaviour).
    press(dialog, rowOf(dialog, '1. Approve once'));
    expect(strip(dialog.render(80).join('\n'))).toContain('▶ 1. Approve once');
  });

  it('underlines the hovered choice and clears on leave', () => {
    const { dialog } = makeDialog();
    const rejectRow = rowOf(dialog, '3. Reject');
    const baseline = dialog.render(80).join('\n');

    expect(motion(dialog, rejectRow)).not.toBe(false);
    const hovered = dialog.render(80).join('\n');
    expect(hovered).toContain('[4m');
    expect(hovered).not.toBe(baseline);

    expect(motion(dialog, rejectRow)).toBe(false); // unchanged → frame skipped

    motion(dialog, 0); // header: not a choice row → cleared
    expect(dialog.render(80).join('\n')).toBe(baseline);
  });

  it('ignores presses outside the choice rows and non-left presses', () => {
    const { dialog, responses } = makeDialog();
    press(dialog, 0); // top border
    press(dialog, 1); // title
    press(dialog, rowOf(dialog, '3. Reject'), 2); // right button
    expect(responses).toEqual([]);
    expect(strip(dialog.render(80).join('\n'))).toContain('▶ 1. Approve once');
  });
});

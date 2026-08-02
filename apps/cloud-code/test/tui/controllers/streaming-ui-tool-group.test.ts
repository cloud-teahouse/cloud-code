import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReadGroupComponent } from '#/tui/components/messages/read-group';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { ToolGroupComponent } from '#/tui/components/messages/tool-group';
import { StreamingUIController } from '#/tui/controllers/streaming-ui';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

function makeHost() {
  const children: unknown[] = [];
  const host = {
    state: {
      appState: {
        streamingPhase: 'waiting',
        isCompacting: false,
      },
      livePane: { mode: 'waiting' },
      activitySpinner: null,
      toolOutputExpanded: false,
      ui: { requestRender: vi.fn() },
      transcriptContainer: {
        children,
        addChild: vi.fn((child: unknown) => {
          children.push(child);
        }),
      },
    },
    session: undefined,
    setAppState: vi.fn(),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    updateActivityPane: vi.fn(),
    updateQueueDisplay: vi.fn(),
    requireSession: vi.fn(),
    deferUserMessages: false,
    shiftQueuedMessage: vi.fn(),
    pushTranscriptEntry: vi.fn(),
    mergeCurrentTurnSteps: vi.fn(),
    mergeCompletedTurnAssistants: vi.fn(),
  };
  // oxlint-disable-next-line no-explicit-any -- structural host mock
  return host as any;
}

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
  step = 0,
  turnId = 'turn-1',
): ToolCallBlockData {
  return { id, name, args, step, turnId };
}

function result(id: string, output: string, isError = false): ToolResultBlockData {
  return { tool_call_id: id, output, is_error: isError };
}

describe('StreamingUIController same-tool grouping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('merges consecutive same-step Bash calls into one group card', () => {
    const host = makeHost();
    const controller = new StreamingUIController(host);
    const children = host.state.transcriptContainer.children as unknown[];

    controller.registerToolCall(toolCall('call_bash_1', 'Bash', { command: 'ls -la' }));
    controller.registerToolCall(toolCall('call_bash_2', 'Bash', { command: 'npm test' }));

    const groups = children.filter((c) => c instanceof ToolGroupComponent);
    expect(groups).toHaveLength(1);
    expect((groups[0] as ToolGroupComponent).size()).toBe(2);
    // Both cards collapsed into the group: no standalone tool cards remain.
    expect(children.some((c) => c instanceof ToolCallComponent)).toBe(false);

    const output = strip((groups[0] as ToolGroupComponent).render(120).join('\n'));
    expect(output).toContain('Bash ×2');
    expect(output).toContain('$ ls -la');
    expect(output).toContain('$ npm test');
  });

  it('keeps a single call as a standalone card', () => {
    const host = makeHost();
    const controller = new StreamingUIController(host);
    const children = host.state.transcriptContainer.children as unknown[];

    controller.registerToolCall(toolCall('call_bash_1', 'Bash', { command: 'ls' }));
    controller.completeToolResult('call_bash_1', result('call_bash_1', 'ok\n'));

    expect(children.some((c) => c instanceof ToolGroupComponent)).toBe(false);
    expect(children.filter((c) => c instanceof ToolCallComponent)).toHaveLength(1);
  });

  it('does not merge different tools', () => {
    const host = makeHost();
    const controller = new StreamingUIController(host);
    const children = host.state.transcriptContainer.children as unknown[];

    controller.registerToolCall(toolCall('call_bash_1', 'Bash', { command: 'ls' }));
    controller.registerToolCall(toolCall('call_grep_1', 'Grep', { pattern: 'foo' }));

    expect(children.some((c) => c instanceof ToolGroupComponent)).toBe(false);
    expect(children.filter((c) => c instanceof ToolCallComponent)).toHaveLength(2);
    expect(controller.hasPendingToolGroup()).toBe(true);
  });

  it('breaks the run when assistant text starts between calls', () => {
    const host = makeHost();
    const controller = new StreamingUIController(host);
    const children = host.state.transcriptContainer.children as unknown[];

    controller.registerToolCall(toolCall('call_bash_1', 'Bash', { command: 'ls' }));
    controller.registerToolCall(toolCall('call_bash_2', 'Bash', { command: 'pwd' }));
    controller.completeToolResult('call_bash_1', result('call_bash_1', 'ok\n'));
    controller.completeToolResult('call_bash_2', result('call_bash_2', 'ok\n'));
    controller.onStreamingTextStart();
    controller.registerToolCall(toolCall('call_bash_3', 'Bash', { command: 'whoami' }));

    const groups = children.filter((c) => c instanceof ToolGroupComponent);
    expect(groups).toHaveLength(1);
    expect((groups[0] as ToolGroupComponent).size()).toBe(2);
    // The post-text call renders standalone.
    const standalone = children.filter((c) => c instanceof ToolCallComponent);
    expect(standalone).toHaveLength(1);
    expect((standalone[0] as ToolCallComponent).toolCallView.id).toBe('call_bash_3');
  });

  it('does not merge calls from different steps', () => {
    const host = makeHost();
    const controller = new StreamingUIController(host);
    const children = host.state.transcriptContainer.children as unknown[];

    controller.registerToolCall(toolCall('call_bash_1', 'Bash', { command: 'ls' }, 0));
    controller.registerToolCall(toolCall('call_bash_2', 'Bash', { command: 'pwd' }, 1));

    expect(children.some((c) => c instanceof ToolGroupComponent)).toBe(false);
    expect(children.filter((c) => c instanceof ToolCallComponent)).toHaveLength(2);
  });

  it('grows the group live while the run continues and settles when results land', () => {
    const host = makeHost();
    const controller = new StreamingUIController(host);
    const children = host.state.transcriptContainer.children as unknown[];

    controller.registerToolCall(toolCall('call_bash_1', 'Bash', { command: 'ls' }));
    controller.registerToolCall(toolCall('call_bash_2', 'Bash', { command: 'pwd' }));
    controller.registerToolCall(toolCall('call_bash_3', 'Bash', { command: 'whoami' }));

    const group = children.find((c) => c instanceof ToolGroupComponent) as ToolGroupComponent;
    expect(group.size()).toBe(3);
    expect(strip(group.render(120).join('\n'))).toContain('Bash ×3 · 3 running…');

    controller.completeToolResult('call_bash_1', result('call_bash_1', 'ok\n'));
    controller.completeToolResult('call_bash_2', result('call_bash_2', 'ok\n'));
    controller.completeToolResult('call_bash_3', result('call_bash_3', 'boom\n', true));

    const output = strip(group.render(120).join('\n'));
    expect(output).toContain('Bash ×3 · 1 failed');
    expect(output).toContain('$ whoami · failed');
    expect(output).not.toContain('running…');
  });

  it('clears pending group state on resetToolUi', () => {
    const host = makeHost();
    const controller = new StreamingUIController(host);

    controller.registerToolCall(toolCall('call_bash_1', 'Bash', { command: 'ls' }));
    expect(controller.hasPendingToolGroup()).toBe(true);

    controller.resetToolUi();
    expect(controller.hasPendingToolGroup()).toBe(false);
  });

  it('keeps Read calls on the read group instead of the generic group', () => {
    const host = makeHost();
    const controller = new StreamingUIController(host);
    const children = host.state.transcriptContainer.children as unknown[];

    controller.registerToolCall(toolCall('call_read_1', 'Read', { file_path: 'a.ts' }));
    controller.registerToolCall(toolCall('call_read_2', 'Read', { file_path: 'b.ts' }));

    expect(children.some((c) => c instanceof ReadGroupComponent)).toBe(true);
    expect(children.some((c) => c instanceof ToolGroupComponent)).toBe(false);
  });
});

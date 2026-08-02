import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CompactionComponent } from '#/tui/components/dialogs/compaction';
import { TurnCompletionComponent } from '#/tui/components/messages/turn-completion';
import { StreamingUIController } from '#/tui/controllers/streaming-ui';
import { TURN_COMPLETION_SYMBOLS } from '#/tui/utils/turn-completion';

function makeHost() {
  const children: unknown[] = [];
  const host = {
    state: {
      appState: {
        streamingPhase: 'waiting',
        isCompacting: true,
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
  };
  // oxlint-disable-next-line no-explicit-any -- structural host mock
  return host as any;
}

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('StreamingUIController compaction completion line', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('appends a gray "<symbol> <verb> for <duration>" line after a completed compaction', () => {
    const host = makeHost();
    const controller = new StreamingUIController(host);

    controller.beginCompaction();
    vi.advanceTimersByTime(8_000);
    controller.endCompaction(12_000, 4_000);

    const children = host.state.transcriptContainer.children as unknown[];
    expect(children.some((child) => child instanceof CompactionComponent)).toBe(true);
    const line = children.find((child) => child instanceof TurnCompletionComponent);
    expect(line).toBeDefined();
    const rendered = (line as TurnCompletionComponent).render(120).map((l) => strip(l));
    expect(rendered[0]).toBe('');
    const body = rendered[1]!.trim();
    expect(TURN_COMPLETION_SYMBOLS).toContain(body.slice(0, 1));
    expect(body).toMatch(/for 8s$/);
  });

  it('leaves no completion line when the compaction is cancelled', () => {
    const host = makeHost();
    const controller = new StreamingUIController(host);

    controller.beginCompaction();
    vi.advanceTimersByTime(8_000);
    controller.cancelCompaction();

    const children = host.state.transcriptContainer.children as unknown[];
    expect(children.some((child) => child instanceof TurnCompletionComponent)).toBe(false);
  });

  it('ignores an end event without an active compaction', () => {
    const host = makeHost();
    const controller = new StreamingUIController(host);

    controller.endCompaction(12_000, 4_000);

    const children = host.state.transcriptContainer.children as unknown[];
    expect(children).toHaveLength(0);
  });
});

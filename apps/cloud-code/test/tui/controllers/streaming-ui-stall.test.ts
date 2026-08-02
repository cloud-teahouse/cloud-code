import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  STREAM_STALL_CHECK_INTERVAL_MS,
  STREAM_STALL_THRESHOLD_MS,
} from '#/tui/constant/streaming';
import { StreamingUIController } from '#/tui/controllers/streaming-ui';

interface StallHostOptions {
  streamingPhase: 'idle' | 'waiting' | 'thinking' | 'composing' | 'shell';
  livePaneMode: 'idle' | 'waiting' | 'thinking' | 'tool' | 'session';
  isCompacting?: boolean;
}

function makeStallHost(options: StallHostOptions) {
  let stalled = false;
  const spinner = {
    setStalled: vi.fn((value: boolean) => {
      stalled = value;
    }),
    isStalled: () => stalled,
  };
  const host = {
    state: {
      appState: {
        streamingPhase: options.streamingPhase,
        isCompacting: options.isCompacting ?? false,
      },
      livePane: { mode: options.livePaneMode },
      activitySpinner: { instance: spinner, style: 'moon' },
      ui: { requestRender: vi.fn() },
      transcriptContainer: { children: [] },
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
  return { host: host as any, spinner };
}

describe('StreamingUIController stall detection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks the spinner stalled after 3s without tokens while waiting', () => {
    const { host, spinner } = makeStallHost({ streamingPhase: 'waiting', livePaneMode: 'waiting' });
    const controller = new StreamingUIController(host);

    controller.noteTokenActivity();
    vi.advanceTimersByTime(STREAM_STALL_THRESHOLD_MS + STREAM_STALL_CHECK_INTERVAL_MS);

    expect(spinner.setStalled).toHaveBeenCalledWith(true);
  });

  it('clears the stalled state as soon as fresh tokens arrive', () => {
    const { host, spinner } = makeStallHost({
      streamingPhase: 'composing',
      livePaneMode: 'idle',
    });
    const controller = new StreamingUIController(host);

    controller.noteTokenActivity();
    vi.advanceTimersByTime(STREAM_STALL_THRESHOLD_MS + STREAM_STALL_CHECK_INTERVAL_MS);
    expect(spinner.setStalled).toHaveBeenLastCalledWith(true);

    controller.noteTokenActivity();
    expect(spinner.setStalled).toHaveBeenLastCalledWith(false);
  });

  it('does not stall while a tool is running (no tokens by design)', () => {
    const { host, spinner } = makeStallHost({ streamingPhase: 'composing', livePaneMode: 'tool' });
    const controller = new StreamingUIController(host);

    controller.noteTokenActivity();
    vi.advanceTimersByTime(STREAM_STALL_THRESHOLD_MS * 3);

    expect(spinner.setStalled).not.toHaveBeenCalledWith(true);
  });

  it('does not stall during `!` shell commands or compaction', () => {
    const { host, spinner } = makeStallHost({
      streamingPhase: 'shell',
      livePaneMode: 'waiting',
      isCompacting: true,
    });
    const controller = new StreamingUIController(host);

    controller.noteTokenActivity();
    vi.advanceTimersByTime(STREAM_STALL_THRESHOLD_MS * 3);

    expect(spinner.setStalled).not.toHaveBeenCalledWith(true);
  });

  it('stops the watchdog and un-stalls when the stream goes idle', () => {
    const { host, spinner } = makeStallHost({ streamingPhase: 'waiting', livePaneMode: 'waiting' });
    const controller = new StreamingUIController(host);

    controller.noteTokenActivity();
    vi.advanceTimersByTime(STREAM_STALL_THRESHOLD_MS + STREAM_STALL_CHECK_INTERVAL_MS);
    expect(spinner.setStalled).toHaveBeenLastCalledWith(true);

    host.state.appState.streamingPhase = 'idle';
    vi.advanceTimersByTime(STREAM_STALL_CHECK_INTERVAL_MS);

    expect(spinner.setStalled).toHaveBeenLastCalledWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

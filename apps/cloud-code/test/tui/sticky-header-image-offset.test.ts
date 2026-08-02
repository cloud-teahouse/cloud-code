/**
 * Sticky prompt header × inline (kitty) images — scroll-offset unit consistency.
 *
 * The sticky header provider in tui-state.ts accumulates each transcript
 * child's `render(innerWidth).length` to compute `jumpTo`, and pi-tui applies
 * `jumpTo` as `scrollTop` — an index into `scroll.render(width)`'s output
 * array (composeFullscreenFrame slices that array by scrollTop/viewportHeight).
 *
 * For the jump to land exactly, two invariants must hold:
 *   1. A kitty image occupies as many RENDER LINES as terminal rows. pi-tui's
 *      Image component emits the escape line plus `rows - 1` placeholder
 *      lines, so the render-array index space is the terminal-row space. If
 *      that ever regressed (one escape line for an N-row image), every offset
 *      below the image would drift by N-1.
 *   2. The provider sums the same children at the same inner width the
 *      GutterContainer scroll region uses (width - CHROME_GUTTER * 2), so its
 *      accumulated offsets are indices into the same line array.
 *
 * These tests pin both invariants plus the end-to-end click path.
 */

import {
  resetCapabilitiesCache,
  setCapabilities,
  setCellDimensions,
  Text,
} from '@cloud-code/pi-tui';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UserMessageComponent } from '#/tui/components/messages/user-message';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { createTUIState, type TUIState } from '#/tui/tui-state';
import type { AppState, CloudCodeTUIOptions, TranscriptEntry } from '#/tui/types';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';
import { markTranscriptComponent } from '#/tui/utils/transcript-component-metadata';

const WIDTH = 80;
const INNER_WIDTH = WIDTH - CHROME_GUTTER * 2;

type StickyHeaderResult = { line: string; jumpTo?: number } | null;
type StickyHeaderProvider = (
  width: number,
  scrollTop: number,
  viewportHeight: number,
) => StickyHeaderResult;

/** Access the provider registered by createTUIState (private on TUI). */
function stickyProvider(state: TUIState): StickyHeaderProvider {
  return (state.ui as unknown as { stickyHeaderContent: StickyHeaderProvider }).stickyHeaderContent;
}

function fakeInitialAppState(): AppState {
  return {
    model: 'test-model',
    workDir: '/tmp/kimi-test',
    additionalDirs: [],
    sessionId: 'sess-1',
    permissionMode: 'manual',
    planMode: false,
    inputMode: 'prompt',
    swarmMode: false,
    coordinatorMode: false,
    thinkingEffort: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: 'dark',
    language: 'auto',
    version: '0.0.0-test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    upgrade: { autoInstall: true },
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    mcpServersSummary: null,
  };
}

function makeState(): TUIState {
  const opts: CloudCodeTUIOptions = {
    initialAppState: fakeInitialAppState(),
    startup: { continueLast: false, yolo: false, auto: false, plan: false },
  };
  const state = createTUIState(opts);
  // initMainTui mounts the root on the ui; createTUIState alone leaves it
  // detached, and pi-tui treats unmounted regions as a takeover frame.
  state.ui.addChild(state.rootContainer);
  return state;
}

/** Minimal PNG bytes (signature + IHDR); dimensions are passed explicitly. */
function fakePngAttachment(): ImageAttachment {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR length + type
    0x00, 0x00, 0x07, 0xd0, 0x00, 0x00, 0x05, 0x16, // 2000 x 1302
    0x08, 0x02, 0x00, 0x00, 0x00,
  ]);
  return {
    id: 1,
    kind: 'image',
    bytes,
    mime: 'image/png',
    width: 2000,
    height: 1302,
    placeholder: '[image #1 (2000×1302)]',
  };
}

function userEntry(content: string): TranscriptEntry {
  return { id: `entry-${content}`, kind: 'user', renderMode: 'plain', content };
}

const USER_2_TEXT = 'second prompt: now summarise it';

interface BuiltTranscript {
  state: TUIState;
  user1: UserMessageComponent;
  user2: UserMessageComponent;
}

/**
 * intro (1) + user1 [text + 12-row image] + filler (10) + user2 (2) + tail (40).
 * user2's first render line sits at scroll-region index 1 + (1+1+12) + 10 = 25.
 */
function buildTranscript(): BuiltTranscript {
  const state = makeState();
  const user1 = new UserMessageComponent('first prompt: please look at this screenshot', [
    fakePngAttachment(),
  ]);
  const user2 = new UserMessageComponent(USER_2_TEXT, []);
  markTranscriptComponent(user1, userEntry('first prompt: please look at this screenshot'));
  markTranscriptComponent(user2, userEntry(USER_2_TEXT));

  state.transcriptContainer.addChild(new Text('intro answer', 0, 0));
  state.transcriptContainer.addChild(user1);
  state.transcriptContainer.addChild(new Text(Array.from({ length: 10 }, (_, i) => `filler ${i}`).join('\n'), 0, 0));
  state.transcriptContainer.addChild(user2);
  state.transcriptContainer.addChild(new Text(Array.from({ length: 40 }, (_, i) => `tail ${i}`).join('\n'), 0, 0));
  return { state, user1, user2 };
}

/** Index of the message's first render line inside the scroll region's own
 *  render output — the oracle pi-tui's scrollTop accounting actually uses. */
function scrollRegionStartOf(state: TUIState, child: UserMessageComponent, text: string): number {
  const scrollLines = state.transcriptContainer.render(WIDTH);
  const flatIndex = scrollLines.findIndex((line) => line.includes(text));
  expect(flatIndex).toBeGreaterThanOrEqual(0);
  const childLines = child.render(INNER_WIDTH);
  const intraChild = childLines.findIndex((line) => line.includes(text));
  expect(intraChild).toBeGreaterThanOrEqual(0);
  return flatIndex - intraChild;
}

function kittyRowsOf(line: string): number {
  const match = /(?:^|[,;])r=(\d+)/.exec(line);
  expect(match).not.toBeNull();
  return Number(match![1]);
}

describe('sticky header jumpTo with kitty images in the transcript', () => {
  beforeEach(() => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    setCellDimensions({ widthPx: 10, heightPx: 20 });
  });

  afterEach(() => {
    resetCapabilitiesCache();
  });

  it('a kitty image occupies as many render lines as its terminal rows', () => {
    const { user1 } = buildTranscript();
    const lines = user1.render(INNER_WIDTH);
    const imageIndex = lines.findIndex((line) => line.includes('\u001B_G'));
    expect(imageIndex).toBeGreaterThanOrEqual(0);

    const rows = kittyRowsOf(lines[imageIndex]!);
    expect(rows).toBeGreaterThan(1);
    // The escape line plus its placeholder lines must span exactly `rows`
    // render lines, or every sticky offset below the image drifts by the
    // difference (render-array indices are the scrollTop unit).
    expect(lines.length - imageIndex).toBe(rows);
  });

  it('jumpTo equals the anchored message’s line index in the scroll region render', () => {
    const { state, user2 } = buildTranscript();
    const expectedStart = scrollRegionStartOf(state, user2, USER_2_TEXT);

    // Scrolled so user2's start is above the viewport top.
    const scrollTop = expectedStart + 2;
    const viewportHeight = 20;
    const header = stickyProvider(state)(WIDTH, scrollTop, viewportHeight);

    expect(header).not.toBeNull();
    expect(header!.jumpTo).toBe(expectedStart);
  });

  it('clicking the sticky header lands the viewport exactly on the anchored message', () => {
    const { state, user2 } = buildTranscript();
    const expectedStart = scrollRegionStartOf(state, user2, USER_2_TEXT);

    const ui = state.ui as unknown as {
      followOutput: boolean;
      scrollTop: number;
      stickyJumpTo: number | null;
      stickyHeaderVisible: boolean;
      composeFullscreenFrame(width: number, height: number): string[];
      handleFullscreenMouse(event: {
        type: 'press';
        button: 0;
        col: number;
        row: number;
        slotRelative: boolean;
      }): void;
    };

    // Scrolled up past the anchored message; slot is empty so viewportHeight
    // equals the frame height.
    const height = 20;
    ui.followOutput = false;
    ui.scrollTop = expectedStart + 2;
    ui.composeFullscreenFrame(WIDTH, height);
    expect(ui.stickyHeaderVisible).toBe(true);
    expect(ui.stickyJumpTo).toBe(expectedStart);

    ui.handleFullscreenMouse({ type: 'press', button: 0, col: 5, row: 1, slotRelative: false });

    const frame = ui.composeFullscreenFrame(WIDTH, height);
    // Exact landing: the message's spacer row sits at the viewport top and
    // its first text row directly below — an off-by-N drift would shift both.
    expect(frame[0]).not.toContain(USER_2_TEXT);
    expect(frame[1]).toContain(USER_2_TEXT);
    // The anchored message is itself visible now, so the header dedups away.
    expect(ui.stickyHeaderVisible).toBe(false);
  });
});

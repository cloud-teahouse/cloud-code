/**
 * Hit-zone tests for FooterComponent: the model / cwd / context segments are
 * clickable once the host wires actions via setActions(). Zones are a render
 * by-product (validated against the rendered text), dispatch routes to the
 * matching action, and branch / tips / badges stay non-clickable.
 */

import chalk from 'chalk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hitZoneAt, type MouseEvent } from '@cloud-code/pi-tui';

import { FooterComponent, type FooterActions } from '#/tui/components/chrome/footer';
import type { AppState } from '#/tui/types';

// oxlint-disable-next-line no-control-regex -- ESC (\x1b) is required to match ANSI SGR escape sequences
const strip = (s: string): string => s.replaceAll(/\u001B\[[0-9;]*m/g, '');

const appState: AppState = {
  version: '1.2.3',
  workDir: '/tmp/project',
  additionalDirs: [],
  sessionId: 'ses-1',
  sessionTitle: null,
  model: 'kimi-k2',
  permissionMode: 'manual',
  thinkingEffort: 'off',
  contextUsage: 0,
  contextTokens: 0,
  maxContextTokens: 0,
  isCompacting: false,
  isReplaying: false,
  streamingPhase: 'idle',
  streamingStartTime: 0,
  planMode: false,
  inputMode: 'prompt',
  swarmMode: false,
  coordinatorMode: false,
  theme: 'dark',
  language: 'auto',
  editorCommand: null,
  notifications: { enabled: true, condition: 'unfocused' },
  upgrade: { autoInstall: true },
  availableModels: {
    'kimi-k2': {
      provider: 'managed:chatgpt-codex',
      model: 'kimi-k2',
      maxContextSize: 272000,
      serviceTiers: ['priority'],
    },
  },
  availableProviders: {
    'managed:chatgpt-codex': { type: 'openai_responses', baseUrl: 'https://chatgpt.com/backend-api/codex' },
  },
  mcpServersSummary: null,
};

function makeFooter(actions?: FooterActions, state: AppState = appState) {
  const footer = new FooterComponent({ ...state });
  if (actions !== undefined) footer.setActions(actions);
  return footer;
}

function actionMocks() {
  return {
    openModelPicker: vi.fn(),
    copyWorkDir: vi.fn(),
    openStatus: vi.fn(),
  };
}

function pressEvent(row: number, col: number): MouseEvent {
  return { type: 'press', button: 0, col, row, slotRelative: true };
}

/** The dispatch the TUI performs for a left-press at a component-relative cell. */
function dispatchPress(footer: FooterComponent, row: number, col: number): void | boolean {
  const zone = hitZoneAt(footer.hitZones(), row, col, 'action');
  if (zone === null) return false;
  return footer.onHitZone(zone.id, pressEvent(row, col));
}

describe('FooterComponent hit zones', () => {
  beforeEach(() => {
    chalk.level = 3;
  });

  it('declares no zones until actions are wired, and recomputes them once wired', () => {
    const footer = makeFooter();
    footer.render(80);
    expect([...footer.hitZones()]).toEqual([]);

    // Wiring actions must invalidate the render cache: the lines are
    // signature-identical, but the zones only exist after this point.
    footer.setActions(actionMocks());
    footer.render(80);
    expect([...footer.hitZones()].map((z) => z.id)).toEqual(['model', 'cwd', 'context']);
  });

  it('aligns the model and cwd zones with the rendered segments on line 1', () => {
    const footer = makeFooter(actionMocks());
    const lines = footer.render(80).map(strip);
    const zones = [...footer.hitZones()];
    const model = zones.find((z) => z.id === 'model')!;
    const cwd = zones.find((z) => z.id === 'cwd')!;

    expect(model.row).toBe(0);
    expect(lines[0]!.slice(model.col - 1, model.col - 1 + model.width)).toBe('kimi-k2');

    expect(cwd.row).toBe(0);
    expect(lines[0]!.slice(cwd.col - 1, cwd.col - 1 + cwd.width)).toBe('/tmp/project');
    // The cwd zone sits one two-cell gap after the model zone.
    expect(cwd.col).toBe(model.col + model.width + 2);
  });

  it('anchors the context zone to the right-aligned segment on line 2', () => {
    const footer = makeFooter(actionMocks());
    const lines = footer.render(80).map(strip);
    const context = [...footer.hitZones()].find((z) => z.id === 'context')!;

    expect(context.row).toBe(1);
    // Right-aligned: the zone ends at the last cell of the line.
    expect(context.col + context.width - 1).toBe(80);
    const covered = lines[1]!.slice(context.col - 1, context.col - 1 + context.width);
    expect(covered.trim().length).toBeGreaterThan(0);
    expect(covered).toContain('0%');
  });

  it('marks every zone press-only (no hover tracking on the status bar)', () => {
    const footer = makeFooter(actionMocks());
    footer.render(80);
    for (const zone of footer.hitZones()) {
      expect(zone.semantics?.hover).toBe(false);
    }
    // …so pointer-motion hit-tests never match, mirroring the TUI's lookup.
    expect(hitZoneAt(footer.hitZones(), 0, 1, 'hover')).toBeNull();
  });

  it('dispatches segment presses to their actions', () => {
    const actions = actionMocks();
    const footer = makeFooter(actions);
    const lines = footer.render(80).map(strip);

    dispatchPress(footer, 0, lines[0]!.indexOf('kimi-k2') + 1);
    expect(actions.openModelPicker).toHaveBeenCalledTimes(1);

    dispatchPress(footer, 0, lines[0]!.indexOf('/tmp/project') + 1);
    expect(actions.copyWorkDir).toHaveBeenCalledTimes(1);

    const context = [...footer.hitZones()].find((z) => z.id === 'context')!;
    dispatchPress(footer, 1, context.col);
    expect(actions.openStatus).toHaveBeenCalledTimes(1);
  });

  it('keeps tips, git, and badge areas non-clickable', () => {
    const actions = actionMocks();
    const footer = makeFooter(actions);
    const lines = footer.render(80).map(strip);
    // Far-right tip text on line 1 and the gap between segments hit no zone.
    expect(dispatchPress(footer, 0, 80)).toBe(false);
    expect(dispatchPress(footer, 0, lines[0]!.indexOf('kimi-k2') + 8)).toBe(false);
    // Line 2 left of the context segment is empty padding.
    expect(dispatchPress(footer, 1, 1)).toBe(false);
    expect(actions.openModelPicker).not.toHaveBeenCalled();
    expect(actions.openStatus).not.toHaveBeenCalled();
  });

  it('drops line-1 zones when the segment row overflows and is truncated', () => {
    const footer = makeFooter(actionMocks());
    footer.render(20);
    const ids = [...footer.hitZones()].map((z) => z.id);
    expect(ids).not.toContain('model');
    expect(ids).not.toContain('cwd');
  });

  it('tracks segment positions across state changes', () => {
    const footer = makeFooter(actionMocks());
    footer.render(80);
    footer.setState({ ...appState, permissionMode: 'yolo' });
    const lines = footer.render(80).map(strip);
    const model = [...footer.hitZones()].find((z) => z.id === 'model')!;
    // The yolo badge now precedes the model; the zone still covers the label.
    expect(lines[0]!.slice(model.col - 1, model.col - 1 + model.width)).toBe('kimi-k2');
    expect(lines[0]!.indexOf('yolo')).toBeLessThan(model.col - 1);
  });

  it('returns false for unknown zone ids and when actions are unset', () => {
    const footer = makeFooter();
    expect(footer.onHitZone('model', pressEvent(0, 1))).toBe(false);
    const wired = makeFooter(actionMocks());
    expect(wired.onHitZone('nope', pressEvent(0, 1))).toBe(false);
  });
});

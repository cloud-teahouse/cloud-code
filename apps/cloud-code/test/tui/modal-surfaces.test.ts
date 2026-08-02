// Modal surface semantics matrix — locks the cross-mechanism invariants defined
// in docs/tui-modal-surfaces.md:
// - blocking surfaces (approval/question) are never preempted, queued behind,
//   or hidden by any other surface
// - Esc peels the focused (innermost) surface first across stacked mechanisms
// - dismissing a surface returns focus to the surface beneath it (slot content,
//   parent takeover, overlay preFocus)
// - mouse presses only ever reach the focused surface; hidden snapshot trees
//   and covered transcript content can't be hit through
//
// Mechanism-① internals (owner/preempt/queue interleavings) are locked in
// editor-slot-ownership.test.ts; mouse coordinate math lives in pi-tui's
// tui-fullscreen.test.ts. This file covers the stacked combinations.

import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Container,
  TUI,
  type Component,
  type Focusable,
  type MouseEvent,
  type Terminal,
} from '@cloud-code/pi-tui';
import type { ApprovalRequest, ApprovalResponse } from '@cloud-code/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import {
  ApprovalPreviewViewer,
  type ApprovalPreviewBlock,
} from '#/tui/components/dialogs/approval-preview';
import { HelpPanelComponent } from '#/tui/components/dialogs/help-panel';
import { QuestionDialogComponent } from '#/tui/components/dialogs/question-dialog';
import { CloudCodeTUI, type CloudCodeTUIStartupInput, type TUIState } from '#/tui/cloud-code-tui';
import type { TasksBrowserController } from '#/tui/controllers/tasks-browser';
import type { TeamsBrowserController } from '#/tui/controllers/teams-browser';
import type { WorkflowsBrowserController } from '#/tui/controllers/workflows-browser';

interface MatrixDriver {
  state: TUIState;
  init(): Promise<boolean>;
  showHelpPanel(): void;
  hideHelpPanel(): void;
  restoreEditor(handle?: { id: number }): void;
  hasBlockingEditorSlotPanel(): boolean;
  readonly tasksBrowserController: TasksBrowserController;
  readonly workflowsBrowserController: WorkflowsBrowserController;
  readonly teamsBrowserController: TeamsBrowserController;
  activeApprovalPanel: ApprovalPanelComponent | undefined;
  openApprovalPreview(panel: ApprovalPanelComponent, block: ApprovalPreviewBlock): void;
}

function makeStartupInput(): CloudCodeTUIStartupInput {
  return {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
      agent: undefined,
      agentFiles: [],
    },
    tuiConfig: {
      theme: 'dark',
      language: 'auto',
      disablePasteBurst: false,
      fullscreen: true,
      editorCommand: null,
      vimMode: false,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
    },
    version: '0.0.0-test',
    workDir: '/tmp/proj-a',
  };
}

function makeSession() {
  return {
    id: 'ses-1',
    model: 'k2',
    summary: { title: null },
    prompt: vi.fn(async (_input: unknown) => {}),
    compact: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    init: vi.fn(async () => {}),
    startBtw: vi.fn(async () => 'agent-btw'),
    undoHistory: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    cancelCompaction: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({
      model: 'k2',
      thinkingEffort: 'off',
      permission: 'manual',
      planMode: false,
      contextTokens: 0,
      maxContextTokens: 100,
      contextUsage: 0,
    })),
    getGoal: vi.fn(async () => ({ goal: null })),
    setApprovalHandler: vi.fn(),
    setQuestionHandler: vi.fn(),
    setModel: vi.fn(async () => {}),
    setThinking: vi.fn(async () => {}),
    setPermission: vi.fn(async () => {}),
    setPlanMode: vi.fn(async () => {}),
    setSwarmMode: vi.fn(async () => {}),
    onEvent: vi.fn(() => vi.fn()),
    listMcpServers: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    listBackgroundTasks: vi.fn(async () => []),
    getBackgroundTaskOutput: vi.fn(async () => 'output'),
    getResumeState: vi.fn(() => ({
      sessionMetadata: {},
      agents: {
        main: {
          status: {
            model: 'k2',
            thinkingEffort: 'off',
            permission: 'manual',
            planMode: false,
            contextTokens: 0,
            maxContextTokens: 100,
            contextUsage: 0,
          },
          context: { history: [] },
          replay: [],
        },
      },
    })),
    close: vi.fn(async () => {}),
    listPlugins: vi.fn(async () => []),
    reloadPlugins: vi.fn(async () => ({ added: [], removed: [], errors: [] })),
    reloadSession: vi.fn(async () => ({})),
    activateSkill: vi.fn(async () => {}),
  };
}

function makeHarness(session: ReturnType<typeof makeSession>) {
  const interactiveAgentScope = new AsyncLocalStorage<string>();
  return {
    getConfig: vi.fn(async () => ({
      models: { k2: { model: 'moonshot-v1', maxContextSize: 100 } },
    })),
    setConfig: vi.fn(async () => ({ providers: {} })),
    createSession: vi.fn(async () => session),
    resumeSession: vi.fn(async () => session),
    forkSession: vi.fn(async () => session),
    listSessions: vi.fn(async () => []),
    exportSession: vi.fn(async () => ({
      zipPath: '/tmp/fake-session.zip',
      entries: ['manifest.json', 'state.json', 'sessionDir', 'manifest'] as never,
      sessionDir: '/tmp/session-a',
      manifest: {},
    })),
    close: vi.fn(async () => {}),
    get interactiveAgentId() {
      return interactiveAgentScope.getStore() ?? 'main';
    },
    withInteractiveAgent: vi.fn((agentId: string, fn: () => unknown) => {
      return interactiveAgentScope.run(agentId, fn);
    }),
    getExperimentalFeatures: vi.fn(async () => []),
    auth: {
      status: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getManagedUsage: vi.fn(),
      submitFeedback: vi.fn(async () => ({ kind: 'ok', feedbackId: 3 })),
    },
  };
}

const tempDirs: string[] = [];

async function makeDriver(session = makeSession()): Promise<{
  driver: MatrixDriver;
  session: ReturnType<typeof makeSession>;
}> {
  process.env['CLOUD_CODE_HOME'] = await mkdtemp(join(tmpdir(), 'cloud-code-modal-')).then((dir) => {
    tempDirs.push(dir);
    return dir;
  });
  const driver = new CloudCodeTUI(
    makeHarness(session) as never,
    makeStartupInput(),
  ) as unknown as MatrixDriver;
  vi.spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
  vi.spyOn(driver.state.terminal, 'setProgress').mockImplementation(() => {});
  await driver.init();
  // Mount the editor into the slot the way initMainTui does, without running
  // the event loop.
  driver.state.editorContainer.clear();
  driver.state.editorContainer.addChild(driver.state.editor);
  driver.state.ui.setFocus(driver.state.editor);
  return { driver, session };
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  delete process.env['CLOUD_CODE_HOME'];
});

function approvalHandlerOf(
  session: ReturnType<typeof makeSession>,
): (request: ApprovalRequest) => Promise<ApprovalResponse> {
  const handler = vi.mocked(session.setApprovalHandler).mock.calls[0]?.[0] as
    | ((request: ApprovalRequest) => Promise<ApprovalResponse>)
    | undefined;
  if (handler === undefined) throw new Error('expected approval handler');
  return handler;
}

function questionHandlerOf(session: ReturnType<typeof makeSession>) {
  const handler = vi.mocked(session.setQuestionHandler).mock.calls[0]?.[0] as
    | ((request: unknown) => Promise<unknown>)
    | undefined;
  if (handler === undefined) throw new Error('expected question handler');
  return handler;
}

function makeApprovalRequest(id: string): ApprovalRequest {
  return {
    turnId: 1,
    toolCallId: id,
    toolName: 'Bash',
    action: 'Run shell command',
    display: {
      kind: 'generic',
      summary: 'Run shell command',
      detail: { command: 'echo ok', description: 'Run a shell command' },
    },
  } as ApprovalRequest;
}

function slotChild(driver: MatrixDriver): unknown {
  return driver.state.editorContainer.children[0];
}

// Fullscreen dialog-kind panels float as bottom-anchored overlays (the editor
// stays in the slot): the panel is the single child of the overlay's chrome
// surface. Blocking panels still mount into the slot (slotChild above).
function floatingDialog(driver: MatrixDriver): unknown {
  const stack = (
    driver.state.ui as unknown as { overlayStack: { component: Container }[] }
  ).overlayStack;
  return stack.length === 0 ? undefined : stack[stack.length - 1]!.component.children[0];
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const ESC = '\u001B';

describe('modal surfaces — slot panels × blocking mounts', () => {
  it('a blocking approval preempts a floating dialog; answering restores the editor', async () => {
    const { driver, session } = await makeDriver();
    driver.showHelpPanel();
    const help = floatingDialog(driver) as HelpPanelComponent;
    expect(help).toBeInstanceOf(HelpPanelComponent);
    expect(help.focused).toBe(true);
    // Floating: the editor never left the slot.
    expect(slotChild(driver)).toBe(driver.state.editor);

    const response = approvalHandlerOf(session)(makeApprovalRequest('call_1'));
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBeInstanceOf(ApprovalPanelComponent);
    });
    const panel = slotChild(driver) as ApprovalPanelComponent;
    // Preemption hid the overlay, ran the dialog's cancel semantics and moved focus.
    expect(driver.state.ui.hasOverlay()).toBe(false);
    expect(help.focused).toBe(false);
    expect(panel.focused).toBe(true);
    expect(driver.state.activeDialog).toBeNull();

    panel.handleInput('1');
    await expect(response).resolves.toMatchObject({ decision: 'approved' });
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBe(driver.state.editor);
    });
    expect(driver.state.editor.focused).toBe(true);
  });

  it('a blocking mount wins over a drained dialog, which closes via its cancel semantics', async () => {
    const { driver, session } = await makeDriver();

    const approvalResponse = approvalHandlerOf(session)(makeApprovalRequest('call_1'));
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBeInstanceOf(ApprovalPanelComponent);
    });

    const questionResponse = questionHandlerOf(session)({
      toolCallId: 'q1',
      questions: [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
    });
    driver.showHelpPanel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Both pending; the approval keeps the slot and the keyboard.
    expect(slotChild(driver)).toBeInstanceOf(ApprovalPanelComponent);

    (slotChild(driver) as ApprovalPanelComponent).handleInput('1');
    await expect(approvalResponse).resolves.toMatchObject({ decision: 'approved' });
    // A drained dialog loses to the blocking question mount: it is closed
    // through its own cancel semantics (preempt), not re-queued — blocking
    // surfaces always win. The question therefore owns the slot next.
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBeInstanceOf(QuestionDialogComponent);
    });
    // The dialog's cancel bookkeeping ran on preemption.
    expect(driver.state.activeDialog).toBeNull();

    (slotChild(driver) as QuestionDialogComponent).handleInput(ESC);
    await questionResponse;
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBe(driver.state.editor);
    });
    expect(driver.state.activeDialog).toBeNull();
    expect(driver.state.editor.focused).toBe(true);
  });
});

describe('modal surfaces — takeovers × slot panels', () => {
  it('a takeover over a floating dialog restores focus to the dialog, not the editor', async () => {
    const { driver } = await makeDriver();
    driver.showHelpPanel();
    const help = floatingDialog(driver) as HelpPanelComponent;

    driver.teamsBrowserController.show();
    const browser = driver.state.teamsBrowser;
    expect(browser).toBeDefined();
    expect(driver.state.ui.children).toEqual([browser!.component]);
    // The floating dialog hides while the takeover owns the screen.
    expect(driver.state.ui.hasOverlay()).toBe(false);
    expect(help.focused).toBe(false);
    expect((browser!.component as unknown as Focusable).focused).toBe(true);

    browser!.component.handleInput(ESC);
    expect(driver.state.teamsBrowser).toBeUndefined();
    expect(driver.state.ui.children).toEqual([driver.state.rootContainer]);
    // Focus returns to the surface beneath: the still-open dialog reappears.
    expect(driver.state.ui.hasOverlay()).toBe(true);
    expect(help.focused).toBe(true);
    expect(driver.state.editor.focused).toBe(false);

    help.handleInput(ESC);
    await vi.waitFor(() => {
      expect(driver.state.ui.hasOverlay()).toBe(false);
    });
  });

  it('restoreEditor under an active takeover keeps focus on the takeover; close lands on the new slot content', async () => {
    const { driver } = await makeDriver();
    driver.showHelpPanel();
    driver.teamsBrowserController.show();
    const browser = driver.state.teamsBrowser!;
    expect((browser.component as unknown as Focusable).focused).toBe(true);

    // The dialog resolves while hidden under the takeover (e.g. an async
    // continuation): the editor is swapped into the hidden slot tree, but the
    // keyboard must stay with the visible takeover.
    driver.hideHelpPanel();
    expect(slotChild(driver)).toBe(driver.state.editor);
    expect((browser.component as unknown as Focusable).focused).toBe(true);
    expect(driver.state.editor.focused).toBe(false);

    browser.component.handleInput(ESC);
    expect(driver.state.teamsBrowser).toBeUndefined();
    expect(driver.state.editor.focused).toBe(true);
  });

  it('refuses to mount a takeover while a blocking panel owns the slot', async () => {
    const { driver, session } = await makeDriver();
    const response = approvalHandlerOf(session)(makeApprovalRequest('call_1'));
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBeInstanceOf(ApprovalPanelComponent);
    });
    const panel = slotChild(driver) as ApprovalPanelComponent;

    driver.teamsBrowserController.show();
    driver.workflowsBrowserController.show();
    expect(driver.state.teamsBrowser).toBeUndefined();
    expect(driver.state.workflowsBrowser).toBeUndefined();
    // The approval stays visible and focused — never covered.
    expect(driver.state.ui.children).toEqual([driver.state.rootContainer]);
    expect(panel.focused).toBe(true);

    panel.handleInput('1');
    await expect(response).resolves.toMatchObject({ decision: 'approved' });
  });

  it('a tasks-browser open racing an approval landing mid-fetch loses to the approval', async () => {
    const { driver, session } = await makeDriver();
    const gate = deferred<never[]>();
    session.listBackgroundTasks.mockImplementation(() => gate.promise);

    const show = driver.tasksBrowserController.show();
    const response = approvalHandlerOf(session)(makeApprovalRequest('call_1'));
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBeInstanceOf(ApprovalPanelComponent);
    });

    gate.resolve([]);
    await show;
    expect(driver.state.tasksBrowser).toBeUndefined();
    expect(driver.state.ui.children).toEqual([driver.state.rootContainer]);
    expect(slotChild(driver)).toBeInstanceOf(ApprovalPanelComponent);

    (slotChild(driver) as ApprovalPanelComponent).handleInput('1');
    await expect(response).resolves.toMatchObject({ decision: 'approved' });
  });

  it('a blocking mount closes an open takeover before mounting', async () => {
    const { driver, session } = await makeDriver();
    driver.teamsBrowserController.show();
    expect(driver.state.teamsBrowser).toBeDefined();

    const response = approvalHandlerOf(session)(makeApprovalRequest('call_1'));
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBeInstanceOf(ApprovalPanelComponent);
    });
    // The takeover was folded back first: layout restored, approval owns the
    // slot and the keyboard.
    expect(driver.state.teamsBrowser).toBeUndefined();
    expect(driver.state.ui.children).toEqual([driver.state.rootContainer]);
    expect((slotChild(driver) as ApprovalPanelComponent).focused).toBe(true);

    (slotChild(driver) as ApprovalPanelComponent).handleInput('1');
    await expect(response).resolves.toMatchObject({ decision: 'approved' });
  });
});

describe('modal surfaces — nested takeovers and Esc order', () => {
  it('Esc peels the approval preview first, then answers the approval RPC', async () => {
    const { driver, session } = await makeDriver();
    const response = approvalHandlerOf(session)(makeApprovalRequest('call_1'));
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBeInstanceOf(ApprovalPanelComponent);
    });
    const panel = driver.activeApprovalPanel!;
    driver.openApprovalPreview(panel, {
      type: 'diff',
      path: 'a.ts',
      old_text: 'const a = 1;\n',
      new_text: 'const a = 2;\n',
    });

    const viewer = driver.state.ui.children[0]!;
    expect(viewer).toBeInstanceOf(ApprovalPreviewViewer);
    expect(driver.state.ui.children).toHaveLength(1);
    expect(panel.focused).toBe(false);

    // Innermost surface first: Esc closes the preview back onto the panel.
    viewer.handleInput?.(ESC);
    expect(driver.state.ui.children).toEqual([driver.state.rootContainer]);
    expect(panel.focused).toBe(true);

    // Next Esc reaches the blocking panel and answers its RPC.
    panel.handleInput(ESC);
    await expect(response).resolves.toMatchObject({ decision: 'rejected' });
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBe(driver.state.editor);
    });
  });
});

describe('modal surfaces — mouse routing while stacked', () => {
  function pressMouse(
    driver: MatrixDriver,
    event: { button: number; col: number; row: number },
  ): void {
    (
      driver.state.ui as unknown as {
        handleFullscreenMouse(event: MouseEvent): void;
      }
    ).handleFullscreenMouse({ type: 'press', slotRelative: false, ...event });
  }

  it('a press reaches only the takeover, never the hidden slot content', async () => {
    const { driver } = await makeDriver();
    driver.showHelpPanel();
    const help = slotChild(driver) as HelpPanelComponent;
    driver.teamsBrowserController.show();
    const browser = driver.state.teamsBrowser!;

    const helpMouse = vi.spyOn(help, 'handleMouse');
    const editorMouse = vi.spyOn(driver.state.editor, 'handleMouse');
    const browserMouse = vi.spyOn(browser.component, 'handleMouse');
    const browserZones = vi.spyOn(browser.component, 'onHitZone');

    pressMouse(driver, { button: 0, col: 5, row: 2 });
    // The focused takeover got the event (via zone dispatch or raw handling);
    // nothing leaked into the hidden snapshot tree.
    expect(browserMouse.mock.calls.length + browserZones.mock.calls.length).toBeGreaterThan(0);
    expect(helpMouse).not.toHaveBeenCalled();
    expect(editorMouse).not.toHaveBeenCalled();

    browser.component.handleInput(ESC);
    help.handleInput(ESC);
  });

  it('presses route through the floating dialog rect; outside presses are dropped', async () => {
    const { driver } = await makeDriver();
    driver.showHelpPanel();
    const help = floatingDialog(driver) as HelpPanelComponent;
    const helpMouse = vi.spyOn(help, 'handleMouse');
    const helpZones = vi.spyOn(help, 'onHitZone');

    // Simulate a composed frame: 10 transcript viewport rows above the slot,
    // and the dialog's overlay rect bottom-anchored over the lower rows
    // (renders are mocked in this driver, so the rect is faked like the slot
    // geometry below).
    const ui = driver.state.ui as unknown as {
      lastViewportHeight: number;
      lastSlotClipRows: number;
      overlayStack: {
        component: unknown;
        lastRect: { row: number; col: number; width: number; height: number } | null;
      }[];
    };
    ui.lastViewportHeight = 10;
    ui.lastSlotClipRows = 0;
    ui.overlayStack[0]!.lastRect = { row: 11, col: 0, width: 80, height: 5 };

    // Row 3 is transcript viewport, outside the overlay rect: dropped (no
    // click-through into covered content).
    pressMouse(driver, { button: 0, col: 5, row: 3 });
    expect(helpMouse).not.toHaveBeenCalled();
    expect(helpZones).not.toHaveBeenCalled();

    // Row 14 lands inside the overlay rect: the dialog receives the press
    // (zone dispatch or raw handling), translated into its own frame.
    pressMouse(driver, { button: 0, col: 5, row: 14 });
    expect(helpMouse.mock.calls.length + helpZones.mock.calls.length).toBeGreaterThan(0);

    help.handleInput(ESC);
  });
});

// ---------------------------------------------------------------------------
// pi-tui overlay stack × children-snapshot takeover (self-contained level:
// the app composes the two through the dialogs' visible predicate; the
// invariant itself is pinned at the pi-tui layer where both mechanisms live).
// ---------------------------------------------------------------------------

function fakeTerminal(columns = 80, rows = 24): Terminal & { sendInput(data: string): void } {
  let onInput: ((data: string) => void) | undefined;
  return {
    start: (input) => {
      onInput = input;
    },
    stop: () => {
      onInput = undefined;
    },
    drainInput: () => Promise.resolve(),
    write: () => {},
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
    enterAltScreen: () => {},
    exitAltScreen: () => {},
    setMouseReporting: () => {},
    sendInput: (data) => {
      onInput?.(data);
    },
  };
}

class FakeSurface extends Container implements Focusable {
  focused = false;
  readonly inputs: string[] = [];
  readonly mouse: MouseEvent[] = [];
  constructor(private readonly label: string) {
    super();
  }
  handleInput(data: string): void {
    this.inputs.push(data);
  }
  handleMouse(event: MouseEvent): void {
    this.mouse.push(event);
  }
  override render(): string[] {
    return [this.label];
  }
}

async function flushRender(): Promise<void> {
  await new Promise((resolve) => process.nextTick(resolve));
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe('modal surfaces — pi-tui overlay × takeover', () => {
  it('press reaches the takeover only, then the overlay only; hide restores takeover focus and Esc order', async () => {
    const terminal = fakeTerminal();
    const ui = new TUI(terminal);
    const scroll = new Container();
    const slot = new Container();
    const editor = new FakeSurface('editor');
    slot.addChild(editor);
    ui.addChild(scroll);
    ui.addChild(slot);
    ui.setFullscreen(true);
    ui.setLayoutRegions({ scroll, slot });
    ui.setFocus(editor);
    ui.start();
    try {
      await flushRender();

      // Children-snapshot takeover: the layout is swapped out whole.
      const savedChildren = [...ui.children];
      const takeover = new FakeSurface('takeover');
      ui.clear();
      ui.addChild(takeover);
      ui.setFocus(takeover);
      await flushRender();

      terminal.sendInput('\x1b[<0;5;2M');
      expect(takeover.mouse).toHaveLength(1);
      expect(editor.mouse).toHaveLength(0);

      // Overlay stacked on the takeover: captures focus and input.
      const overlay = new FakeSurface('overlay');
      const handle = ui.showOverlay(overlay);
      await flushRender();
      expect(overlay.focused).toBe(true);
      expect(takeover.focused).toBe(false);

      // Presses reach the overlay only inside its composed rect (centered, one
      // line on a 24-row terminal → event row 12); a press outside the rect is
      // dropped — nothing clicks through to the takeover underneath.
      terminal.sendInput('\x1b[<0;5;2M');
      expect(overlay.mouse).toHaveLength(0);
      expect(takeover.mouse).toHaveLength(1);
      terminal.sendInput('\x1b[<0;5;12M');
      expect(overlay.mouse).toHaveLength(1);
      expect(takeover.mouse).toHaveLength(1);

      terminal.sendInput(ESC);
      expect(overlay.inputs).toEqual([ESC]);
      expect(takeover.inputs).toEqual([]);

      // Dismiss: focus falls back to the surface beneath (preFocus), which
      // then receives the next Esc.
      handle.hide();
      expect(takeover.focused).toBe(true);
      terminal.sendInput(ESC);
      expect(takeover.inputs).toEqual([ESC]);

      // Fold the takeover back: the editor resumes.
      ui.clear();
      for (const child of savedChildren) ui.addChild(child);
      ui.setFocus(editor);
      expect(editor.focused).toBe(true);
    } finally {
      ui.stop();
    }
  });
});

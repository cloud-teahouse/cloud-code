// Editor slot ownership arbitration — the interleavings that used to hang the
// agent: an async dialog's restoreEditor() wiping an approval panel mounted
// meanwhile, leaving the approval RPC with no visible UI.
//
// Semantics under test (see src/tui/editor-slot.ts):
// - blocking panels (approval/question) preempt user dialogs via onPreempt
// - a mount arriving while a blocking panel owns the slot is queued
// - restoreEditor(staleHandle) is a no-op; restoreEditor(queuedHandle) drops
//   the queue entry without ever mounting the panel

import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ApprovalRequest, ApprovalResponse } from '@cloud-code/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import { HelpPanelComponent } from '#/tui/components/dialogs/help-panel';
import { QuestionDialogComponent } from '#/tui/components/dialogs/question-dialog';
import { CloudCodeTUI, type CloudCodeTUIStartupInput, type TUIState } from '#/tui/cloud-code-tui';

interface SlotDriver {
  state: TUIState;
  init(): Promise<boolean>;
  showHelpPanel(): void;
  mountEditorReplacement(
    panel: unknown,
    options?: { kind?: 'dialog' | 'blocking' },
  ): { id: number };
  restoreEditor(handle?: { id: number }): void;
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
      fullscreen: false,
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
      entries: ['manifest.json', 'state.json'],
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
  driver: SlotDriver;
  session: ReturnType<typeof makeSession>;
}> {
  process.env['CLOUD_CODE_HOME'] = await mkdtemp(join(tmpdir(), 'cloud-code-slot-')).then((dir) => {
    tempDirs.push(dir);
    return dir;
  });
  const driver = new CloudCodeTUI(
    makeHarness(session) as never,
    makeStartupInput(),
  ) as unknown as SlotDriver;
  vi.spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
  vi.spyOn(driver.state.terminal, 'setProgress').mockImplementation(() => {});
  await driver.init();
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

function slotChild(driver: SlotDriver): unknown {
  return driver.state.editorContainer.children[0];
}

describe('editor slot ownership', () => {
  it('preempts a user dialog when a blocking approval arrives, and restores the editor after answering', async () => {
    const { driver, session } = await makeDriver();
    driver.showHelpPanel();
    expect(slotChild(driver)).toBeInstanceOf(HelpPanelComponent);
    expect(driver.state.activeDialog).toBe('help');

    const response = approvalHandlerOf(session)(makeApprovalRequest('call_1'));
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBeInstanceOf(ApprovalPanelComponent);
    });
    // The dialog's cancel semantics ran on preemption.
    expect(driver.state.activeDialog).toBeNull();

    (slotChild(driver) as ApprovalPanelComponent).handleInput('1');
    await expect(response).resolves.toMatchObject({ decision: 'approved' });
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBe(driver.state.editor);
    });
  });

  it('ignores a stale restore from an async dialog completing after preemption', async () => {
    const { driver, session } = await makeDriver();
    driver.showHelpPanel();
    expect(slotChild(driver)).toBeInstanceOf(HelpPanelComponent);

    const response = approvalHandlerOf(session)(makeApprovalRequest('call_1'));
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBeInstanceOf(ApprovalPanelComponent);
    });

    // The preempted dialog's async continuation fires its close again: no
    // handle is registered anymore, so this must not clobber the approval.
    driver.restoreEditor({ id: 999_999 });
    expect(slotChild(driver)).toBeInstanceOf(ApprovalPanelComponent);

    (slotChild(driver) as ApprovalPanelComponent).handleInput('1');
    await expect(response).resolves.toMatchObject({ decision: 'approved' });
  });

  it('queues a question behind a mounted approval and mounts it after answering', async () => {
    const { driver, session } = await makeDriver();

    const approvalResponse = approvalHandlerOf(session)(makeApprovalRequest('call_1'));
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBeInstanceOf(ApprovalPanelComponent);
    });

    const questionResponse = questionHandlerOf(session)({
      toolCallId: 'q1',
      questions: [
        {
          question: 'Pick one',
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    });
    // The question dialog must not clobber the mounted approval: it queues.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slotChild(driver)).toBeInstanceOf(ApprovalPanelComponent);

    (slotChild(driver) as ApprovalPanelComponent).handleInput('1');
    await expect(approvalResponse).resolves.toMatchObject({ decision: 'approved' });
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBeInstanceOf(QuestionDialogComponent);
    });

    // Escape answers with an empty answer set and resolves the RPC.
    (slotChild(driver) as QuestionDialogComponent).handleInput('\u001B');
    await questionResponse;
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBe(driver.state.editor);
    });
  });

  it('cancels a queued blocking mount via its handle without ever mounting it', async () => {
    const { driver, session } = await makeDriver();

    const first = approvalHandlerOf(session)(makeApprovalRequest('call_1'));
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBeInstanceOf(ApprovalPanelComponent);
    });

    // A second blocking panel queues behind the approval…
    const queuedHandle = driver.mountEditorReplacement(
      new HelpPanelComponent({ commands: [], onClose: () => {} }),
      { kind: 'blocking' },
    );
    expect(slotChild(driver)).toBeInstanceOf(ApprovalPanelComponent);

    // …and its request resolves before the panel ever mounted (guardian
    // auto-approve path): the queue entry is dropped, no mount happens.
    driver.restoreEditor(queuedHandle);

    (slotChild(driver) as ApprovalPanelComponent).handleInput('1');
    await expect(first).resolves.toMatchObject({ decision: 'approved' });
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBe(driver.state.editor);
    });
  });

  it('queues a dialog behind a blocking approval and mounts it after answering', async () => {
    const { driver, session } = await makeDriver();

    const response = approvalHandlerOf(session)(makeApprovalRequest('call_1'));
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBeInstanceOf(ApprovalPanelComponent);
    });

    // User dialog requested while the approval owns the slot: queued, and the
    // approval keeps the keyboard.
    driver.showHelpPanel();
    expect(slotChild(driver)).toBeInstanceOf(ApprovalPanelComponent);

    (slotChild(driver) as ApprovalPanelComponent).handleInput('1');
    await expect(response).resolves.toMatchObject({ decision: 'approved' });
    await vi.waitFor(() => {
      expect(slotChild(driver)).toBeInstanceOf(HelpPanelComponent);
    });
  });
});

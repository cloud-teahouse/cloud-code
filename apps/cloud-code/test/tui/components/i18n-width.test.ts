import type { BackgroundTaskInfo, ModelAlias } from '@cloud-code/sdk';
import { visibleWidth, type Terminal } from '@cloud-code/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import { GoalStartPermissionPromptComponent } from '#/tui/components/dialogs/goal-start-permission-prompt';
import { HelpPanelComponent } from '#/tui/components/dialogs/help-panel';
import { ModelSelectorComponent } from '#/tui/components/dialogs/model-selector';
import { PluginsPanelComponent } from '#/tui/components/dialogs/plugins-selector';
import { QuestionDialogComponent } from '#/tui/components/dialogs/question-dialog';
import { SessionPickerComponent } from '#/tui/components/dialogs/session-picker';
import { TasksBrowserApp, type TasksBrowserProps } from '#/tui/components/dialogs/tasks-browser';
import { resolveDescription, setLocalePreference, t } from '#/tui/i18n';
import { adaptApprovalRequest } from '#/tui/reverse-rpc/approval/adapter';
import type { PendingApproval, PendingQuestion } from '#/tui/reverse-rpc/types';
import type { AppState } from '#/tui/types';

const WIDTHS = [24, 40, 80];

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
  availableModels: {},
  availableProviders: {},
  mcpServersSummary: null,
};

function makeZhApproval(): PendingApproval {
  const data = adaptApprovalRequest({
    toolCallId: 'tool_1',
    toolName: 'Bash',
    action: 'run',
    display: {
      kind: 'generic',
      detail: { command: 'rm -rf /tmp/scratch', description: 'remove scratch dir' },
    },
  } as never);
  return { data };
}

afterEach(() => {
  setLocalePreference('en');
});

describe('zh-CN rendering widths', () => {
  it('welcome keeps every line within width (incl. 24-col narrow)', () => {
    setLocalePreference('zh-CN');
    for (const width of WIDTHS) {
      for (const line of new WelcomeComponent(appState).render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('welcome renders Chinese copy and keeps the box border column aligned', () => {
    setLocalePreference('zh-CN');
    const lines = new WelcomeComponent(appState).render(80);
    expect(lines.join('\n')).toContain('欢迎使用 Cloud Code CLI！');
    expect(lines.join('\n')).toContain('目录:');
    // Every box row (border or padded content row) spans exactly 80 columns.
    for (const line of lines) {
      if (line.includes('│') || line.includes('╭') || line.includes('╰')) {
        expect(visibleWidth(line)).toBe(80);
      }
    }
  });

  it('footer keeps both lines within width (incl. 24-col narrow)', () => {
    setLocalePreference('zh-CN');
    const footer = new FooterComponent({ ...appState, thinkingEffort: 'high' });
    footer.setBackgroundCounts({ bashTasks: 2, agentTasks: 1 });
    try {
      for (const width of WIDTHS) {
        for (const line of footer.render(width)) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      }
      expect(footer.render(80).join('\n')).toContain('思考');
    } finally {
      footer.dispose();
    }
  });

  it('help panel keeps every line within width (incl. 24-col narrow)', () => {
    setLocalePreference('zh-CN');
    const panel = new HelpPanelComponent({
      commands: [
        { name: 'help', aliases: ['h', '?'], description: resolveDescription('commands.help.description') },
        { name: 'language', aliases: ['lang'], description: resolveDescription('commands.language.description') },
      ],
      onClose: () => {},
    });
    for (const width of WIDTHS) {
      for (const line of panel.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    const out = panel.render(80).join('\n');
    expect(out).toContain('键盘快捷键');
    expect(out).toContain('斜杠命令');
  });

  it('approval panel keeps every line within width (incl. 24-col narrow)', () => {
    setLocalePreference('zh-CN');
    const panel = new ApprovalPanelComponent(makeZhApproval(), vi.fn());
    for (const width of WIDTHS) {
      for (const line of panel.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    const out = panel.render(80).join('\n');
    expect(out).toContain('运行此命令？');
    expect(out).toContain('批准一次');
    expect(out).toContain('拒绝并反馈意见');
  });

  it('selector hints render in zh-CN', () => {
    setLocalePreference('zh-CN');
    expect(t('common.hint.navigate')).toBe('↑↓ 移动');
    expect(resolveDescription('dialogs.undo.title')).toBe('选择要撤回的消息');
  });
});

/** Minimal Terminal stub for the tasks browser — only `rows`/`columns` are read. */
function fakeTerminal(rows: number, columns: number): Terminal {
  return {
    start: () => {},
    stop: () => {},
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
  };
}

const modelFixture = {
  provider: 'managed:kimi-code',
  model: 'kimi-k2',
  maxContextSize: 200_000,
  displayName: 'Kimi K2',
  capabilities: ['thinking'],
} as unknown as ModelAlias;

const pluginFixture = {
  id: 'superpowers',
  displayName: 'Superpowers',
  version: '5.1.0',
  enabled: true,
  state: 'ok' as const,
  skillCount: 14,
  mcpServerCount: 0,
  enabledMcpServerCount: 0,
  hookCount: 0,
  commandCount: 0,
  hasErrors: false,
  source: 'local-path' as const,
};

function makeTasksBrowserProps(): TasksBrowserProps {
  return {
    tasks: [
      {
        taskId: 'bash-abcd1234',
        kind: 'process',
        command: 'npm run dev',
        description: 'dev server',
        status: 'running',
        pid: 1234,
        exitCode: null,
        startedAt: Date.now() - 60_000,
        endedAt: null,
      } as BackgroundTaskInfo,
    ],
    filter: 'all',
    selectedTaskId: undefined,
    tailOutput: undefined,
    tailLoading: false,
    flashMessage: undefined,
    onSelect: () => {},
    onToggleFilter: () => {},
    onRefresh: () => {},
    onCancel: () => {},
    onStopConfirmed: () => {},
    onOpenOutput: () => {},
    onStopIgnored: () => {},
  } as TasksBrowserProps;
}

describe('zh-CN rendering widths — batch 2 dialogs', () => {
  it('model selector keeps every line within width (incl. 24-col narrow)', () => {
    setLocalePreference('zh-CN');
    const picker = new ModelSelectorComponent({
      models: { kimi: modelFixture },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      onSelect: () => {},
      onCancel: () => {},
    });
    for (const width of WIDTHS) {
      for (const line of picker.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    expect(picker.render(80).join('\n')).toContain('选择模型');
  });

  it('question dialog keeps every line within width (incl. 24-col narrow)', () => {
    setLocalePreference('zh-CN');
    const pending: PendingQuestion = {
      data: {
        id: 'q_1',
        tool_call_id: 'tc_1',
        questions: [
          {
            question: 'Which option?',
            multi_select: false,
            options: [{ label: 'Alpha' }, { label: 'Beta' }],
          },
        ],
      },
    };
    const dialog = new QuestionDialogComponent(pending, () => {}, 6);
    for (const width of WIDTHS) {
      for (const line of dialog.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('session picker keeps every line within width (incl. 24-col narrow)', () => {
    setLocalePreference('zh-CN');
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const picker = new SessionPickerComponent({
        sessions: [
          { id: 'ses_a', title: 'alpha', work_dir: '/tmp/project', updated_at: now - 2 * 60 * 1000 },
          {
            id: 'ses_b',
            title: 'beta',
            work_dir: '/tmp/project',
            updated_at: now - 3 * 60 * 60 * 1000,
          },
        ],
        loading: false,
        currentSessionId: '',
        onSelect: () => {},
        onCancel: () => {},
      });
      for (const width of WIDTHS) {
        for (const line of picker.render(width)) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      }
      expect(picker.render(80).join('\n')).toContain('2m 前');
    } finally {
      spy.mockRestore();
    }
  });

  it('tasks browser keeps every line within width (incl. 24-col narrow)', () => {
    setLocalePreference('zh-CN');
    const props = makeTasksBrowserProps();
    for (const width of WIDTHS) {
      const app = new TasksBrowserApp(props, fakeTerminal(30, width));
      for (const line of app.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    const out = new TasksBrowserApp(props, fakeTerminal(30, 80)).render(80).join('\n');
    expect(out).toContain('任务浏览器');
  });

  it('goal-start permission prompt keeps every line within width (incl. 24-col narrow)', () => {
    setLocalePreference('zh-CN');
    const prompt = new GoalStartPermissionPromptComponent({
      mode: 'manual',
      onSelect: () => {},
      onCancel: () => {},
    });
    for (const width of WIDTHS) {
      for (const line of prompt.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    expect(prompt.render(80).join('\n')).toContain('在开启审批的情况下启动目标？');
  });

  it('plugins panel keeps every line within width (incl. 24-col narrow)', () => {
    setLocalePreference('zh-CN');
    const panel = new PluginsPanelComponent({
      installed: [pluginFixture],
      installedIds: new Set(['superpowers']),
      onSelect: () => {},
      onCancel: () => {},
      onRequestMarketplace: () => {},
    });
    for (const width of WIDTHS) {
      for (const line of panel.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    expect(panel.render(80).join('\n')).toContain('已安装');
  });
});

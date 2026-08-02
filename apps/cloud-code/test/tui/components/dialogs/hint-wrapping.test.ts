/**
 * Narrow-width hint-wrapping sweep: every dialog/panel key-hint line must
 * wrap at segment boundaries instead of truncating mid-token, in en and
 * zh-CN. Render at narrow widths and assert (a) no line exceeds the width
 * and (b) the tail segments (manage keys, cancel) survive on some line.
 */

import { visibleWidth, type Terminal } from '@cloud-code/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '@cloud-code/sdk';

import {
  PluginMcpSelectorComponent,
  PluginsPanelComponent,
  type PluginMcpSelectorOptions,
  type PluginsPanelSelection,
} from '#/tui/components/dialogs/plugins-selector';
import { ProviderManagerComponent } from '#/tui/components/dialogs/provider-manager';
import { GoalQueueManagerComponent } from '#/tui/components/dialogs/goal-queue-manager';
import { MultiChoicePickerComponent } from '#/tui/components/dialogs/multi-choice-picker';
import { StartPermissionPromptComponent } from '#/tui/components/dialogs/start-permission-prompt';
import { HelpPanelComponent } from '#/tui/components/dialogs/help-panel';
import { ApiKeyInputDialogComponent } from '#/tui/components/dialogs/api-key-input-dialog';
import { CustomRegistryImportDialogComponent } from '#/tui/components/dialogs/custom-registry-import';
import { TasksBrowserApp } from '#/tui/components/dialogs/tasks-browser';
import { TeamsBrowserApp } from '#/tui/components/dialogs/teams-browser';
import { WorkflowsBrowserApp } from '#/tui/components/dialogs/workflows-browser';
import { QueuePaneComponent } from '#/tui/components/panes/queue-pane';
import { setLocalePreference } from '#/tui/i18n';
import type { UpcomingGoal } from '#/tui/goal-queue-store';

const SGR = /\u001B\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(SGR, '');

afterEach(() => {
  setLocalePreference('en');
});

function renderStripped(component: { render(width: number): string[] }, width: number): string[] {
  return component.render(width).map(strip);
}

/** Every rendered line fits the width, and every expected segment appears on some line. */
function expectWrappedHint(
  component: { render(width: number): string[] },
  width: number,
  segments: readonly string[],
): void {
  const lines = renderStripped(component, width);
  for (const line of lines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
  const text = lines.join('\n');
  for (const segment of segments) {
    expect(text).toContain(segment);
  }
}

const pluginSummary = {
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

function makePanel(installed: readonly (typeof pluginSummary)[] = [pluginSummary]) {
  return new PluginsPanelComponent({
    installed,
    installedIds: new Set(installed.map((p) => p.id)),
    onSelect: vi.fn<(s: PluginsPanelSelection) => void>(),
    onCancel: vi.fn(),
    onRequestMarketplace: vi.fn(),
  });
}

describe('plugins panel hint', () => {
  it('wraps the installed-tab hint at narrow widths (en)', () => {
    for (const width of [60, 48, 40]) {
      expectWrappedHint(makePanel(), width, [
        'Tab switch',
        'Space toggle',
        'Alt+D remove',
        'Alt+M MCP',
        'Enter details',
        'Alt+R reload',
        'Esc cancel',
      ]);
    }
  });

  it('wraps the installed-tab hint at narrow widths (zh-CN)', () => {
    setLocalePreference('zh-CN');
    for (const width of [60, 48, 40]) {
      expectWrappedHint(makePanel(), width, [
        'Tab 切换',
        'Space 切换',
        'Alt+D 移除',
        'Alt+M MCP',
        'Enter 详情',
        'Alt+R 重载',
        'Esc 取消',
      ]);
    }
  });

  it('drops the duplicated Alt+I details segment while Enter means details', () => {
    const text = renderStripped(makePanel(), 120).join('\n');
    expect(text).toContain('Enter details');
    expect(text).not.toContain('Alt+I');
  });

  it('shows Alt+I details only while Enter installs an update', () => {
    const panel = makePanel();
    // A newer marketplace version of the installed plugin turns Enter into
    // "update"; Alt+I is then the only details path and must be advertised.
    panel.setMarketplace(
      [
        {
          id: 'superpowers',
          displayName: 'Superpowers',
          version: '6.0.0',
          source: 'https://x/s.zip',
          tier: 'official',
        },
      ],
      'test-catalog',
    );
    const text = renderStripped(panel, 120).join('\n');
    expect(text).toContain('Enter update');
    expect(text).toContain('Alt+I details');
  });

  it('zh-CN: Alt+I 详情 appears only with a pending update', () => {
    setLocalePreference('zh-CN');
    const panel = makePanel();
    expect(renderStripped(panel, 120).join('\n')).not.toContain('Alt+I');
    panel.setMarketplace(
      [
        {
          id: 'superpowers',
          displayName: 'Superpowers',
          version: '6.0.0',
          source: 'https://x/s.zip',
          tier: 'official',
        },
      ],
      'test-catalog',
    );
    const text = renderStripped(panel, 120).join('\n');
    expect(text).toContain('Enter 更新');
    expect(text).toContain('Alt+I 详情');
  });
});

const mcpInfo: PluginMcpSelectorOptions['info'] = {
  id: 'kimi-datasource',
  displayName: 'Kimi Datasource',
  version: '1.0.0',
  enabled: true,
  state: 'ok',
  skillCount: 1,
  mcpServerCount: 1,
  enabledMcpServerCount: 1,
  hookCount: 0,
  commandCount: 0,
  hasErrors: false,
  source: 'local-path',
  installedAt: '2026-05-29T00:00:00.000Z',
  root: '/plugins/kimi-datasource',
  manifest: undefined,
  mcpServers: [
    {
      name: 'data',
      runtimeName: 'plugin-kimi-datasource-data',
      enabled: true,
      transport: 'stdio',
      command: 'node',
      args: ['./bin/kimi-datasource.mjs'],
      cwd: '/plugins/kimi-datasource',
    },
  ],
  diagnostics: [],
};

describe('plugin MCP selector hint', () => {
  it('wraps at narrow widths (en + zh-CN)', () => {
    const make = () =>
      new PluginMcpSelectorComponent({ info: mcpInfo, onSelect: vi.fn(), onCancel: vi.fn() });
    for (const width of [48, 40]) {
      expectWrappedHint(make(), width, ['↑↓ navigate', 'Enter/Space enable/disable', 'Esc cancel']);
    }
    setLocalePreference('zh-CN');
    for (const width of [48, 40]) {
      expectWrappedHint(make(), width, ['↑↓ 导航', 'Enter/Space 启用/禁用', 'Esc 取消']);
    }
  });
});

describe('provider manager hint', () => {
  it('wraps at narrow widths (en + zh-CN)', () => {
    const make = () =>
      new ProviderManagerComponent({
        providers: { acme: { baseUrl: 'https://acme.test' } } as unknown as Record<
          string,
          ProviderConfig
        >,
        onAdd: vi.fn(),
        onEditProvider: vi.fn(),
        onDeleteSource: vi.fn(),
        onClose: vi.fn(),
      });
    for (const width of [48, 40]) {
      expectWrappedHint(make(), width, ['↑↓ navigate', 'Alt+E edit', 'Alt+D delete', 'Esc cancel']);
    }
    setLocalePreference('zh-CN');
    for (const width of [48, 40]) {
      expectWrappedHint(make(), width, ['↑↓ 移动', 'Alt+E 编辑', 'Alt+D 删除', 'Esc 取消']);
    }
  });
});

function goal(id: string): UpcomingGoal {
  return {
    id,
    objective: `Ship ${id}`,
    createdAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:00:00.000Z',
  };
}

describe('goal queue manager hint', () => {
  it('wraps at narrow widths (en + zh-CN)', () => {
    const make = () =>
      new GoalQueueManagerComponent({ goals: [goal('g1')], onAction: vi.fn(), onCancel: vi.fn() });
    for (const width of [48, 40]) {
      expectWrappedHint(make(), width, ['Space select', 'Alt+E edit', 'Alt+D delete', 'Esc cancel']);
    }
    setLocalePreference('zh-CN');
    for (const width of [48, 40]) {
      expectWrappedHint(make(), width, ['Space 选择', 'Alt+E 编辑', 'Alt+D 删除', 'Esc 取消']);
    }
  });
});

describe('multi choice picker hint', () => {
  it('wraps the default hint at narrow widths (zh-CN)', () => {
    setLocalePreference('zh-CN');
    const make = () =>
      new MultiChoicePickerComponent({
        title: 'Efforts',
        options: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' },
        ],
        onSubmit: vi.fn(),
        onCancel: vi.fn(),
      });
    for (const width of [48, 40]) {
      expectWrappedHint(make(), width, ['↑↓ 移动', '空格 切换', 'Enter 确认', 'Esc 取消']);
    }
  });
});

describe('start permission prompt hint', () => {
  it('wraps at narrow widths (en + zh-CN)', () => {
    const make = () =>
      new StartPermissionPromptComponent({
        title: 'Enable approvals',
        noticeLines: ['Manual mode asks before running tools.'],
        options: [
          { value: 'manual', label: 'Manual', description: 'Ask every time' },
          { value: 'cancel', label: 'Cancel', description: 'Go back' },
        ],
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      });
    for (const width of [40, 32]) {
      expectWrappedHint(make(), width, ['↑↓ navigate', 'Enter select', 'Esc cancel']);
    }
    setLocalePreference('zh-CN');
    for (const width of [40, 32]) {
      expectWrappedHint(make(), width, ['↑↓ 移动', 'Enter 选择', 'Esc 取消']);
    }
  });
});

describe('help panel title hint', () => {
  const commands = [
    { name: 'help', aliases: [], description: 'Show help' },
    { name: 'model', aliases: [], description: 'Pick a model' },
  ];

  it('keeps the inline hint when it fits and wraps it when narrow', () => {
    const make = () => new HelpPanelComponent({ commands, onClose: vi.fn() });
    const wide = renderStripped(make(), 100);
    expect(wide[1]).toContain('Esc / Enter / q to cancel');
    expect(wide[1]).toContain('↑↓ scroll');
    for (const width of [40, 30]) {
      expectWrappedHint(make(), width, ['Esc / Enter / q to cancel', '↑↓ scroll']);
    }
  });

  it('wraps the hint at narrow widths (zh-CN)', () => {
    setLocalePreference('zh-CN');
    const make = () => new HelpPanelComponent({ commands, onClose: vi.fn() });
    for (const width of [40, 30]) {
      expectWrappedHint(make(), width, ['Esc / Enter / q 关闭', '↑↓ 滚动']);
    }
  });
});

describe('boxed input dialog footers', () => {
  it('api key dialog wraps the footer at narrow widths (zh-CN)', () => {
    setLocalePreference('zh-CN');
    const make = () => new ApiKeyInputDialogComponent('Title', ['Subtitle'], () => {});
    for (const width of [40, 30]) {
      expectWrappedHint(make(), width, ['Enter 提交', 'Esc 取消']);
    }
  });

  it('registry import wraps the footer at narrow widths (en)', () => {
    const make = () => new CustomRegistryImportDialogComponent(vi.fn(), 'https://example.com/api.json');
    for (const width of [60, 48, 40]) {
      expectWrappedHint(make(), width, ['Tab / ↑↓ to switch', 'Enter for next field', 'Esc to cancel']);
    }
  });
});

describe('queue pane hint', () => {
  it('wraps the steer hint at narrow widths (en + zh-CN)', () => {
    const make = () =>
      new QueuePaneComponent({
        messages: [
          { text: 'please also fix the tests', mode: 'prompt' } as never,
        ],
        isCompacting: false,
        isStreaming: true,
        canSteerImmediately: true,
      });
    // 'ctrl-s to steer immediately' (27 cols) is the longest segment here;
    // below ~30 it is the single-segment case that truncates by design.
    for (const width of [40, 30]) {
      expectWrappedHint(make(), width, ['↑ to edit', 'ctrl-s to steer immediately']);
    }
    setLocalePreference('zh-CN');
    for (const width of [40, 30]) {
      expectWrappedHint(make(), width, ['↑ 编辑', 'ctrl-s 立即插队发送']);
    }
  });
});

const stubTerminal = (rows = 24): Terminal => ({ rows }) as unknown as Terminal;

function makeTasksBrowser(widthTerminal = stubTerminal()) {
  return new TasksBrowserApp(
    {
      tasks: [],
      filter: 'all',
      selectedTaskId: undefined,
      tailOutput: undefined,
      tailLoading: false,
      flashMessage: undefined,
      onSelect: vi.fn(),
      onToggleFilter: vi.fn(),
      onRefresh: vi.fn(),
      onCancel: vi.fn(),
      onStopConfirmed: vi.fn(),
      onOpenOutput: vi.fn(),
    },
    widthTerminal,
  );
}

describe('browser footers', () => {
  it('tasks browser wraps the footer keys at narrow widths (en + zh-CN)', () => {
    for (const width of [60, 48]) {
      expectWrappedHint(makeTasksBrowser(), width, ['↑↓ select', 'Enter/O output', 'S stop', 'R refresh', 'Tab filter', 'Q/Esc cancel']);
    }
    setLocalePreference('zh-CN');
    for (const width of [60, 48]) {
      expectWrappedHint(makeTasksBrowser(), width, ['↑↓ 选择', 'Enter/O 输出', 'S 停止', 'R 刷新', 'Tab 筛选', 'Q/Esc 取消']);
    }
  });

  it('tasks browser keeps the total row count when the footer wraps', () => {
    const browser = makeTasksBrowser(stubTerminal(24));
    expect(browser.render(48)).toHaveLength(24);
  });

  it('teams browser keeps its footer keys on one fitted line (zh-CN)', () => {
    // MIN_WIDTH is 48 and the joined footer is ~40 cols, so the teams footer
    // wraps never trigger above the too-small floor — assert the no-regression
    // shape instead: one line, every key present.
    setLocalePreference('zh-CN');
    const make = () =>
      new TeamsBrowserApp(
        {
          teams: [],
          selectedTeamName: undefined,
          mailboxByTeam: {},
          onSelectTeam: vi.fn(),
          onCancel: vi.fn(),
        } as never,
        stubTerminal(),
      );
    expectWrappedHint(make(), 48, ['↑↓ 选择', 'PgUp/PgDn 翻页', 'Q/Esc 关闭']);
  });

  it('workflows browser wraps the footer keys at narrow widths (en)', () => {
    const make = () =>
      new WorkflowsBrowserApp(
        {
          agents: [],
          selectedAgentId: undefined,
          previewOutput: undefined,
          previewLoading: false,
          onSelectAgent: vi.fn(),
          onCancel: vi.fn(),
        } as never,
        stubTerminal(),
      );
    for (const width of [60, 48]) {
      expectWrappedHint(make(), width, ['↑↓ select', 'Enter expand', '→/Tab detail', 'PgUp/PgDn page', 'Q/Esc close']);
    }
  });
});

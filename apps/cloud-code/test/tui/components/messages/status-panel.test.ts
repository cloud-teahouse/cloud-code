import { afterEach, describe, expect, it } from 'vitest';

import {
  buildStatusTabLines,
  type StatusTabOptions,
} from '#/tui/components/messages/status-panel';
import { setLocalePreference } from '#/tui/i18n';
import { currentTheme, darkColors } from '#/tui/theme';

afterEach(() => {
  currentTheme.setPalette(darkColors);
  setLocalePreference('en');
});

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function baseOptions(overrides: Partial<StatusTabOptions> = {}): StatusTabOptions {
  return {
    version: '1.2.3',
    model: 'k2',
    workDir: '/tmp/project',
    sessionId: 'ses-1',
    sessionTitle: 'Implement status',
    availableModels: {
      k2: {
        provider: 'managed:kimi-code',
        model: 'kimi-k2',
        maxContextSize: 10000,
        displayName: 'Kimi K2',
      },
      'gpt-5': {
        provider: 'managed:chatgpt-codex',
        model: 'gpt-5',
        maxContextSize: 272000,
        displayName: 'GPT-5',
      },
    },
    permissionMode: 'manual',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    mcpServers: [],
    ...overrides,
  };
}

describe('buildStatusTabLines', () => {
  it('renders version header, session facts, model with provider, and permissions', () => {
    const lines = buildStatusTabLines(baseOptions()).map(strip);
    const output = lines.join('\n');

    expect(output).toContain('>_ Cloud Code CLI (v1.2.3)');
    expect(output).toContain('Title');
    expect(output).toContain('Implement status');
    expect(output).toContain('Session');
    expect(output).toContain('ses-1');
    expect(output).toContain('Directory');
    expect(output).toContain('/tmp/project');
    expect(output).toContain('Model');
    expect(output).toContain('Kimi K2 (Kimi Code)');
    expect(output).toContain('Permissions');
    expect(output).toContain('Manual');
  });

  it('keeps account login states off the Status tab (they live on the account tabs)', () => {
    const output = buildStatusTabLines(baseOptions()).map(strip).join('\n');
    expect(output).not.toContain('Logged in');
    expect(output).not.toContain('Not logged in');
  });

  it('omits the permissions row when the host does not report a mode', () => {
    const output = buildStatusTabLines(baseOptions({ permissionMode: undefined }))
      .map(strip)
      .join('\n');
    expect(output).not.toContain('Permissions');
  });

  it('shows the yolo permission mode label', () => {
    const output = buildStatusTabLines(baseOptions({ permissionMode: 'yolo' }))
      .map(strip)
      .join('\n');
    expect(output).toContain('Permissions');
    expect(output).toContain('YOLO');
  });

  it('shows a dimmed placeholder when the session has no title', () => {
    const output = buildStatusTabLines(baseOptions({ sessionTitle: null }))
      .map(strip)
      .join('\n');
    expect(output).toContain('/title to add a name');
  });

  it('shows not-set model and none session fallbacks', () => {
    const output = buildStatusTabLines(baseOptions({ model: '', sessionId: ' ' }))
      .map(strip)
      .join('\n');
    expect(output).toContain('not set');
    expect(output).toContain('none');
  });

  it('renders the context-window bar moved over from the Usage tab', () => {
    const lines = buildStatusTabLines(
      baseOptions({ contextUsage: 0.25, contextTokens: 2500, maxContextTokens: 10000 }),
    ).map(strip);
    const output = lines.join('\n');

    expect(output).toContain('Context window');
    expect(output).toContain('25%');
    expect(output).toContain('(2.4k / 9.8k)');
    expect(output).toContain('█');
  });

  it('omits the context-window block when the model reports no context size', () => {
    const output = buildStatusTabLines(baseOptions()).map(strip).join('\n');
    expect(output).not.toContain('Context window');
  });

  it('summarizes MCP servers by status and lists servers needing attention', () => {
    const output = buildStatusTabLines(
      baseOptions({
        mcpServers: [
          { name: 'web', transport: 'http', status: 'connected', toolCount: 3 },
          { name: 'fs', transport: 'stdio', status: 'connected', toolCount: 5 },
          { name: 'db', transport: 'stdio', status: 'failed', toolCount: 0, error: 'spawn failed' },
          { name: 'api', transport: 'http', status: 'needs-auth', toolCount: 0 },
        ],
      }),
    )
      .map(strip)
      .join('\n');
    expect(output).toContain('2 connected · 1 failed · 1 needs auth');
    expect(output).toContain('failed: db');
    expect(output).toContain('needs auth: api');
  });

  it('renders MCP empty and unavailable states', () => {
    expect(buildStatusTabLines(baseOptions({ mcpServers: [] })).map(strip).join('\n')).toContain(
      'none configured',
    );
    expect(
      buildStatusTabLines(baseOptions({ mcpServers: undefined })).map(strip).join('\n'),
    ).toContain('unavailable');
  });

  it('renders zh-CN copy', () => {
    setLocalePreference('zh-CN');
    const output = buildStatusTabLines(
      baseOptions({
        sessionTitle: null,
        contextUsage: 0.25,
        contextTokens: 2500,
        maxContextTokens: 10000,
        mcpServers: [
          { name: 'web', transport: 'http', status: 'connected', toolCount: 3 },
          { name: 'db', transport: 'stdio', status: 'failed', toolCount: 0 },
        ],
      }),
    )
      .map(strip)
      .join('\n');
    expect(output).toContain('使用 /title 添加名称');
    expect(output).toContain('权限');
    expect(output).toContain('上下文窗口');
    expect(output).toContain('1 已连接 · 1 失败');
    expect(output).toContain('失败：db');
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { SandboxStatusData } from '@cloud-code/sdk';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleSandboxCommand, showSandboxStatus } from '#/tui/commands/sandbox';
import { setLocalePreference } from '#/tui/i18n';

const STATUS: SandboxStatusData = {
  mode: 'auto',
  configured: false,
  environment: 'local',
  local: true,
  workspaceCwd: '/work',
  network: 'allow',
  escalation: 'ask',
  configuredWritableRoots: [],
  configuredDenyRead: [],
  policy: { writableRoots: ['/work', '/tmp'], denyReadPaths: [], network: 'allow' },
  guard: { readOnlySubpaths: [], scrubPaths: [] },
  backends: [{ name: 'bubblewrap', available: true, version: '0.10.0' }],
  plan: { kind: 'sandboxed', backend: 'bubblewrap' },
};

function makeHost(result: { status?: SandboxStatusData; error?: Error }) {
  const getSandboxStatus =
    result.error !== undefined
      ? vi.fn().mockRejectedValue(result.error)
      : vi.fn().mockResolvedValue(result.status);
  const addChild = vi.fn();
  const requestRender = vi.fn();
  const showError = vi.fn();
  const host = {
    state: {
      transcriptContainer: { addChild },
      ui: { requestRender },
    },
    requireSession: vi.fn(() => ({ getSandboxStatus })),
    showError,
  } as unknown as SlashCommandHost;
  return { host, getSandboxStatus, addChild, requestRender, showError };
}

describe('showSandboxStatus', () => {
  it('mounts the report panel into the transcript', async () => {
    const { host, addChild, requestRender, showError } = makeHost({ status: STATUS });

    await showSandboxStatus(host);

    expect(addChild).toHaveBeenCalledTimes(1);
    expect(requestRender).toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('shows an error instead of a panel when the status RPC fails', async () => {
    const { host, addChild, showError } = makeHost({ error: new Error('rpc down') });

    await showSandboxStatus(host);

    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError.mock.calls[0]?.[0]).toContain('rpc down');
    expect(addChild).not.toHaveBeenCalled();
  });

  it('localizes the panel border title in zh-CN', async () => {
    setLocalePreference('zh-CN');
    const { host, addChild } = makeHost({ status: STATUS });

    await showSandboxStatus(host);

    const panel = addChild.mock.calls[0]?.[0] as { render: (width: number) => string[] };
    const out = panel
      .render(80)
      .join('\n')
      .replaceAll(/\[[0-9;]*m/g, '');
    expect(out).toContain('沙箱');
    expect(out).not.toContain('Sandbox');
    setLocalePreference('en');
  });
});

describe('handleSandboxCommand — on|off', () => {
  function makeToggleHost() {
    const setSandboxMode = vi.fn().mockResolvedValue(undefined);
    const setConfig = vi.fn().mockResolvedValue(undefined);
    const showStatus = vi.fn();
    const showError = vi.fn();
    const getSandboxStatus = vi.fn().mockResolvedValue(STATUS);
    const addChild = vi.fn();
    const host = {
      session: { setSandboxMode, getSandboxStatus },
      harness: { setConfig },
      requireSession: vi.fn(() => ({ getSandboxStatus })),
      state: {
        transcriptContainer: { addChild },
        ui: { requestRender: vi.fn() },
      },
      showStatus,
      showError,
    } as unknown as SlashCommandHost;
    return { host, setSandboxMode, setConfig, showStatus, showError, addChild };
  }

  it('on applies the auto override to the session and persists it', async () => {
    const { host, setSandboxMode, setConfig, showStatus, showError } = makeToggleHost();

    await handleSandboxCommand(host, 'on');

    expect(setSandboxMode).toHaveBeenCalledWith('auto');
    expect(setConfig).toHaveBeenCalledWith({ sandbox: { mode: 'auto' } });
    expect(showStatus).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
  });

  it('off disables the sandbox for the session and persists it', async () => {
    const { host, setSandboxMode, setConfig } = makeToggleHost();

    await handleSandboxCommand(host, ' off ');

    expect(setSandboxMode).toHaveBeenCalledWith('off');
    expect(setConfig).toHaveBeenCalledWith({ sandbox: { mode: 'off' } });
  });

  it('bare and status args show the report panel', async () => {
    const { host, addChild, setSandboxMode } = makeToggleHost();

    await handleSandboxCommand(host, '');
    await handleSandboxCommand(host, 'status');

    expect(addChild).toHaveBeenCalledTimes(2);
    expect(setSandboxMode).not.toHaveBeenCalled();
  });

  it('rejects unknown arguments with the usage line', async () => {
    const { host, showError, setSandboxMode } = makeToggleHost();

    await handleSandboxCommand(host, 'enforce');

    expect(showError).toHaveBeenCalledTimes(1);
    expect(setSandboxMode).not.toHaveBeenCalled();
  });

  it('reports a toggle RPC failure without persisting', async () => {
    const { host, setSandboxMode, setConfig, showError } = makeToggleHost();
    setSandboxMode.mockRejectedValue(new Error('rpc down'));

    await handleSandboxCommand(host, 'off');

    expect(showError).toHaveBeenCalledTimes(1);
    expect(setConfig).not.toHaveBeenCalled();
  });
});

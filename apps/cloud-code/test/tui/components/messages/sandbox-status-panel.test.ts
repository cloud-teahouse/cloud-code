import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SandboxStatusData } from '@cloud-code/sdk';

import { buildSandboxStatusReportLines } from '#/tui/components/messages/sandbox-status-panel';
import { setLocalePreference } from '#/tui/i18n';

function strip(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replaceAll(/\x1b\[[0-9;]*m/g, '');
}

function baseStatus(): SandboxStatusData {
  return {
    mode: 'auto',
    configured: true,
    environment: 'local',
    local: true,
    workspaceCwd: '/work',
    network: 'allow',
    escalation: 'ask',
    configuredWritableRoots: [],
    configuredDenyRead: [],
    policy: {
      writableRoots: ['/work', '/tmp'],
      denyReadPaths: ['/home/u/.ssh', '/home/u/.cloud-code'],
      network: 'allow',
    },
    guard: {
      readOnlySubpaths: ['/work/.git/config', '/home/u/.cloud-code'],
      scrubPaths: ['/work/.cloud-code'],
    },
    backends: [{ name: 'bubblewrap', available: true, version: '0.10.0' }],
    plan: { kind: 'sandboxed', backend: 'bubblewrap' },
  };
}

function render(status: SandboxStatusData): string[] {
  return buildSandboxStatusReportLines({ status }).map(strip);
}

describe('buildSandboxStatusReportLines', () => {
  beforeEach(() => {
    setLocalePreference('en');
  });

  afterEach(() => {
    setLocalePreference('en');
  });

  it('renders the sandboxed state with backend version, policy, and config origin', () => {
    const lines = render(baseStatus());
    const joined = lines.join('\n');

    expect(joined).toContain('sandboxed (bubblewrap)');
    expect(joined).toContain('available');
    expect(joined).toContain('0.10.0');
    expect(joined).toContain('/work');
    expect(joined).toContain('/home/u/.ssh');
    expect(joined).toContain('2 control-plane paths re-bound read-only');
    expect(joined).toContain('/work/.git/config');
    expect(joined).toContain('1 paths scrubbed if planted by a command');
    expect(joined).toContain('allow');
    expect(joined).toContain('ask — prompt before unsandboxed retry');
    expect(joined).toContain('Source: [sandbox] section of config.toml');
  });

  it('renders the backend-missing state with probe reason and remediation', () => {
    const status: SandboxStatusData = {
      ...baseStatus(),
      backends: [
        {
          name: 'bubblewrap',
          available: false,
          reason: 'bwrap smoke run failed:\nexit 1',
        },
      ],
      plan: {
        kind: 'unsandboxed',
        reason: 'no sandbox backend available (bubblewrap: bwrap smoke run failed: exit 1)',
      },
    };
    const lines = render(status);
    const joined = lines.join('\n');

    expect(joined).toContain('unavailable');
    // The multi-line probe reason is folded onto one row.
    expect(joined).toContain('bwrap smoke run failed: exit 1');
    expect(joined).toContain('Install bubblewrap (bwrap)');
    expect(joined).toContain('unsandboxed — no sandbox backend available');
    // The box renderer treats each string as exactly one row.
    for (const line of lines) {
      expect(line).not.toContain('\n');
    }
  });

  it('renders mode off without policy rows, but still shows the probed backend', () => {
    const lines = render({
      ...baseStatus(),
      mode: 'off',
      configured: false,
      plan: { kind: 'unsandboxed', reason: 'sandbox mode is off' },
    });
    const joined = lines.join('\n');

    expect(joined).toContain('off — commands run without the OS sandbox');
    expect(joined).toContain('available');
    expect(joined).not.toContain('Writable');
    expect(joined).not.toContain('Deny read');
    expect(joined).toContain('Source: built-in defaults');
  });

  it('renders the fail-closed explanation for enforce on a non-local environment', () => {
    const lines = render({
      ...baseStatus(),
      mode: 'enforce',
      environment: 'ssh:example',
      local: false,
      plan: {
        kind: 'unsandboxed',
        reason: 'OS sandboxing requires a local execution environment (kaos: "ssh:example")',
      },
      unavailableReason:
        'sandbox.mode is "enforce" but the execution environment is not local ' +
        '(kaos: "ssh:example"); bubblewrap sandboxing requires a local environment. ' +
        'Set sandbox.mode to "auto" or "off" to allow unsandboxed execution.',
    });
    const joined = lines.join('\n');

    expect(joined).toContain('not local');
    expect(joined).toContain('ssh:example');
    expect(joined).toContain('— OS sandboxing requires a local environment');
  });

  it('renders labels and values in zh-CN', () => {
    setLocalePreference('zh-CN');
    const joined = render(baseStatus()).join('\n');

    expect(joined).toContain('沙箱');
    expect(joined).toContain('禁读');
    expect(joined).toContain('可用');
    expect(joined).toContain('已沙箱化（bubblewrap）');
    expect(joined).toContain('来源：config.toml 的 [sandbox] 配置节');
  });
});

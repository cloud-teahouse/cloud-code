import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GithubRelease, ReleaseCheck } from '#/cli/update/github/types';
import { handleUpdateCommand, parseUpdateArgs } from '#/tui/commands/update';
import { setLocalePreference } from '#/tui/i18n';

const RELEASE: GithubRelease = {
  tag: 'v0.3.0',
  version: '0.3.0',
  publishedAt: '2026-07-15T08:30:00Z',
  assets: [],
};

const BETA_RELEASE: GithubRelease = {
  tag: 'beta',
  version: '2fd4e1c6-beta',
  publishedAt: '2026-08-01T10:00:00Z',
  assets: [],
  body: 'build-commit: 2fd4e1c67a2d28fced849ee1bb76e7391b93eb12\nbuild-version: 2fd4e1c6-beta',
};

function makeHost() {
  return {
    state: {
      appState: {
        streamingPhase: 'idle',
        isCompacting: false,
        model: '',
        version: '0.2.0',
      },
    },
    session: undefined,
    skillCommandMap: new Map<string, string>(),
    pluginCommandMap: new Map<string, string>(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
  };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    channel: () => 'release' as const,
    checkForUpdate: vi.fn(
      async (): Promise<ReleaseCheck> => ({ kind: 'update-available', release: RELEASE }),
    ),
    checkBetaForUpdate: vi.fn(
      async (): Promise<ReleaseCheck> => ({ kind: 'update-available', release: BETA_RELEASE }),
    ),
    fetchReleaseByTag: vi.fn(async (): Promise<GithubRelease | null> => RELEASE),
    detectBinaryInstall: vi.fn(() => ({ kind: 'source' as const })),
    applyBinaryUpdate: vi.fn(async () => ({
      kind: 'applied' as const,
      version: '0.3.0',
      execPath: '/home/u/bin/cloud-code',
      backupPath: '/home/u/bin/cloud-code.bak',
    })),
    currentVersion: () => '0.2.0',
    ...overrides,
  };
}

beforeEach(() => {
  setLocalePreference('en');
});

describe('parseUpdateArgs', () => {
  it('parses check modes', () => {
    expect(parseUpdateArgs('')).toEqual({ mode: 'check' });
    expect(parseUpdateArgs('  check  ')).toEqual({ mode: 'check' });
  });

  it('parses apply modes with optional version pinning', () => {
    expect(parseUpdateArgs('apply')).toEqual({ mode: 'apply', version: null });
    expect(parseUpdateArgs('apply 0.3.0')).toEqual({ mode: 'apply', version: '0.3.0' });
    expect(parseUpdateArgs('apply v0.3.0')).toEqual({ mode: 'apply', version: 'v0.3.0' });
    expect(parseUpdateArgs('0.3.0')).toEqual({ mode: 'apply', version: '0.3.0' });
    expect(parseUpdateArgs('v0.3.0')).toEqual({ mode: 'apply', version: 'v0.3.0' });
  });

  it('rejects unknown arguments and extra fields', () => {
    expect(parseUpdateArgs('latest')).toEqual({ mode: 'error', arg: 'latest' });
    expect(parseUpdateArgs('apply notsemver')).toEqual({ mode: 'error', arg: 'notsemver' });
    expect(parseUpdateArgs('check now')).toEqual({ mode: 'error', arg: 'check now' });
    expect(parseUpdateArgs('apply 0.3.0 extra')).toEqual({
      mode: 'error',
      arg: 'apply 0.3.0 extra',
    });
  });
});

describe('/update check', () => {
  it('reports an available update with version and date', async () => {
    const host = makeHost();
    await handleUpdateCommand(host as never, '', makeDeps());
    expect(host.showNotice).toHaveBeenCalledWith(
      'New version available: v0.3.0 (published 2026-07-15)',
      'Run /update apply to install it (binary installs only).',
    );
  });

  it('reports up-to-date', async () => {
    const host = makeHost();
    const deps = makeDeps({
      checkForUpdate: vi.fn(async (): Promise<ReleaseCheck> => ({
        kind: 'up-to-date',
        release: RELEASE,
      })),
    });
    await handleUpdateCommand(host as never, 'check', deps);
    expect(host.showStatus).toHaveBeenCalledWith(
      'Cloud Code CLI is up to date (v0.3.0).',
      'success',
    );
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  it('reports no-releases-yet', async () => {
    const host = makeHost();
    const deps = makeDeps({
      checkForUpdate: vi.fn(async (): Promise<ReleaseCheck> => ({ kind: 'no-releases' })),
    });
    await handleUpdateCommand(host as never, '', deps);
    expect(host.showStatus).toHaveBeenCalledWith('No releases published yet.', 'textMuted');
  });

  it('surfaces check failures without crashing', async () => {
    const host = makeHost();
    const deps = makeDeps({
      checkForUpdate: vi.fn(async () => {
        throw new Error('network down');
      }),
    });
    await handleUpdateCommand(host as never, '', deps);
    expect(host.showError).toHaveBeenCalledWith('Failed to check for updates: network down');
  });

  it('rejects unknown arguments', async () => {
    const host = makeHost();
    await handleUpdateCommand(host as never, 'latest', makeDeps());
    expect(host.showError).toHaveBeenCalledWith(
      'Unknown /update argument: latest. Usage: /update [check|apply] [<version>]',
    );
  });
});

describe('/update apply', () => {
  it('prints source-mode guidance instead of failing on non-binary installs', async () => {
    const host = makeHost();
    const deps = makeDeps();
    await handleUpdateCommand(host as never, 'apply', deps);
    expect(deps.applyBinaryUpdate).not.toHaveBeenCalled();
    expect(host.showNotice).toHaveBeenCalledWith(
      'v0.3.0 is available, but this is not a binary install',
      'Update via your package manager (e.g. npm install -g @cloud-teahouse/cloudcode-cli@latest) or pull the latest source and rebuild.',
    );
  });

  it('applies the update on binary installs and prints the restart hint', async () => {
    const host = makeHost();
    const deps = makeDeps({
      detectBinaryInstall: vi.fn(() => ({
        kind: 'binary' as const,
        execPath: '/home/u/bin/cloud-code',
      })),
    });
    await handleUpdateCommand(host as never, 'apply', deps);
    expect(deps.applyBinaryUpdate).toHaveBeenCalledWith(RELEASE, {
      execPath: '/home/u/bin/cloud-code',
    });
    expect(host.showNotice).toHaveBeenCalledWith(
      'Updated to v0.3.0',
      'Restart Cloud Code CLI to use the new version. Previous binary backed up at: /home/u/bin/cloud-code.bak',
    );
  });

  it('includes the restore hint when the replace fails after backup', async () => {
    const host = makeHost();
    const deps = makeDeps({
      detectBinaryInstall: vi.fn(() => ({
        kind: 'binary' as const,
        execPath: '/home/u/bin/cloud-code',
      })),
      applyBinaryUpdate: vi.fn(async () => ({
        kind: 'failed' as const,
        stage: 'replace' as const,
        message: 'EPERM: locked',
        execPath: '/home/u/bin/cloud-code',
        backupPath: '/home/u/bin/cloud-code.bak',
      })),
    });
    await handleUpdateCommand(host as never, 'apply', deps);
    expect(host.showNotice).toHaveBeenCalledWith(
      'Update failed: EPERM: locked',
      'Restore the previous binary with: mv /home/u/bin/cloud-code.bak /home/u/bin/cloud-code',
    );
  });

  it('does not reinstall when already up to date', async () => {
    const host = makeHost();
    const deps = makeDeps({
      checkForUpdate: vi.fn(async (): Promise<ReleaseCheck> => ({
        kind: 'up-to-date',
        release: RELEASE,
      })),
    });
    await handleUpdateCommand(host as never, 'apply', deps);
    expect(deps.applyBinaryUpdate).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'Cloud Code CLI is up to date (v0.3.0).',
      'success',
    );
  });

  it('fetches a pinned version tag', async () => {
    const host = makeHost();
    const deps = makeDeps();
    await handleUpdateCommand(host as never, '0.3.0', deps);
    expect(deps.fetchReleaseByTag).toHaveBeenCalledWith('v0.3.0');
    expect(deps.checkForUpdate).not.toHaveBeenCalled();
  });

  it('reports an unknown pinned tag', async () => {
    const host = makeHost();
    const deps = makeDeps({ fetchReleaseByTag: vi.fn(async () => null) });
    await handleUpdateCommand(host as never, 'v9.9.9', deps);
    expect(host.showError).toHaveBeenCalledWith('No release found for tag v9.9.9.');
  });
});

describe('/update i18n', () => {
  it('renders check and guidance messages in zh-CN', async () => {
    setLocalePreference('zh-CN');
    const host = makeHost();
    await handleUpdateCommand(host as never, '', makeDeps());
    expect(host.showNotice).toHaveBeenCalledWith(
      '发现新版本：v0.3.0（发布于 2026-07-15）',
      '运行 /update apply 进行安装（仅限二进制安装）。',
    );

    const guidanceHost = makeHost();
    await handleUpdateCommand(guidanceHost as never, 'apply', makeDeps());
    expect(guidanceHost.showNotice).toHaveBeenCalledWith(
      'v0.3.0 已发布，但当前不是二进制安装',
      '请通过包管理器更新（例如 npm install -g @cloud-teahouse/cloudcode-cli@latest），或拉取最新源码后重新构建。',
    );
  });
});

describe('/update channels', () => {
  it('refuses check and apply on dev builds, without touching the network', async () => {
    const deps = makeDeps({ channel: () => 'dev' as const });
    const checkHost = makeHost();
    await handleUpdateCommand(checkHost as never, '', deps);
    expect(checkHost.showNotice).toHaveBeenCalledWith(
      'dev builds do not support automatic updates',
      'dev builds are internal CI artifacts — rebuild from source or download the latest CI artifact to update.',
    );

    const applyHost = makeHost();
    await handleUpdateCommand(applyHost as never, 'apply', deps);
    expect(applyHost.showNotice).toHaveBeenCalledWith(
      'dev builds do not support automatic updates',
      'dev builds are internal CI artifacts — rebuild from source or download the latest CI artifact to update.',
    );

    expect(deps.checkForUpdate).not.toHaveBeenCalled();
    expect(deps.checkBetaForUpdate).not.toHaveBeenCalled();
    expect(deps.applyBinaryUpdate).not.toHaveBeenCalled();
  });

  it('prints the dev refusal in zh-CN', async () => {
    setLocalePreference('zh-CN');
    const host = makeHost();
    await handleUpdateCommand(host as never, 'check', makeDeps({ channel: () => 'dev' as const }));
    expect(host.showNotice).toHaveBeenCalledWith(
      'dev 版不支持自动更新',
      'dev 构建是内部 CI 产物——请重新构建源码，或下载最新的 CI 构件来更新。',
    );
  });

  it('checks the rolling beta release instead of latest on beta builds', async () => {
    const deps = makeDeps({ channel: () => 'beta' as const });
    const host = makeHost();
    await handleUpdateCommand(host as never, '', deps);
    expect(deps.checkBetaForUpdate).toHaveBeenCalled();
    expect(deps.checkForUpdate).not.toHaveBeenCalled();
    expect(host.showNotice).toHaveBeenCalledWith(
      'New beta build available: 2fd4e1c6-beta (published 2026-08-01)',
      'Run /update apply to install it (binary installs only).',
    );
  });

  it('reports beta up-to-date and no-beta-builds with beta wording', async () => {
    const upToDate = makeHost();
    await handleUpdateCommand(upToDate as never, '', makeDeps({
      channel: () => 'beta' as const,
      checkBetaForUpdate: vi.fn(async (): Promise<ReleaseCheck> => ({
        kind: 'up-to-date',
        release: BETA_RELEASE,
      })),
    }));
    expect(upToDate.showStatus).toHaveBeenCalledWith(
      'Cloud Code CLI is up to date (beta build 2fd4e1c6-beta).',
      'success',
    );

    const noBuilds = makeHost();
    await handleUpdateCommand(noBuilds as never, '', makeDeps({
      channel: () => 'beta' as const,
      checkBetaForUpdate: vi.fn(async (): Promise<ReleaseCheck> => ({ kind: 'no-releases' })),
    }));
    expect(noBuilds.showStatus).toHaveBeenCalledWith('No beta builds published yet.', 'textMuted');
  });

  it('applies the rolling beta release on binary installs', async () => {
    const deps = makeDeps({
      channel: () => 'beta' as const,
      detectBinaryInstall: vi.fn(() => ({
        kind: 'binary' as const,
        execPath: '/home/u/bin/cloud-code',
      })),
      applyBinaryUpdate: vi.fn(async () => ({
        kind: 'applied' as const,
        version: '2fd4e1c6-beta',
        execPath: '/home/u/bin/cloud-code',
        backupPath: '/home/u/bin/cloud-code.bak',
      })),
    });
    const host = makeHost();
    await handleUpdateCommand(host as never, 'apply', deps);
    expect(deps.applyBinaryUpdate).toHaveBeenCalledWith(BETA_RELEASE, {
      execPath: '/home/u/bin/cloud-code',
    });
    expect(host.showNotice).toHaveBeenCalledWith(
      'Updated to beta build 2fd4e1c6-beta',
      'Restart Cloud Code CLI to use the new version. Previous binary backed up at: /home/u/bin/cloud-code.bak',
    );
  });

  it('prints beta source-install guidance with the beta dist-tag hint', async () => {
    const host = makeHost();
    await handleUpdateCommand(host as never, 'apply', makeDeps({ channel: () => 'beta' as const }));
    expect(host.showNotice).toHaveBeenCalledWith(
      'beta build 2fd4e1c6-beta is available, but this is not a binary install',
      'Update via your package manager (e.g. npm install -g @cloud-teahouse/cloudcode-cli@beta) or download the newest beta build.',
    );
  });
});

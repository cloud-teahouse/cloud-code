import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import { handlePluginsCommand } from '#/tui/commands/plugins';
import { PluginsPanelComponent } from '#/tui/components/dialogs/plugins-selector';
import { setLocalePreference } from '#/tui/i18n';
import { addMarketplace, listMarketplaces } from '#/utils/plugin-marketplace-registry';

type ConfirmResult = { readonly kind: 'confirm' } | { readonly kind: 'cancel' };

// Controllable stand-ins for the confirm dialogs: each mount records the
// onDone callback so a test can resolve the prompt as confirmed or cancelled.
const trustPrompts: Array<{ resolve: (result: ConfirmResult) => void }> = [];
const removePrompts: Array<{ resolve: (result: ConfirmResult) => void }> = [];
const marketplaceTrustPrompts: Array<{ resolve: (result: ConfirmResult) => void }> = [];
const marketplaceRemovePrompts: Array<{
  resolve: (result: ConfirmResult) => void;
  affectedPlugins?: readonly string[];
}> = [];

vi.mock('#/tui/components/dialogs/plugins-selector', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('#/tui/components/dialogs/plugins-selector')>();
  return {
    ...actual,
    PluginInstallTrustConfirmComponent: class {
      readonly resolve: (result: ConfirmResult) => void;
      constructor(opts: { onDone: (result: ConfirmResult) => void }) {
        this.resolve = opts.onDone;
        trustPrompts.push({ resolve: this.resolve });
      }
    },
    PluginRemoveConfirmComponent: class {
      readonly resolve: (result: ConfirmResult) => void;
      constructor(opts: { onDone: (result: ConfirmResult) => void }) {
        this.resolve = opts.onDone;
        removePrompts.push({ resolve: this.resolve });
      }
    },
    MarketplaceTrustConfirmComponent: class {
      readonly resolve: (result: ConfirmResult) => void;
      constructor(opts: { onDone: (result: ConfirmResult) => void }) {
        this.resolve = opts.onDone;
        marketplaceTrustPrompts.push({ resolve: this.resolve });
      }
    },
    MarketplaceRemoveConfirmComponent: class {
      readonly resolve: (result: ConfirmResult) => void;
      constructor(opts: {
        affectedPlugins?: readonly string[];
        onDone: (result: ConfirmResult) => void;
      }) {
        this.resolve = opts.onDone;
        marketplaceRemovePrompts.push({ resolve: this.resolve, affectedPlugins: opts.affectedPlugins });
      }
    },
  };
});

const loadPluginMarketplaceMock = vi.fn();

vi.mock('#/utils/plugin-marketplace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/utils/plugin-marketplace')>();
  return { ...actual, loadPluginMarketplace: (...args: unknown[]) => loadPluginMarketplaceMock(...args) };
});

const materializeMarketplaceSourceMock = vi.fn();
const loadCatalogForRegistrationMock = vi.fn();
const loadMarketplaceCatalogForSourceMock = vi.fn();
const refreshMarketplaceCatalogMock = vi.fn();

vi.mock('#/utils/plugin-marketplace-sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/utils/plugin-marketplace-sources')>();
  return {
    ...actual,
    materializeMarketplaceSource: (...args: unknown[]) => materializeMarketplaceSourceMock(...args),
    loadCatalogForRegistration: (...args: unknown[]) => loadCatalogForRegistrationMock(...args),
    loadMarketplaceCatalogForSource: (...args: unknown[]) =>
      loadMarketplaceCatalogForSourceMock(...args),
    refreshMarketplaceCatalog: (...args: unknown[]) => refreshMarketplaceCatalogMock(...args),
  };
});

const promptChoiceMock = vi.fn();
const promptInputMock = vi.fn();

vi.mock('#/tui/commands/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/tui/commands/prompts')>();
  return {
    ...actual,
    promptChoice: (...args: unknown[]) => promptChoiceMock(...args),
    promptInput: (...args: unknown[]) => promptInputMock(...args),
  };
});

const tempDirs: string[] = [];
const originalHome = process.env['CLOUD_CODE_HOME'];

async function makeHome(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'plugins-command-test-')));
  tempDirs.push(dir);
  process.env['CLOUD_CODE_HOME'] = dir;
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  if (originalHome === undefined) {
    delete process.env['CLOUD_CODE_HOME'];
  } else {
    process.env['CLOUD_CODE_HOME'] = originalHome;
  }
});

beforeEach(() => {
  trustPrompts.length = 0;
  removePrompts.length = 0;
  marketplaceTrustPrompts.length = 0;
  marketplaceRemovePrompts.length = 0;
  loadPluginMarketplaceMock.mockReset();
  loadPluginMarketplaceMock.mockResolvedValue({ source: 'test', plugins: [] });
  materializeMarketplaceSourceMock.mockReset();
  materializeMarketplaceSourceMock.mockResolvedValue({ source: 'test', plugins: [] });
  loadCatalogForRegistrationMock.mockReset();
  loadCatalogForRegistrationMock.mockResolvedValue({ source: 'test', plugins: [] });
  loadMarketplaceCatalogForSourceMock.mockReset();
  loadMarketplaceCatalogForSourceMock.mockResolvedValue({ source: 'test', plugins: [] });
  refreshMarketplaceCatalogMock.mockReset();
  refreshMarketplaceCatalogMock.mockResolvedValue({ source: 'test', plugins: [] });
  promptChoiceMock.mockReset();
  promptInputMock.mockReset();
});

function makeHost(session: Record<string, unknown> = {}) {
  const mounted: unknown[] = [];
  const transcriptAdded: unknown[] = [];
  const host = {
    state: {
      appState: { workDir: '/tmp/work' },
      transcriptContainer: { addChild: vi.fn((child: unknown) => transcriptAdded.push(child)) },
      ui: { requestRender: vi.fn() },
    },
    requireSession: vi.fn(() => session),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showProgressSpinner: vi.fn(() => ({ stop: vi.fn() })),
    mountEditorReplacement: vi.fn((component: unknown) => {
      mounted.push(component);
      return { id: mounted.length };
    }),
    restoreEditor: vi.fn(),
  };
  return {
    host: host as unknown as SlashCommandHost,
    session,
    mounted,
    transcriptAdded,
    showStatus: host.showStatus,
    showError: host.showError,
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    listPlugins: vi.fn(async () => []),
    installPlugin: vi.fn(async () => ({
      id: 'demo',
      displayName: 'Demo',
      enabled: true,
      state: 'ok',
      skillCount: 0,
      mcpServerCount: 0,
      enabledMcpServerCount: 0,
      hookCount: 0,
      commandCount: 0,
      hasErrors: false,
      source: 'local-path',
    })),
    setPluginEnabled: vi.fn(async () => {}),
    getPluginInfo: vi.fn(async () => {
      throw new Error('not found');
    }),
    removePlugin: vi.fn(async () => {}),
    reloadPlugins: vi.fn(async () => ({ added: [], removed: [], errors: [] })),
    ...overrides,
  };
}

describe('/plugins enable|disable scopes', () => {
  it('passes user scope (no flag) through without scope options', async () => {
    const session = makeSession();
    const { host } = makeHost(session);
    await handlePluginsCommand(host, 'disable demo');
    expect(session.setPluginEnabled).toHaveBeenCalledWith('demo', false);
  });

  it('passes --project scope with the session workDir', async () => {
    const session = makeSession();
    const { host } = makeHost(session);
    await handlePluginsCommand(host, 'enable demo --project');
    expect(session.setPluginEnabled).toHaveBeenCalledWith('demo', true, {
      scope: 'project',
      workDir: '/tmp/work',
    });
  });

  it('rejects unknown scope flags', async () => {
    const session = makeSession();
    const { host, showError } = makeHost(session);
    await handlePluginsCommand(host, 'enable demo --bogus');
    expect(session.setPluginEnabled).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledOnce();
  });
});

describe('/plugins uninstall', () => {
  it('removes the plugin after confirmation', async () => {
    const session = makeSession();
    const { host } = makeHost(session);
    const done = handlePluginsCommand(host, 'uninstall demo');
    await vi.waitFor(() => {
      expect(removePrompts).toHaveLength(1);
    });
    removePrompts[0]!.resolve({ kind: 'confirm' });
    await done;
    expect(session.removePlugin).toHaveBeenCalledWith('demo');
  });

  it('does not remove when the confirmation is cancelled', async () => {
    const session = makeSession();
    const { host } = makeHost(session);
    const done = handlePluginsCommand(host, 'remove demo');
    await vi.waitFor(() => {
      expect(removePrompts).toHaveLength(1);
    });
    removePrompts[0]!.resolve({ kind: 'cancel' });
    await done;
    expect(session.removePlugin).not.toHaveBeenCalled();
  });
});

describe('/plugins install trust flow', () => {
  it('installs a third-party source only after the trust prompt is confirmed', async () => {
    const session = makeSession();
    const { host } = makeHost(session);
    const done = handlePluginsCommand(host, 'install /opt/third-party-plugin');
    await vi.waitFor(() => {
      expect(trustPrompts).toHaveLength(1);
    });
    expect(session.installPlugin).not.toHaveBeenCalled();
    trustPrompts[0]!.resolve({ kind: 'confirm' });
    await done;
    expect(session.installPlugin).toHaveBeenCalledWith('/opt/third-party-plugin');
  });

  it('cancelling the trust prompt skips the install', async () => {
    const session = makeSession();
    const { host, showStatus } = makeHost(session);
    const done = handlePluginsCommand(host, 'install /opt/third-party-plugin');
    await vi.waitFor(() => {
      expect(trustPrompts).toHaveLength(1);
    });
    trustPrompts[0]!.resolve({ kind: 'cancel' });
    await done;
    expect(session.installPlugin).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenCalledWith('Install cancelled.');
  });

  it('installs official code.kimi.com sources without a trust prompt', async () => {
    const session = makeSession();
    const { host } = makeHost(session);
    await handlePluginsCommand(
      host,
      'install https://code.kimi.com/kimi-code/plugins/official/demo.zip',
    );
    expect(trustPrompts).toHaveLength(0);
    expect(session.installPlugin).toHaveBeenCalledWith(
      'https://code.kimi.com/kimi-code/plugins/official/demo.zip',
    );
  });
});

describe('/plugins marketplace registry commands', () => {
  it('adds and lists a marketplace after the trust prompt is confirmed', async () => {
    await makeHome();
    materializeMarketplaceSourceMock.mockResolvedValue({
      source: 'https://example.com/marketplace.json',
      plugins: [{ id: 'a' }, { id: 'b' }],
    });
    const session = makeSession();
    const { host, transcriptAdded, showStatus } = makeHost(session);
    const done = handlePluginsCommand(host, 'marketplace add acme https://example.com/marketplace.json');
    await vi.waitFor(() => {
      expect(marketplaceTrustPrompts).toHaveLength(1);
    });
    marketplaceTrustPrompts[0]!.resolve({ kind: 'confirm' });
    await done;
    expect(materializeMarketplaceSourceMock).toHaveBeenCalledWith(
      'acme',
      { kind: 'url', source: 'https://example.com/marketplace.json' },
      { workDir: '/tmp/work' },
    );
    expect(showStatus).toHaveBeenCalledWith(
      'Marketplace "acme" added (2 plugins): https://example.com/marketplace.json',
    );
    const registered = await listMarketplaces();
    expect(registered.map((m) => m.name)).toEqual(['official', 'acme']);
    expect(registered[1]?.sourceKind).toBe('url');

    await handlePluginsCommand(host, 'marketplace list');
    expect(transcriptAdded).toHaveLength(1);
  });

  it('cancelling the add trust prompt skips registration and the fetch', async () => {
    await makeHome();
    const session = makeSession();
    const { host, showStatus } = makeHost(session);
    const done = handlePluginsCommand(host, 'marketplace add acme https://example.com/marketplace.json');
    await vi.waitFor(() => {
      expect(marketplaceTrustPrompts).toHaveLength(1);
    });
    marketplaceTrustPrompts[0]!.resolve({ kind: 'cancel' });
    await done;
    expect(materializeMarketplaceSourceMock).not.toHaveBeenCalled();
    expect((await listMarketplaces()).map((m) => m.name)).toEqual(['official']);
    expect(showStatus).toHaveBeenCalledWith('Marketplace add cancelled.');
  });

  it('runs the add wizard when no arguments are given', async () => {
    await makeHome();
    promptChoiceMock.mockResolvedValue('url');
    promptInputMock
      .mockResolvedValueOnce('https://example.com/marketplace.json')
      .mockResolvedValueOnce('acme');
    const session = makeSession();
    const { host } = makeHost(session);
    const done = handlePluginsCommand(host, 'marketplace add');
    await vi.waitFor(() => {
      expect(marketplaceTrustPrompts).toHaveLength(1);
    });
    marketplaceTrustPrompts[0]!.resolve({ kind: 'confirm' });
    await done;
    expect(materializeMarketplaceSourceMock).toHaveBeenCalledWith(
      'acme',
      { kind: 'url', source: 'https://example.com/marketplace.json' },
      { workDir: '/tmp/work' },
    );
    expect((await listMarketplaces()).map((m) => m.name)).toEqual(['official', 'acme']);
  });

  it('runs the add wizard with localized prompts in zh-CN', async () => {
    setLocalePreference('zh-CN');
    await makeHome();
    // Abort after the first prompt so the flow stops before any fetch/clone.
    promptChoiceMock.mockResolvedValue(undefined);
    const session = makeSession();
    const { host } = makeHost(session);
    await handlePluginsCommand(host, 'marketplace add');
    expect(promptChoiceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: '添加市场 — 选择来源类型',
        options: expect.arrayContaining([
          expect.objectContaining({ value: 'github', label: 'GitHub 仓库' }),
          expect.objectContaining({ value: 'local', label: '本地路径' }),
        ]),
      }),
    );
    setLocalePreference('en');
  });

  it('removes a registered marketplace after confirmation and fails for unknown ones', async () => {
    await makeHome();
    const session = makeSession();
    const { host, showStatus, showError } = makeHost(session);
    await addMarketplace('acme', 'https://example.com/marketplace.json');
    const done = handlePluginsCommand(host, 'marketplace remove acme');
    await vi.waitFor(() => {
      expect(marketplaceRemovePrompts).toHaveLength(1);
    });
    marketplaceRemovePrompts[0]!.resolve({ kind: 'confirm' });
    await done;
    expect(showStatus).toHaveBeenCalledWith('Marketplace "acme" removed.');
    expect((await listMarketplaces()).map((m) => m.name)).toEqual(['official']);

    await handlePluginsCommand(host, 'marketplace remove acme');
    expect(showError).toHaveBeenCalled();
  });

  it('cancelling the remove confirmation keeps the marketplace', async () => {
    await makeHome();
    const session = makeSession();
    const { host, showStatus } = makeHost(session);
    await addMarketplace('acme', 'https://example.com/marketplace.json');
    const done = handlePluginsCommand(host, 'marketplace remove acme');
    await vi.waitFor(() => {
      expect(marketplaceRemovePrompts).toHaveLength(1);
    });
    marketplaceRemovePrompts[0]!.resolve({ kind: 'cancel' });
    await done;
    expect(showStatus).toHaveBeenCalledWith('Marketplace remove cancelled: acme.');
    expect((await listMarketplaces()).map((m) => m.name)).toEqual(['official', 'acme']);
  });

  it('refreshes one or all marketplaces', async () => {
    await makeHome();
    refreshMarketplaceCatalogMock.mockResolvedValue({ source: 'test', plugins: [{ id: 'a' }] });
    const session = makeSession();
    const { host } = makeHost(session);
    await addMarketplace('acme', 'https://example.com/marketplace.json');

    await handlePluginsCommand(host, 'marketplace refresh acme');
    expect(refreshMarketplaceCatalogMock).toHaveBeenCalledTimes(1);
    expect(refreshMarketplaceCatalogMock.mock.calls[0]?.[0]).toMatchObject({ name: 'acme' });

    refreshMarketplaceCatalogMock.mockClear();
    await handlePluginsCommand(host, 'marketplace update');
    expect(refreshMarketplaceCatalogMock).toHaveBeenCalledTimes(2);
  });

  it('fails refresh for an unregistered name', async () => {
    await makeHome();
    const session = makeSession();
    const { host, showError } = makeHost(session);
    await handlePluginsCommand(host, 'marketplace refresh nope');
    expect(showError).toHaveBeenCalledWith('Marketplace "nope" is not registered.');
    expect(refreshMarketplaceCatalogMock).not.toHaveBeenCalled();
  });

  it('browsing by name loads the registered marketplace via its typed source', async () => {
    await makeHome();
    const session = makeSession();
    const { host } = makeHost(session);
    await addMarketplace('acme', 'https://example.com/marketplace.json');
    await handlePluginsCommand(host, 'marketplace acme');
    expect(loadCatalogForRegistrationMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'acme', source: 'https://example.com/marketplace.json' }),
      { workDir: '/tmp/work' },
    );
  });

  it('browsing with a raw source parses and loads it', async () => {
    await makeHome();
    const session = makeSession();
    const { host } = makeHost(session);
    await handlePluginsCommand(host, 'marketplace https://elsewhere.dev/m.json');
    expect(loadMarketplaceCatalogForSourceMock).toHaveBeenCalledWith(
      { kind: 'url', source: 'https://elsewhere.dev/m.json' },
      { workDir: '/tmp/work' },
    );
  });
});

describe('/plugins install from marketplaces', () => {
  const acmeCatalog = {
    source: 'https://example.com/marketplace.json',
    plugins: [
      { id: 'superpowers', displayName: 'Superpowers', source: 'https://x/s.zip' },
    ],
  };

  it('installs plugin@marketplace from the named marketplace', async () => {
    await makeHome();
    loadCatalogForRegistrationMock.mockResolvedValue(acmeCatalog);
    const session = makeSession();
    const { host } = makeHost(session);
    await addMarketplace('acme', 'https://example.com/marketplace.json');
    const done = handlePluginsCommand(host, 'install superpowers@acme');
    await vi.waitFor(() => {
      expect(trustPrompts).toHaveLength(1);
    });
    trustPrompts[0]!.resolve({ kind: 'confirm' });
    await done;
    expect(session.installPlugin).toHaveBeenCalledWith('https://x/s.zip');
  });

  it('errors when the plugin is not in the named marketplace', async () => {
    await makeHome();
    loadCatalogForRegistrationMock.mockResolvedValue(acmeCatalog);
    const session = makeSession();
    const { host, showError } = makeHost(session);
    await addMarketplace('acme', 'https://example.com/marketplace.json');
    await handlePluginsCommand(host, 'install nope@acme');
    expect(showError).toHaveBeenCalledWith(
      'Plugin "nope" not found in marketplace "acme". Available: superpowers',
    );
    expect(session.installPlugin).not.toHaveBeenCalled();
  });

  it('installs a bare plugin name found in exactly one marketplace', async () => {
    await makeHome();
    loadCatalogForRegistrationMock.mockResolvedValue(acmeCatalog);
    const session = makeSession();
    const { host } = makeHost(session);
    await addMarketplace('acme', 'https://example.com/marketplace.json');
    const done = handlePluginsCommand(host, 'install superpowers');
    await vi.waitFor(() => {
      expect(trustPrompts).toHaveLength(1);
    });
    trustPrompts[0]!.resolve({ kind: 'confirm' });
    await done;
    expect(session.installPlugin).toHaveBeenCalledWith('https://x/s.zip');
    expect(promptChoiceMock).not.toHaveBeenCalled();
  });

  it('prompts for a marketplace when several carry the bare plugin name', async () => {
    await makeHome();
    loadCatalogForRegistrationMock.mockResolvedValue(acmeCatalog);
    promptChoiceMock.mockResolvedValue('1');
    const session = makeSession();
    const { host } = makeHost(session);
    await addMarketplace('acme', 'https://example.com/marketplace.json');
    await addMarketplace('zeta', 'https://zeta.example.com/marketplace.json');
    const done = handlePluginsCommand(host, 'install superpowers');
    await vi.waitFor(() => {
      expect(promptChoiceMock).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(trustPrompts).toHaveLength(1);
    });
    trustPrompts[0]!.resolve({ kind: 'confirm' });
    await done;
    expect(promptChoiceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        options: [
          expect.objectContaining({ label: 'acme' }),
          expect.objectContaining({ label: 'zeta' }),
        ],
      }),
    );
    expect(session.installPlugin).toHaveBeenCalledWith('https://x/s.zip');
  });

  it('errors when a bare plugin name is in no marketplace', async () => {
    await makeHome();
    const session = makeSession();
    const { host, showError } = makeHost(session);
    await handlePluginsCommand(host, 'install nope');
    expect(showError).toHaveBeenCalledWith(
      expect.stringContaining('Plugin "nope" was not found in any registered marketplace.'),
    );
    expect(session.installPlugin).not.toHaveBeenCalled();
  });
});


describe('/plugins merged marketplace view', () => {
  const officialCatalog = {
    source: 'https://cdn',
    plugins: [
      { id: 'official-plugin', tier: 'official', displayName: 'Official', source: 'https://x/o.zip' },
    ],
  };

  function spyOnSetMarketplace() {
    return vi.spyOn(PluginsPanelComponent.prototype, 'setMarketplace');
  }

  it('merges custom marketplace entries with origin badges and a merged source label', async () => {
    await makeHome();
    loadPluginMarketplaceMock.mockResolvedValue(officialCatalog);
    loadCatalogForRegistrationMock.mockResolvedValue({
      source: 'https://example.com/marketplace.json',
      plugins: [{ id: 'custom-plugin', displayName: 'Custom', source: 'https://x/c.zip' }],
    });
    const session = makeSession();
    const { host } = makeHost(session);
    await addMarketplace('acme', 'https://example.com/marketplace.json');

    const spy = spyOnSetMarketplace();
    let firstCall: unknown;
    try {
      await handlePluginsCommand(host, 'marketplace');
      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalled();
      });
      firstCall = spy.mock.calls[0];
    } finally {
      spy.mockRestore();
    }
    const [entries, sourceLabel] = firstCall as [
      readonly { id: string; marketplace?: string }[],
      string,
    ];
    const official = entries.find((entry) => entry.id === 'official-plugin');
    const custom = entries.find((entry) => entry.id === 'custom-plugin');
    expect(official?.marketplace).toBeUndefined();
    expect(custom?.marketplace).toBe('acme');
    expect(sourceLabel).toBe('https://cdn · 1 custom');
  });

  it('official entries win id conflicts against custom marketplaces', async () => {
    await makeHome();
    loadPluginMarketplaceMock.mockResolvedValue(officialCatalog);
    loadCatalogForRegistrationMock.mockResolvedValue({
      source: 'https://example.com/marketplace.json',
      plugins: [{ id: 'official-plugin', displayName: 'Impostor', source: 'https://x/fake.zip' }],
    });
    const session = makeSession();
    const { host } = makeHost(session);
    await addMarketplace('acme', 'https://example.com/marketplace.json');

    const spy = spyOnSetMarketplace();
    let firstCall: unknown;
    try {
      await handlePluginsCommand(host, 'marketplace');
      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalled();
      });
      firstCall = spy.mock.calls[0];
    } finally {
      spy.mockRestore();
    }
    const [entries] = firstCall as [
      readonly { id: string; displayName: string; marketplace?: string }[],
      string,
    ];
    const matches = entries.filter((entry) => entry.id === 'official-plugin');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.displayName).toBe('Official');
    expect(matches[0]?.marketplace).toBeUndefined();
  });

  it('skips unreachable custom marketplaces with a warning instead of failing the view', async () => {
    await makeHome();
    loadPluginMarketplaceMock.mockResolvedValue(officialCatalog);
    loadCatalogForRegistrationMock.mockRejectedValue(new Error('connection refused'));
    const session = makeSession();
    const { host, showStatus } = makeHost(session);
    await addMarketplace('acme', 'https://example.com/marketplace.json');

    const spy = spyOnSetMarketplace();
    let firstCall: unknown;
    try {
      await handlePluginsCommand(host, 'marketplace');
      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalled();
      });
      firstCall = spy.mock.calls[0];
    } finally {
      spy.mockRestore();
    }
    const [entries, sourceLabel] = firstCall as [
      readonly { id: string }[],
      string,
    ];
    expect(entries.map((entry) => entry.id)).toEqual(['official-plugin']);
    expect(sourceLabel).toBe('https://cdn · 1 custom');
    expect(showStatus).toHaveBeenCalledWith('Skipped unavailable marketplaces: acme', 'warning');
  });
});

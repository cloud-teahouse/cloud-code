import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearStatusPanelDataMemos, showStatusPanel, showStatusReport, showUsage } from '#/tui/commands/info';
import { setLocalePreference } from '#/tui/i18n';
import { loadTokenActivity, loadTokenActivityStats } from '#/tui/services/token-activity';

// Isolate the activity aggregation from the developer's real sessions dir.
vi.mock('#/tui/services/token-activity', () => ({
  loadTokenActivity: vi.fn(async () => ({ buckets: [], providers: [] })),
  loadTokenActivityStats: vi.fn(async () => ({
    totalTokens: 0,
    activeDays: 0,
    mostActiveDay: undefined,
    favoriteModel: undefined,
    sessionCount: 0,
    longestSessionMs: undefined,
  })),
}));

const KIMI_PROVIDER = 'managed:kimi-code';
const CHATGPT_PROVIDER = 'managed:chatgpt-codex';

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

type AccountState = 'logged-in' | 'expired' | 'not-logged-in';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush pending promise chains; microtask-based so it also works under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

function makeHost(overrides: {
  model?: string;
  sessionUsage?: Record<string, unknown>;
  managedUsage?: Record<string, unknown>;
  kimiState?: AccountState;
  chatGptState?: AccountState;
  chatGptEmail?: string;
  snapshotError?: boolean;
}) {
  const mountEditorReplacement = vi.fn().mockReturnValue({ kind: 'handle' });
  const restoreEditor = vi.fn();
  const getManagedUsage = vi.fn().mockResolvedValue({
    kind: 'ok',
    summary: null,
    limits: [],
    extraUsage: null,
  });
  // Default: the endpoint read fails — the tab falls back to the header
  // snapshot. Success-path tests override this mock.
  const fetchCodexUsage = vi.fn().mockRejectedValue(new Error('endpoint unreachable'));
  // Reset-credit redeem endpoints; redeem-flow tests override these.
  const listCodexResetCredits = vi.fn().mockResolvedValue({ availableCount: 0, credits: [] });
  const consumeCodexResetCredit = vi
    .fn()
    .mockResolvedValue({ code: 'reset', rawCode: null, windowsReset: 2 });
  const getAccountSnapshot = overrides.snapshotError
    ? vi.fn().mockRejectedValue(new Error('credential store unreadable'))
    : vi.fn().mockImplementation(async (providerName: string) =>
        providerName === CHATGPT_PROVIDER
          ? {
              state: overrides.chatGptState ?? 'not-logged-in',
              email: overrides.chatGptEmail,
              planType: overrides.chatGptEmail === undefined ? undefined : 'plus',
            }
          : { state: overrides.kimiState ?? 'logged-in' },
      );
  const host = {
    state: {
      appState: {
        model: overrides.model ?? 'kimi-for-coding',
        workDir: '/tmp/project',
        sessionId: 'ses-1',
        sessionTitle: 'My session',
        availableModels: {
          'kimi-for-coding': { provider: KIMI_PROVIDER, model: 'kimi-k2', displayName: 'Kimi for Coding' },
          'gpt-5-codex': { provider: CHATGPT_PROVIDER, model: 'gpt-5-codex', displayName: 'GPT-5 Codex' },
          'local-model': { provider: 'openai', model: 'local-model' },
        },
        contextUsage: 0,
        contextTokens: 0,
        maxContextTokens: 0,
        version: '0.0.0-test',
      },
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    harness: { auth: { getAccountSnapshot, getManagedUsage, fetchCodexUsage, listCodexResetCredits, consumeCodexResetCredit } },
    requireSession: () => ({
      getUsage: vi.fn().mockResolvedValue(overrides.sessionUsage ?? { byModel: {} }),
      listMcpServers: vi.fn().mockResolvedValue([]),
    }),
    mountEditorReplacement,
    restoreEditor,
  };
  return { host, mountEditorReplacement, restoreEditor, getManagedUsage, getAccountSnapshot, fetchCodexUsage, listCodexResetCredits, consumeCodexResetCredit };
}

function mountedDialog(mountEditorReplacement: ReturnType<typeof vi.fn>) {
  const dialog = mountEditorReplacement.mock.calls[0]?.[0] as
    | { render(width: number): string[]; handleInput(data: string): void }
    | undefined;
  if (dialog === undefined) throw new Error('expected the command to mount a dialog');
  return dialog;
}

function renderedLines(mountEditorReplacement: ReturnType<typeof vi.fn>): string[] {
  return mountedDialog(mountEditorReplacement).render(120).map(strip);
}

beforeEach(() => {
  setLocalePreference('en');
  clearStatusPanelDataMemos();
  vi.mocked(loadTokenActivity).mockClear();
  vi.mocked(loadTokenActivityStats).mockClear();
});

afterEach(() => {
  setLocalePreference('en');
});

describe('/usage → /status Kimi Code tab', () => {
  it('opens the dialog on the Kimi Code account tab (the first account tab)', async () => {
    const { host, mountEditorReplacement } = makeHost({
      kimiState: 'logged-in',
      chatGptState: 'not-logged-in',
    });

    await showUsage(host as never);
    await flush();

    const output = renderedLines(mountEditorReplacement).join('\n');
    expect(output).toContain('Account:');
    expect(output).toContain('Logged in');
    expect(output).toContain('No usage data available.');
    // The ChatGPT prompt lives on its own tab, not on the Kimi tab.
    expect(output).not.toContain('Not logged in — run /login to see ChatGPT plan usage.');
    expect(output).not.toContain('loading…');
  });

  it('shows prompts on both account tabs when neither account is logged in', async () => {
    const { host, mountEditorReplacement } = makeHost({
      kimiState: 'not-logged-in',
      chatGptState: 'not-logged-in',
    });

    await showUsage(host as never);
    await flush();

    const dialog = mountedDialog(mountEditorReplacement);
    expect(strip(dialog.render(120).join('\n'))).toContain(
      'Not logged in — run /login to see Kimi plan usage.',
    );

    dialog.handleInput('\t'); // Kimi Code → ChatGPT
    expect(strip(dialog.render(120).join('\n'))).toContain(
      'Not logged in — run /login to see ChatGPT plan usage.',
    );
  });

  it('shows the codex rate-limit rows on the ChatGPT tab for a logged-in account', async () => {
    const { host, mountEditorReplacement } = makeHost({
      model: 'gpt-5-codex',
      chatGptState: 'logged-in',
      chatGptEmail: 'user@example.com',
      sessionUsage: {
        byModel: {},
        rateLimit: {
          planType: 'plus',
          activeLimit: 'premium',
          primary: { usedPercent: 26, windowMinutes: 10080, resetsAt: null },
          secondary: null,
          credits: null,
          capturedAt: Date.now(),
        },
      },
    });

    await showStatusPanel(host as never, 'chatgpt');
    await flush();

    const output = renderedLines(mountEditorReplacement).join('\n');
    expect(output).not.toContain('Model:');
    expect(output).toContain('Account:');
    expect(output).toContain('user@example.com (Plus)');
    expect(output).toContain('Weekly limit');
    expect(output).toContain('74% left');
  });

  it('splits session usage per provider and names unattributable models', async () => {
    const { host, mountEditorReplacement } = makeHost({
      kimiState: 'logged-in',
      chatGptState: 'logged-in',
      chatGptEmail: 'user@example.com',
      sessionUsage: {
        byModel: {
          'kimi-k2': { inputOther: 1000, inputCacheRead: 0, inputCacheCreation: 0, output: 100 },
          'gpt-5-codex': { inputOther: 2000, inputCacheRead: 0, inputCacheCreation: 0, output: 200 },
          'local-model': { inputOther: 500, inputCacheRead: 0, inputCacheCreation: 0, output: 50 },
        },
      },
    });

    await showUsage(host as never);
    await flush();

    const dialog = mountedDialog(mountEditorReplacement);
    const kimiTab = strip(dialog.render(120).join('\n'));
    expect(kimiTab).toContain('kimi-k2');
    expect(kimiTab).not.toMatch(/ {2}gpt-5-codex {2}/);
    expect(kimiTab).toContain('Not shown: local-model');

    dialog.handleInput('\t'); // Kimi Code → ChatGPT
    const chatGptTab = strip(dialog.render(120).join('\n'));
    expect(chatGptTab).toContain('gpt-5-codex');
    expect(chatGptTab).not.toMatch(/ {2}kimi-k2 {2}/);
    expect(chatGptTab).toContain('Not shown: local-model');
  });

  it('does not fetch managed usage when the Kimi account is logged out', async () => {
    const { host, getManagedUsage } = makeHost({ kimiState: 'not-logged-in' });

    await showUsage(host as never);
    await flush();

    expect(getManagedUsage).not.toHaveBeenCalled();
  });

  it('treats a failing credential store as signed out instead of breaking /usage', async () => {
    const { host, mountEditorReplacement } = makeHost({ snapshotError: true });

    await showUsage(host as never);
    await flush();

    const output = renderedLines(mountEditorReplacement).join('\n');
    expect(output).toContain('Not logged in — run /login to see Kimi plan usage.');
  });

  it('shows the managed-usage error text once the endpoint call fails', async () => {
    const { host, mountEditorReplacement, getManagedUsage } = makeHost({ kimiState: 'logged-in' });
    getManagedUsage.mockResolvedValue({ kind: 'error', message: 'usage endpoint exploded' });

    await showUsage(host as never);
    await flush();

    const output = renderedLines(mountEditorReplacement).join('\n');
    expect(output).toContain('usage endpoint exploded');
    expect(output).not.toContain('loading…');
  });
});

describe('/status tabs', () => {
  it('opens the Status tab by default with the global session facts', async () => {
    const { host, mountEditorReplacement } = makeHost({
      chatGptState: 'logged-in',
      chatGptEmail: 'user@example.com',
    });

    await showStatusReport(host as never);
    await flush();

    const output = renderedLines(mountEditorReplacement).join('\n');
    expect(output).toContain('>_ Cloud Code CLI (v0.0.0-test)');
    expect(output).toContain('My session');
    expect(output).toContain('/tmp/project');
    // The account identity moved to the ChatGPT tab.
    expect(output).not.toContain('user@example.com (Plus)');
  });

  it('opens the Kimi Code tab for "/status usage"', async () => {
    const { host, mountEditorReplacement } = makeHost({});

    await showStatusReport(host as never, 'usage');
    await flush();

    expect(renderedLines(mountEditorReplacement).join('\n')).toContain('Account:');
  });

  it('opens the Stats tab for "/status stats"', async () => {
    const { host, mountEditorReplacement } = makeHost({});

    await showStatusReport(host as never, 'stats');
    await flush();

    expect(renderedLines(mountEditorReplacement).join('\n')).toContain('No activity yet');
  });

  it('marks an expired Kimi login on the Kimi Code tab', async () => {
    const { host, mountEditorReplacement } = makeHost({ kimiState: 'expired' });

    await showStatusPanel(host as never, 'kimi');
    await flush();

    expect(renderedLines(mountEditorReplacement).join('\n')).toContain(
      'Login expired — run /login',
    );
  });
});

describe('/status ChatGPT fresh usage fetch', () => {
  function freshCodexUsage(overrides: Record<string, unknown> = {}) {
    return {
      planType: 'pro',
      primary: { usedPercent: 42, windowMinutes: 300, resetsAt: null },
      secondary: { usedPercent: 5, windowMinutes: 10080, resetsAt: null },
      credits: null,
      resetCreditsAvailable: 2,
      capturedAt: Date.now(),
      ...overrides,
    };
  }

  it('renders the fresh endpoint read without the stale marker', async () => {
    const { host, mountEditorReplacement, fetchCodexUsage } = makeHost({
      chatGptState: 'logged-in',
      chatGptEmail: 'user@example.com',
      sessionUsage: {
        byModel: {},
        rateLimit: {
          planType: 'plus',
          activeLimit: null,
          primary: { usedPercent: 90, windowMinutes: 300, resetsAt: null },
          secondary: null,
          credits: null,
          capturedAt: Date.now() - 30 * 60_000,
        },
      },
    });
    fetchCodexUsage.mockResolvedValue(freshCodexUsage());

    await showStatusPanel(host as never, 'chatgpt');
    await flush();

    expect(fetchCodexUsage).toHaveBeenCalledWith(CHATGPT_PROVIDER);
    const output = renderedLines(mountEditorReplacement).join('\n');
    expect(output).toContain('Plan:');
    expect(output).toContain('Pro');
    expect(output).toContain('58% left');
    expect(output).toContain('95% left');
    expect(output).toContain('Captured just now');
    expect(output).not.toContain('(stale)');
    expect(output).toContain('Usage limit resets: 2 available');
    // The stale header value is replaced, not merged.
    expect(output).not.toContain('10% left');
  });

  it('keeps the stale header snapshot when the endpoint read fails', async () => {
    // makeHost's default fetchCodexUsage rejects — the fallback path.
    const { host, mountEditorReplacement } = makeHost({
      chatGptState: 'logged-in',
      chatGptEmail: 'user@example.com',
      sessionUsage: {
        byModel: {},
        rateLimit: {
          planType: 'plus',
          activeLimit: null,
          primary: { usedPercent: 90, windowMinutes: 300, resetsAt: null },
          secondary: null,
          credits: null,
          capturedAt: Date.now() - 30 * 60_000,
        },
      },
    });

    await showStatusPanel(host as never, 'chatgpt');
    await flush();

    const output = renderedLines(mountEditorReplacement).join('\n');
    expect(output).toContain('10% left');
    expect(output).toContain('(stale)');
    expect(output).toContain('Usage limit resets: see chatgpt.com/codex/settings/usage');
  });

  it('does not fetch codex usage when the ChatGPT account is logged out', async () => {
    const { host, fetchCodexUsage } = makeHost({ chatGptState: 'not-logged-in' });

    await showStatusPanel(host as never, 'chatgpt');
    await flush();

    expect(fetchCodexUsage).not.toHaveBeenCalled();
  });

  it('holds the plan-usage placeholder while the endpoint read is in flight', async () => {
    const { host, mountEditorReplacement, fetchCodexUsage } = makeHost({
      chatGptState: 'logged-in',
      chatGptEmail: 'user@example.com',
    });
    const gate = deferred<Record<string, unknown>>();
    fetchCodexUsage.mockReturnValue(gate.promise);

    await showStatusPanel(host as never, 'chatgpt');
    await flush();

    const dialog = mountedDialog(mountEditorReplacement);
    const pending = strip(dialog.render(120).join('\n'));
    expect(pending).toContain('loading…');
    expect(pending).not.toContain('No rate limit data yet.');

    gate.resolve(freshCodexUsage());
    await flush();
    const settled = strip(dialog.render(120).join('\n'));
    expect(settled).toContain('58% left');
    expect(settled).not.toContain('loading…');
  });

  it('memoizes the codex usage read for a minute, failures excluded', async () => {
    vi.useFakeTimers();
    try {
      const { host, fetchCodexUsage } = makeHost({ chatGptState: 'logged-in' });
      fetchCodexUsage.mockResolvedValue(freshCodexUsage());

      await showStatusReport(host as never);
      await flush();
      expect(fetchCodexUsage).toHaveBeenCalledTimes(1);

      // Reopening within the TTL shares the same read.
      await showStatusReport(host as never);
      await flush();
      expect(fetchCodexUsage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(61_000);
      await showStatusReport(host as never);
      await flush();
      expect(fetchCodexUsage).toHaveBeenCalledTimes(2);

      // A failure is not cached: the next open retries immediately.
      fetchCodexUsage.mockRejectedValue(new Error('boom'));
      await vi.advanceTimersByTimeAsync(61_000);
      await showStatusReport(host as never);
      await flush();
      expect(fetchCodexUsage).toHaveBeenCalledTimes(3);
      await showStatusReport(host as never);
      await flush();
      expect(fetchCodexUsage).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('/status async mounting', () => {
  it('mounts instantly: instant fields render while async sections show placeholders', async () => {
    const { host, mountEditorReplacement } = makeHost({});

    // The dialog mounts synchronously within the command call — before any of
    // the data-source promises can resolve.
    const done = showStatusReport(host as never);
    const initial = renderedLines(mountEditorReplacement).join('\n');
    expect(initial).toContain('>_ Cloud Code CLI (v0.0.0-test)');
    expect(initial).toContain('My session');
    expect(initial).toContain('loading…');
    await done;

    await flush();
    const dialog = mountedDialog(mountEditorReplacement);
    const settled = strip(dialog.render(120).join('\n'));
    expect(settled).not.toContain('loading…');
    dialog.handleInput('\t'); // Status → Kimi Code
    expect(strip(dialog.render(120).join('\n'))).toContain('Logged in');
  });

  it('takes keys and clicks on frame one, before any data lands', async () => {
    const { host, mountEditorReplacement, restoreEditor } = makeHost({});

    // No flush: every data source is still in flight (the account snapshots,
    // the usage reads, and the wire-log walk), yet the dialog must already
    // answer keyboard and mouse input.
    const done = showStatusReport(host as never);
    const dialog = mountedDialog(mountEditorReplacement) as ReturnType<
      typeof mountedDialog
    > & {
      hitZones(): Iterable<{ id: unknown }>;
      onHitZone(id: unknown, event: unknown): void | boolean;
    };

    dialog.handleInput('\t'); // Status → Kimi Code
    expect(strip(dialog.render(120).join('\n'))).toContain('loading…');

    // The tab cells are hit zones from the first render — clicks land.
    const zoneIds = [...dialog.hitZones()].map((zone) => zone.id);
    expect(zoneIds).toContain('tab:2');
    dialog.onHitZone('tab:2', {});
    expect(strip(dialog.render(120).join('\n'))).toContain('loading…');

    // Esc closes immediately instead of waiting for the loads.
    dialog.handleInput('');
    expect(restoreEditor).toHaveBeenCalledTimes(1);

    await done;
    // The late loads settle against the closed dialog without throwing.
    await flush();
  });

  it('a slow managed-usage call delays only its own section', async () => {
    const { host, mountEditorReplacement, getManagedUsage } = makeHost({ kimiState: 'logged-in' });
    const slow = deferred<never>();
    getManagedUsage.mockReturnValue(slow.promise);

    await showStatusPanel(host as never, 'kimi');
    await flush();

    // The account snapshot is fully resolved…
    const dialog = mountedDialog(mountEditorReplacement);
    const kimiTab = strip(dialog.render(120).join('\n'));
    expect(kimiTab).toContain('Account:');
    expect(kimiTab).toContain('Logged in');
    // …while the Kimi plan-usage block is still loading.
    expect(kimiTab).toContain('loading…');

    // Switching to the Status tab shows the resolved global rows.
    dialog.handleInput('\t'); // Kimi Code → ChatGPT
    dialog.handleInput('\t'); // ChatGPT → Stats
    dialog.handleInput('\t'); // Stats → Status
    const statusTab = strip(dialog.render(120).join('\n'));
    expect(statusTab).toContain('My session');
    expect(statusTab).not.toContain('loading…');

    slow.reject(new Error('unblock'));
    await flush();
  });

  it('resolves sections independently: account state lands while stats stay pending', async () => {
    const { host, mountEditorReplacement } = makeHost({});
    const statsGate = deferred<{
      totalTokens: number;
      activeDays: number;
      mostActiveDay: undefined;
      favoriteModel: undefined;
      sessionCount: number;
      longestSessionMs: undefined;
    }>();
    vi.mocked(loadTokenActivityStats).mockReturnValueOnce(statsGate.promise);

    await showStatusReport(host as never, 'stats');
    await flush();

    const dialog = mountedDialog(mountEditorReplacement);
    const statsTab = strip(dialog.render(120).join('\n'));
    // Stats facts still pending → placeholder; the Status tab is unaffected.
    expect(statsTab).toContain('loading…');
    dialog.handleInput('\t'); // Stats → Status
    const statusTab = strip(dialog.render(120).join('\n'));
    expect(statusTab).toContain('My session');
    expect(statusTab).not.toContain('loading…');

    statsGate.resolve({
      totalTokens: 0,
      activeDays: 0,
      mostActiveDay: undefined,
      favoriteModel: undefined,
      sessionCount: 0,
      longestSessionMs: undefined,
    });
    await flush();
    dialog.handleInput('\t'); // Status → Kimi Code
    dialog.handleInput('\t'); // Kimi Code → ChatGPT
    dialog.handleInput('\t'); // ChatGPT → Stats
    const settled = strip(dialog.render(120).join('\n'));
    expect(settled).toContain('No activity yet');
  });

  it('keeps the active tab when late data repaints the dialog', async () => {
    const { host, mountEditorReplacement, getManagedUsage } = makeHost({ kimiState: 'logged-in' });
    const slow = deferred<never>();
    getManagedUsage.mockReturnValue(slow.promise);

    await showStatusReport(host as never);
    await flush();

    const dialog = mountedDialog(mountEditorReplacement);
    dialog.handleInput('\t'); // Status → Kimi Code
    dialog.handleInput('\t'); // Kimi Code → ChatGPT
    dialog.handleInput('\t'); // ChatGPT → Stats
    slow.reject(new Error('unblock'));
    await flush();

    // Still on the Stats tab after the managed-usage failure landed.
    expect(strip(dialog.render(120).join('\n'))).toContain('No activity yet');
  });
});

describe('/status data memos', () => {
  it('reuses the token-activity reads within the TTL and reloads after it', async () => {
    vi.useFakeTimers();
    try {
      const { host } = makeHost({});

      await showStatusReport(host as never);
      await flush();
      expect(vi.mocked(loadTokenActivity)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(loadTokenActivityStats)).toHaveBeenCalledTimes(1);

      // Reopening within the TTL shares the same reads.
      await showStatusReport(host as never);
      await flush();
      expect(vi.mocked(loadTokenActivity)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(loadTokenActivityStats)).toHaveBeenCalledTimes(1);

      // After the TTL the next open re-walks the wire logs.
      await vi.advanceTimersByTimeAsync(3_100);
      await showStatusReport(host as never);
      await flush();
      expect(vi.mocked(loadTokenActivity)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(loadTokenActivityStats)).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('memoizes managed usage per provider for a minute, errors excluded', async () => {
    vi.useFakeTimers();
    try {
      const { host, getManagedUsage } = makeHost({ kimiState: 'logged-in' });

      await showStatusReport(host as never);
      await flush();
      expect(getManagedUsage).toHaveBeenCalledTimes(1);

      await showStatusReport(host as never);
      await flush();
      expect(getManagedUsage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(61_000);
      await showStatusReport(host as never);
      await flush();
      expect(getManagedUsage).toHaveBeenCalledTimes(2);

      // A failure is not cached: the next open retries immediately.
      getManagedUsage.mockResolvedValue({ kind: 'error', message: 'boom' });
      await vi.advanceTimersByTimeAsync(61_000);
      await showStatusReport(host as never);
      await flush();
      expect(getManagedUsage).toHaveBeenCalledTimes(3);
      await showStatusReport(host as never);
      await flush();
      expect(getManagedUsage).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('/status ChatGPT reset-credit redeem flow', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  const CREDIT = {
    id: 'credit-1',
    resetType: 'codex_rate_limits',
    status: 'available',
    title: 'Full reset',
    description: 'Reset your current usage limits.',
    expiresAt: null,
  };

  function makeRedeemHost(consumeResult?: { code: string }) {
    const made = makeHost({
      chatGptState: 'logged-in',
      chatGptEmail: 'user@example.com',
    });
    made.fetchCodexUsage.mockResolvedValue({
      planType: 'pro',
      primary: { usedPercent: 42, windowMinutes: 300, resetsAt: null },
      secondary: null,
      credits: null,
      resetCreditsAvailable: 2,
      capturedAt: Date.now(),
    });
    made.listCodexResetCredits.mockResolvedValue({ availableCount: 2, credits: [CREDIT] });
    if (consumeResult !== undefined) {
      made.consumeCodexResetCredit.mockResolvedValue(consumeResult);
    }
    return made;
  }

  it('arms the confirm with r and consumes one credit with y (uuid per attempt)', async () => {
    const { host, mountEditorReplacement, fetchCodexUsage, listCodexResetCredits, consumeCodexResetCredit } =
      makeRedeemHost();

    await showStatusPanel(host as never, 'chatgpt');
    await flush();
    expect(fetchCodexUsage).toHaveBeenCalledTimes(1);

    const dialog = mountedDialog(mountEditorReplacement);
    expect(strip(dialog.render(120).join('\n'))).toContain(
      'Usage limit resets: 2 available · press R to redeem one',
    );

    dialog.handleInput('r');
    await flush();
    expect(listCodexResetCredits).toHaveBeenCalledWith(CHATGPT_PROVIDER);
    expect(strip(dialog.render(120).join('\n'))).toContain(
      'Redeem 1 of 2 usage limit resets? [y/N]',
    );

    dialog.handleInput('y');
    await flush();

    expect(consumeCodexResetCredit).toHaveBeenCalledTimes(1);
    const [redeemRequestId, creditId, provider] = consumeCodexResetCredit.mock.calls[0]!;
    expect(redeemRequestId).toMatch(UUID_RE);
    expect(creditId).toBe('credit-1');
    expect(provider).toBe(CHATGPT_PROVIDER);

    // The success busted the usage memo and refetched the fresh quota.
    expect(fetchCodexUsage).toHaveBeenCalledTimes(2);
    const out = strip(dialog.render(120).join('\n'));
    expect(out).toContain('Usage limit reset — refreshing your quota…');
    expect(out).toContain('Usage limit resets: 2 available');
  });

  it('mints a fresh redeem_request_id for every confirmed attempt', async () => {
    const { host, mountEditorReplacement, consumeCodexResetCredit } = makeRedeemHost();

    await showStatusPanel(host as never, 'chatgpt');
    await flush();
    const dialog = mountedDialog(mountEditorReplacement);

    dialog.handleInput('r');
    await flush();
    dialog.handleInput('y');
    await flush();
    dialog.handleInput('r');
    await flush();
    dialog.handleInput('y');
    await flush();

    expect(consumeCodexResetCredit).toHaveBeenCalledTimes(2);
    const first = consumeCodexResetCredit.mock.calls[0]![0] as string;
    const second = consumeCodexResetCredit.mock.calls[1]![0] as string;
    expect(first).toMatch(UUID_RE);
    expect(second).toMatch(UUID_RE);
    expect(second).not.toBe(first);
  });

  it('keeps the memo and shows an error notice when the consume fails', async () => {
    const { host, mountEditorReplacement, fetchCodexUsage, consumeCodexResetCredit } =
      makeRedeemHost();
    consumeCodexResetCredit.mockRejectedValue(new Error('endpoint unreachable'));

    await showStatusPanel(host as never, 'chatgpt');
    await flush();
    const dialog = mountedDialog(mountEditorReplacement);

    dialog.handleInput('r');
    await flush();
    dialog.handleInput('y');
    await flush();

    const out = strip(dialog.render(120).join('\n'));
    expect(out).toContain('Could not redeem a usage limit reset: endpoint unreachable');
    expect(out).toContain('Usage limit resets: 2 available');
    expect(fetchCodexUsage).toHaveBeenCalledTimes(1);
  });

  it('disarms with n without consuming', async () => {
    const { host, mountEditorReplacement, consumeCodexResetCredit } = makeRedeemHost();

    await showStatusPanel(host as never, 'chatgpt');
    await flush();
    const dialog = mountedDialog(mountEditorReplacement);

    dialog.handleInput('r');
    await flush();
    dialog.handleInput('n');

    expect(strip(dialog.render(120).join('\n'))).toContain('Usage limit resets: 2 available');
    expect(consumeCodexResetCredit).not.toHaveBeenCalled();
  });
});

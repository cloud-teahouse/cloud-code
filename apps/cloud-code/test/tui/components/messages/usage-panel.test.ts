import { visibleWidth } from '@cloud-code/pi-tui';
import { parseCodexPlanUsagePayload, type CodexPlanUsage } from '@cloud-code/oauth';
import type { ModelAlias, RateLimitSnapshot } from '@cloud-code/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildChatGptAccountTabLines,
  buildKimiAccountTabLines,
  partitionSessionUsageByProvider,
  UsagePanelComponent,
  type ChatGptAccountTabOptions,
  type KimiAccountTabOptions,
  type StatusTabAccount,
} from '#/tui/components/messages/usage-panel';
import { setLocalePreference } from '#/tui/i18n';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';

beforeEach(() => {
  // Freeze the clock so resetAt-derived hints render exact durations.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-28T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  currentTheme.setPalette(darkColors);
  setLocalePreference('en');
});

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

const KIMI_PROVIDER = 'managed:kimi-code';
const CHATGPT_PROVIDER = 'managed:chatgpt-codex';

const AVAILABLE_MODELS: Record<string, ModelAlias> = {
  'kimi-for-coding': { provider: KIMI_PROVIDER, model: 'kimi-k2', maxContextSize: 200000, displayName: 'Kimi for Coding' },
  'gpt-5-codex': { provider: CHATGPT_PROVIDER, model: 'gpt-5-codex', maxContextSize: 272000, displayName: 'GPT-5 Codex' },
  'local-model': { provider: 'openai', model: 'local-model', maxContextSize: 128000 },
};

const LOGGED_IN_KIMI: StatusTabAccount = { state: 'logged-in' };
const LOGGED_IN_CHATGPT: StatusTabAccount = {
  state: 'logged-in',
  email: 'user@example.com',
  planType: 'plus',
};

function kimiArgs(overrides: Partial<KimiAccountTabOptions> = {}): KimiAccountTabOptions {
  return {
    account: LOGGED_IN_KIMI,
    availableModels: AVAILABLE_MODELS,
    sessionUsage: {
      byModel: {
        'kimi-k2': { inputOther: 1000, inputCacheRead: 500, inputCacheCreation: 500, output: 250 },
      },
    },
    ...overrides,
  };
}

describe('buildKimiAccountTabLines', () => {
  it('renders the account row, managed limits 5h-above-weekly, and kimi session usage', () => {
    const lines = buildKimiAccountTabLines(
      kimiArgs({
        managedUsage: {
          summary: {
            window: { duration: 1, unit: 'week' },
            used: 80,
            limit: 100,
            resetAt: new Date(Date.now() + (3 * 24 * 3600 + 4 * 3600) * 1000).toISOString(),
          },
          limits: [
            {
              window: { duration: 5, unit: 'hour' },
              used: 20,
              limit: 100,
              resetAt: new Date(Date.now() + (2 * 3600 + 14 * 60) * 1000).toISOString(),
            },
          ],
        },
      }),
    ).map(strip);
    const output = lines.join('\n');

    expect(output).toContain('Account:');
    expect(output).toContain('Logged in');
    // codex row grammar: colon labels, remaining-filled bars, NN% left.
    const fiveHour = lines.find((line) => line.includes('5h limit:'));
    const weekly = lines.find((line) => line.includes('Weekly limit:'));
    expect(fiveHour).toBeDefined();
    expect(weekly).toBeDefined();
    expect(lines.indexOf(fiveHour!)).toBeLessThan(lines.indexOf(weekly!));
    expect(fiveHour).toContain('80% left');
    expect(fiveHour).toContain('█'.repeat(16) + '░'.repeat(4));
    expect(fiveHour).toContain('resets in 2 h 14 m');
    expect(weekly).toContain('20% left');
    expect(weekly).toContain('█'.repeat(4) + '░'.repeat(16));
    expect(weekly).toContain('resets in 3 d 4 h');
    // Session usage for kimi models only.
    expect(output).toContain('Session usage');
    expect(output).toContain('kimi-k2');
    expect(output).toContain('input 2k  output 250  total 2.2k');
  });

  it('never fabricates a kimi email — tokens carry no account claims', () => {
    const output = buildKimiAccountTabLines(kimiArgs()).map(strip).join('\n');
    expect(output).not.toContain('@');
  });

  it('shows the /login prompt when logged out', () => {
    const output = buildKimiAccountTabLines(kimiArgs({ account: { state: 'not-logged-in' } }))
      .map(strip)
      .join('\n');
    expect(output).toContain('Not logged in — run /login to see Kimi plan usage.');
    expect(output).not.toContain('Weekly limit');
    expect(output).not.toContain('Session usage');
  });

  it('marks an expired login with /login guidance', () => {
    const output = buildKimiAccountTabLines(kimiArgs({ account: { state: 'expired' } }))
      .map(strip)
      .join('\n');
    expect(output).toContain('Login expired — run /login');
  });

  it('shows a placeholder while the account snapshot loads', () => {
    const output = buildKimiAccountTabLines(kimiArgs({ account: undefined }))
      .map(strip)
      .join('\n');
    expect(output).toContain('loading…');
  });

  it('shows the managed-usage error text once the endpoint call fails', () => {
    const output = buildKimiAccountTabLines(
      kimiArgs({ managedUsageError: 'usage endpoint exploded' }),
    )
      .map(strip)
      .join('\n');
    expect(output).toContain('usage endpoint exploded');
  });

  it('shows a loading line while managed usage is in flight', () => {
    const output = buildKimiAccountTabLines(kimiArgs({ managedUsageLoading: true }))
      .map(strip)
      .join('\n');
    expect(output).toContain('loading…');
  });

  it('formats extra usage with a monthly limit', () => {
    const lines = buildKimiAccountTabLines(
      kimiArgs({
        sessionUsage: { byModel: {} },
        managedUsage: {
          summary: null,
          limits: [],
          extraUsage: {
            balanceCents: 10000,
            totalCents: 20000,
            monthlyChargeLimitEnabled: true,
            monthlyChargeLimitCents: 20000,
            monthlyUsedCents: 5000,
            currency: 'USD',
          },
        },
      }),
    ).map(strip);

    const output = lines.join('\n');
    expect(lines).toContain('Extra Usage');
    expect(output).toContain('Balance');
    expect(output).toContain('100.00');
    expect(output).toContain('Used this month');
    expect(output).toContain('50.00');
    expect(output).toContain('Monthly limit');
    expect(output).toContain('200.00');
    // bar row contains block glyphs but no percentage text
    expect(output).toContain('░');
  });

  it('formats extra usage without a monthly limit and omits the progress bar', () => {
    const lines = buildKimiAccountTabLines(
      kimiArgs({
        sessionUsage: { byModel: {} },
        managedUsage: {
          summary: null,
          limits: [],
          extraUsage: {
            balanceCents: 18208,
            totalCents: 40000,
            monthlyChargeLimitEnabled: false,
            monthlyChargeLimitCents: 0,
            monthlyUsedCents: 21792,
            currency: 'CNY',
          },
        },
      }),
    ).map(strip);

    const output = lines.join('\n');
    expect(lines).toContain('Extra Usage');
    expect(output).toContain('Balance');
    expect(output).toContain('¥182.08');
    expect(output).toContain('Used this month');
    expect(output).toContain('¥217.92');
    expect(output).toContain('Monthly limit');
    expect(output).toContain('Unlimited');
    expect(output).not.toContain('░');
    expect(output).not.toContain('█');
  });

  it('omits the extra usage section when extraUsage is omitted or null', () => {
    for (const extraUsage of [undefined, null]) {
      const lines = buildKimiAccountTabLines(
        kimiArgs({
          sessionUsage: { byModel: {} },
          managedUsage: { summary: null, limits: [], extraUsage },
        }),
      ).map(strip);

      expect(lines).not.toContain('Extra Usage');
    }
  });

  it('aligns the currency symbol and decimal point across extra usage rows', () => {
    const lines = buildKimiAccountTabLines(
      kimiArgs({
        sessionUsage: { byModel: {} },
        managedUsage: {
          summary: null,
          limits: [],
          extraUsage: {
            balanceCents: 15901,
            totalCents: 300000,
            monthlyChargeLimitEnabled: true,
            monthlyChargeLimitCents: 300000,
            monthlyUsedCents: 24099,
            currency: 'CNY',
          },
        },
      }),
    ).map(strip);

    const extraRows = lines.filter((line) => line.includes('¥'));
    expect(extraRows).toHaveLength(3);
    // The currency symbol stays in one column...
    expect(new Set(extraRows.map((line) => line.indexOf('¥'))).size).toBe(1);
    // ...and the right-aligned numeric parts end in the same column, so the
    // decimal points line up across rows.
    expect(new Set(extraRows.map((line) => line.length)).size).toBe(1);
  });

  it('names session models that cannot be attributed to either account', () => {
    const output = buildKimiAccountTabLines(
      kimiArgs({
        sessionUsage: {
          byModel: {
            'kimi-k2': { inputOther: 1000, inputCacheRead: 0, inputCacheCreation: 0, output: 100 },
            'local-model': { inputOther: 500, inputCacheRead: 0, inputCacheCreation: 0, output: 50 },
          },
        },
      }),
    )
      .map(strip)
      .join('\n');

    expect(output).toContain('kimi-k2');
    expect(output).not.toMatch(/ {2}local-model {2}/);
    expect(output).toContain('Not shown: local-model');
  });

  it('reports an empty per-provider session block honestly', () => {
    const output = buildKimiAccountTabLines(kimiArgs({ sessionUsage: { byModel: {} } }))
      .map(strip)
      .join('\n');
    expect(output).toContain('No Kimi model usage this session.');
  });

  it('renders zh-CN copy', () => {
    setLocalePreference('zh-CN');
    const output = buildKimiAccountTabLines(
      kimiArgs({
        account: { state: 'logged-in' },
        sessionUsage: { byModel: {} },
        managedUsage: {
          summary: {
            window: { duration: 1, unit: 'week' },
            used: 80,
            limit: 100,
            resetAt: new Date(Date.now() + (3 * 24 * 3600 + 4 * 3600) * 1000).toISOString(),
          },
          limits: [
            {
              window: { duration: 5, unit: 'hour' },
              used: 20,
              limit: 100,
              resetAt: new Date(Date.now() + (2 * 3600 + 14 * 60) * 1000).toISOString(),
            },
          ],
        },
      }),
    )
      .map(strip)
      .join('\n');

    expect(output).toContain('账号:');
    expect(output).toContain('已登录');
    expect(output).toContain('5 小时限额:');
    expect(output).toContain('每周限额:');
    expect(output).toContain('剩余 80%');
    expect(output).toContain('剩余 20%');
    expect(output).toContain('3 天 4 小时后重置');
    expect(output).toContain('本会话暂无 Kimi 模型用量。');
  });

  it('renders the login prompt in zh-CN', () => {
    setLocalePreference('zh-CN');
    const output = buildKimiAccountTabLines(kimiArgs({ account: { state: 'not-logged-in' } }))
      .map(strip)
      .join('\n');
    expect(output).toContain('未登录 — 运行 /login 查看 Kimi 套餐用量。');
  });
});

// ---------------------------------------------------------------------------
// ChatGPT tab (codex card grammar)
// ---------------------------------------------------------------------------

/** 24 Jul 2026 10:00 local — fixed clock for stale/reset/captured tests. */
const NOW = new Date(2026, 6, 24, 10, 0, 0).getTime();

function codexSnapshot(overrides: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot {
  return {
    planType: 'plus',
    activeLimit: 'premium',
    primary: {
      usedPercent: 74,
      windowMinutes: 300,
      resetsAt: new Date(2026, 6, 24, 15, 25, 0).getTime() / 1000,
    },
    secondary: {
      usedPercent: 26,
      windowMinutes: 10080,
      resetsAt: new Date(2026, 7, 3, 9, 55, 0).getTime() / 1000,
    },
    credits: { hasCredits: true, unlimited: false, balance: '25' },
    capturedAt: NOW - 3 * 60_000,
    ...overrides,
  };
}

function chatGptArgs(overrides: Partial<ChatGptAccountTabOptions> = {}): ChatGptAccountTabOptions {
  return {
    account: LOGGED_IN_CHATGPT,
    availableModels: AVAILABLE_MODELS,
    sessionUsage: {
      byModel: {
        'gpt-5-codex': { inputOther: 1000, inputCacheRead: 0, inputCacheCreation: 0, output: 100 },
      },
    },
    rateLimit: codexSnapshot(),
    now: NOW,
    ...overrides,
  };
}

/**
 * Fresh `/wham/usage` payload (as parsed by packages/oauth), captured
 * exactly at NOW so the card reads "Captured just now".
 */
function codexUsage(overrides: Partial<CodexPlanUsage> = {}): CodexPlanUsage {
  return {
    planType: 'pro',
    primary: {
      usedPercent: 42,
      windowMinutes: 300,
      resetsAt: new Date(2026, 6, 24, 14, 30, 0).getTime() / 1000,
    },
    secondary: {
      usedPercent: 5,
      windowMinutes: 10080,
      resetsAt: new Date(2026, 6, 30, 10, 0, 0).getTime() / 1000,
    },
    credits: null,
    resetCreditsAvailable: 3,
    capturedAt: NOW,
    ...overrides,
  };
}

describe('buildChatGptAccountTabLines', () => {
  it('renders the codex card: account, plan, window bars, credits, capture, session', () => {
    const lines = buildChatGptAccountTabLines(chatGptArgs()).map(strip);
    const output = lines.join('\n');

    expect(output).not.toContain('Model:');
    expect(output).toContain('Account:');
    expect(output).toContain('user@example.com (Plus)');
    expect(output).toContain('Plan:');
    expect(output).toContain('Plus (premium)');
    expect(output).toContain('5h limit:');
    expect(output).toContain('Weekly limit:');
    expect(output).toContain('26% left');
    expect(output).toContain('74% left');
    expect(output).toContain('(resets 15:25)');
    expect(output).toContain('(resets 09:55 on 3 Aug)');
    expect(output).toContain('Credits:');
    expect(output).toContain('25 credits');
    expect(output).toContain('Captured 3 min ago');
    expect(output).toContain('Usage limit resets: see chatgpt.com/codex/settings/usage');
    expect(output).toContain('Session usage');
    expect(output).toContain('gpt-5-codex');
  });

  it('aligns every row value to one column past the widest label (codex FieldFormatter)', () => {
    const lines = buildChatGptAccountTabLines(chatGptArgs()).map(strip);
    const rows = lines.filter((line) => /^ {2}\S.*:\s/.test(line) && !line.includes('resets: see'));
    const valueColumns = new Set(
      rows.map((line) => {
        const colon = line.indexOf(':');
        const valueStart = colon + 1 + line.slice(colon + 1).search(/\S/);
        return valueStart;
      }),
    );
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(valueColumns.size).toBe(1);
  });

  it('fills window bars by remaining percent', () => {
    const lines = buildChatGptAccountTabLines(chatGptArgs()).map(strip);
    const fiveHourRow = lines.find((line) => line.includes('5h limit'));
    const weeklyRow = lines.find((line) => line.includes('Weekly limit'));

    // 74% used → 26% left → 5 filled cells; 26% used → 74% left → 15 filled.
    expect(fiveHourRow).toContain('█████' + '░'.repeat(15));
    expect(weeklyRow).toContain('█'.repeat(15) + '░'.repeat(5));
  });

  it('marks snapshots older than 15 minutes as stale', () => {
    const lines = buildChatGptAccountTabLines(
      chatGptArgs({ rateLimit: codexSnapshot({ capturedAt: NOW - 16 * 60_000 }) }),
    ).map(strip);

    expect(lines.join('\n')).toContain('Captured 16 min ago (stale)');
  });

  it('renders fresh endpoint values with no stale marker and the real reset-credit count', () => {
    const lines = buildChatGptAccountTabLines(
      chatGptArgs({
        // A stale header snapshot stays on file — the fresh read must win.
        rateLimit: codexSnapshot({ capturedAt: NOW - 16 * 60_000 }),
        codexUsage: codexUsage(),
      }),
    ).map(strip);
    const output = lines.join('\n');

    expect(output).toContain('Plan:');
    expect(output).toContain('Pro');
    expect(output).toContain('5h limit:');
    expect(output).toContain('58% left');
    expect(output).toContain('Weekly limit:');
    expect(output).toContain('95% left');
    expect(output).toContain('(resets 14:30)');
    expect(output).toContain('(resets 10:00 on 30 Jul)');
    expect(output).toContain('Captured just now');
    expect(output).not.toContain('(stale)');
    expect(output).toContain('Usage limit resets: 3 available');
    expect(output).not.toContain('chatgpt.com/codex/settings/usage');
    // The header-snapshot values are replaced, not merged.
    expect(output).not.toContain('74% left');
  });

  it('maps the real wham payload end-to-end: window labels, reset times, applicable count', () => {
    // The verified `/wham/usage` 200 shape, parsed by packages/oauth and
    // rendered raw: seconds → window labels, reset_at / reset_after_seconds →
    // reset hints, applicable_available_count → the redeem row.
    const payload = {
      user_id: 'user-abc123',
      account_id: 'acct-def456',
      email: 'user@example.com',
      plan_type: 'plus',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 42,
          limit_window_seconds: 18_000,
          // No reset_at: the hint derives from the relative field (+4.5h).
          reset_after_seconds: 16_200,
        },
        secondary_window: {
          used_percent: 5,
          limit_window_seconds: 604_800,
          reset_after_seconds: 43_200,
          reset_at: new Date(2026, 6, 30, 10, 0, 0).getTime() / 1000,
        },
      },
      credits: {
        has_credits: true,
        unlimited: false,
        overage_limit_reached: false,
        balance: 25,
        approx_local_messages: 500,
        approx_cloud_messages: 250,
      },
      spend_control: { reached: false, individual_limit: null },
      rate_limit_reset_credits: { available_count: 3, applicable_available_count: 2 },
    };
    const lines = buildChatGptAccountTabLines(
      chatGptArgs({ codexUsage: parseCodexPlanUsagePayload(payload, NOW) }),
    ).map(strip);
    const output = lines.join('\n');

    expect(output).toContain('Plan:');
    expect(output).toContain('Plus');
    expect(output).toContain('5h limit:');
    expect(output).toContain('58% left');
    expect(output).toContain('(resets 14:30)');
    expect(output).toContain('Weekly limit:');
    expect(output).toContain('95% left');
    expect(output).toContain('(resets 10:00 on 30 Jul)');
    expect(output).toContain('Credits:');
    expect(output).toContain('25 credits');
    expect(output).toContain('Usage limit resets: 2 available');
    expect(output).toContain('Captured just now');
  });

  it('renders the redeem flow in zh-CN', () => {
    setLocalePreference('zh-CN');
    const idle = buildChatGptAccountTabLines(
      chatGptArgs({
        codexUsage: codexUsage({ resetCreditsAvailable: 2 }),
        redeem: { offered: true, phase: 'idle', count: 2 },
      }),
    )
      .map(strip)
      .join('\n');
    expect(idle).toContain('按 R 使用一次');

    const confirm = buildChatGptAccountTabLines(
      chatGptArgs({
        codexUsage: codexUsage({ resetCreditsAvailable: 2 }),
        redeem: { offered: true, phase: 'confirm', count: 2 },
      }),
    )
      .map(strip)
      .join('\n');
    expect(confirm).toContain('使用 1 次用量重置（共 2 次）？[y/N]');
  });

  it('names zero available reset credits honestly', () => {
    const output = buildChatGptAccountTabLines(
      chatGptArgs({ codexUsage: codexUsage({ resetCreditsAvailable: 0 }) }),
    )
      .map(strip)
      .join('\n');
    expect(output).toContain('Usage limit resets: none available');
    expect(output).not.toContain('chatgpt.com/codex/settings/usage');
  });

  it('keeps the settings-page note when the fresh payload omits the reset-credit summary', () => {
    const output = buildChatGptAccountTabLines(
      chatGptArgs({ codexUsage: codexUsage({ resetCreditsAvailable: null }) }),
    )
      .map(strip)
      .join('\n');
    expect(output).toContain('Captured just now');
    expect(output).toContain('Usage limit resets: see chatgpt.com/codex/settings/usage');
  });

  it('keeps the stale header snapshot untouched when the endpoint read failed', () => {
    const output = buildChatGptAccountTabLines(
      chatGptArgs({
        rateLimit: codexSnapshot({ capturedAt: NOW - 16 * 60_000 }),
        codexUsage: null,
        codexUsageLoading: false,
      }),
    )
      .map(strip)
      .join('\n');
    expect(output).toContain('Captured 16 min ago (stale)');
    expect(output).toContain('Usage limit resets: see chatgpt.com/codex/settings/usage');
  });

  it('treats an all-empty endpoint payload as no fresh data', () => {
    const output = buildChatGptAccountTabLines(
      chatGptArgs({
        rateLimit: codexSnapshot({ capturedAt: NOW - 16 * 60_000 }),
        codexUsage: codexUsage({
          planType: null,
          primary: null,
          secondary: null,
          credits: null,
          resetCreditsAvailable: null,
        }),
      }),
    )
      .map(strip)
      .join('\n');
    // The header snapshot renders instead of a hollow fresh card.
    expect(output).toContain('74% left');
    expect(output).toContain('Captured 16 min ago (stale)');
  });

  it('holds the loading placeholder while the endpoint read is in flight', () => {
    const output = buildChatGptAccountTabLines(
      chatGptArgs({ rateLimit: null, codexUsageLoading: true }),
    )
      .map(strip)
      .join('\n');
    expect(output).toContain('loading…');
    expect(output).not.toContain('No rate limit data yet.');
  });

  it('renders the fresh reset-credit count in zh-CN', () => {
    setLocalePreference('zh-CN');
    const output = buildChatGptAccountTabLines(chatGptArgs({ codexUsage: codexUsage() }))
      .map(strip)
      .join('\n');
    expect(output).toContain('刚刚捕获');
    expect(output).not.toContain('(已过期)');
    expect(output).toContain('用量重置机会：3 次可用');
  });

  it('shows an honest placeholder when no snapshot has been captured', () => {
    const lines = buildChatGptAccountTabLines(chatGptArgs({ rateLimit: null })).map(strip);

    expect(lines.join('\n')).toContain('No rate limit data yet.');
    expect(lines.join('\n')).not.toContain('% left');
  });

  it('shows a bare Logged in for tokens without id_token claims on file', () => {
    const output = buildChatGptAccountTabLines(chatGptArgs({ account: { state: 'logged-in' } }))
      .map(strip)
      .join('\n');
    expect(output).toContain('Account:');
    expect(output).toContain('Logged in');
    expect(output).not.toContain('@');
  });

  it('renders unlimited credits and hides the row when the account has none', () => {
    const unlimited = buildChatGptAccountTabLines(
      chatGptArgs({
        rateLimit: codexSnapshot({
          credits: { hasCredits: true, unlimited: true, balance: null },
        }),
      }),
    )
      .map(strip)
      .join('\n');
    expect(unlimited).toContain('Credits');
    expect(unlimited).toContain('Unlimited');

    const noCredits = buildChatGptAccountTabLines(
      chatGptArgs({
        rateLimit: codexSnapshot({
          credits: { hasCredits: false, unlimited: false, balance: null },
        }),
      }),
    )
      .map(strip)
      .join('\n');
    expect(noCredits).not.toContain('Credits');
  });

  it('shows the /login prompt when logged out', () => {
    const output = buildChatGptAccountTabLines(chatGptArgs({ account: { state: 'not-logged-in' } }))
      .map(strip)
      .join('\n');
    expect(output).toContain('Not logged in — run /login to see ChatGPT plan usage.');
    expect(output).not.toContain('Weekly limit');
    expect(output).not.toContain('Session usage');
  });

  it('marks an expired login with /login guidance', () => {
    const output = buildChatGptAccountTabLines(chatGptArgs({ account: { state: 'expired' } }))
      .map(strip)
      .join('\n');
    expect(output).toContain('Login expired — run /login');
  });

  it('attributes session usage to codex models only and names the rest', () => {
    const output = buildChatGptAccountTabLines(
      chatGptArgs({
        sessionUsage: {
          byModel: {
            'kimi-k2': { inputOther: 1000, inputCacheRead: 0, inputCacheCreation: 0, output: 100 },
            'gpt-5-codex': { inputOther: 2000, inputCacheRead: 0, inputCacheCreation: 0, output: 200 },
            'local-model': { inputOther: 500, inputCacheRead: 0, inputCacheCreation: 0, output: 50 },
          },
        },
      }),
    )
      .map(strip)
      .join('\n');

    expect(output).toContain('gpt-5-codex');
    expect(output).not.toMatch(/ {2}kimi-k2 {2}/);
    expect(output).toContain('Not shown: local-model');
  });

  it('renders the section in zh-CN', () => {
    setLocalePreference('zh-CN');
    const lines = buildChatGptAccountTabLines(
      chatGptArgs({ rateLimit: codexSnapshot({ capturedAt: NOW - 16 * 60_000 }) }),
    ).map(strip);
    const output = lines.join('\n');

    expect(output).toContain('5 小时限额');
    expect(output).toContain('每周限额');
    expect(output).toContain('剩余 26%');
    expect(output).toContain('剩余 74%');
    expect(output).toContain('（15:25 重置）');
    expect(output).toContain('（8月3日 09:55 重置）');
    expect(output).toContain('16 分钟前捕获 (已过期)');
    expect(output).toContain('用量重置机会：见 chatgpt.com/codex/settings/usage');
    expect(output).toContain('会话用量');
  });

  it('renders the login prompt in zh-CN', () => {
    setLocalePreference('zh-CN');
    const output = buildChatGptAccountTabLines(chatGptArgs({ account: { state: 'not-logged-in' } }))
      .map(strip)
      .join('\n');
    expect(output).toContain('未登录 — 运行 /login 查看 ChatGPT 套餐用量。');
  });
});

describe('partitionSessionUsageByProvider', () => {
  it('attributes by alias key and resolved model id alike', () => {
    const partition = partitionSessionUsageByProvider(
      {
        'kimi-for-coding': { inputOther: 1, inputCacheRead: 0, inputCacheCreation: 0, output: 1 },
        'gpt-5-codex': { inputOther: 2, inputCacheRead: 0, inputCacheCreation: 0, output: 2 },
        'kimi-k2': { inputOther: 3, inputCacheRead: 0, inputCacheCreation: 0, output: 3 },
        'mystery-model': { inputOther: 4, inputCacheRead: 0, inputCacheCreation: 0, output: 4 },
        'local-model': { inputOther: 5, inputCacheRead: 0, inputCacheCreation: 0, output: 5 },
      },
      AVAILABLE_MODELS,
    );

    expect(partition.kimi.map(([model]) => model).sort()).toEqual(['kimi-for-coding', 'kimi-k2']);
    expect(partition.chatgpt.map(([model]) => model)).toEqual(['gpt-5-codex']);
    expect([...partition.unattributed].sort()).toEqual(['local-model', 'mystery-model']);
  });
});

// ---------------------------------------------------------------------------
// Bordered panel box (command-triggered panels)
// ---------------------------------------------------------------------------

describe('UsagePanelComponent', () => {
  it('wraps preformatted usage lines in a bordered panel', () => {
    const component = new UsagePanelComponent(() => ['Session usage'], 'primary');
    const output = component.render(80).map(strip);

    expect(output[0]).toContain(' Usage ');
    expect(output[1]).toContain('Session usage');
  });

  it('truncates lines wider than the terminal so the panel never overflows', () => {
    const longLine = 'error: ' + 'x'.repeat(200);
    const component = new UsagePanelComponent(() => [longLine], 'primary');
    const width = 60;

    const output = component.render(width);

    for (const line of output) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('keeps the bordered panel within narrow terminal widths', () => {
    const component = new UsagePanelComponent(() => ['Session usage', '  kimi  input 2.0k'], 'primary');

    for (const width of [39, 24, 20, 10, 4, 1]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('rebuilds its body from the active palette on invalidate', () => {
    // Emit the resolved palette value as visible text so the assertion holds
    // regardless of chalk's colour level in the test environment.
    const component = new UsagePanelComponent(() => [`text=${currentTheme.color('text')}`], 'primary');
    const bodyOf = (): string => {
      const line = component.render(80).map(strip).find((l) => l.includes('text='));
      if (line === undefined) throw new Error('body line not found');
      return line;
    };

    expect(bodyOf()).toContain(darkColors.text);
    currentTheme.setPalette(lightColors);
    component.invalidate();
    expect(bodyOf()).toContain(lightColors.text);
  });
});

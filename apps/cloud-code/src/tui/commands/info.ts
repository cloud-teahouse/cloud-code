import { release as osRelease, type as osType } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  CHATGPT_CODEX_PROVIDER_NAME,
  CLOUD_CODE_PROVIDER_NAME,
  type CodexPlanUsage,
} from '@cloud-code/oauth';
import type { McpServerInfo, SessionUsage } from '@cloud-code/sdk';

import { StatusDialogComponent, type StatusDialogRedeemController, type StatusDialogTab, type StatusDialogUpdate } from '../components/dialogs/status-dialog';
import { buildMcpStatusReportLines } from '../components/messages/mcp-status-panel';
import {
  UsagePanelComponent,
  type ManagedUsageReport,
  type StatusTabAccount,
} from '../components/messages/usage-panel';
import {
  FEEDBACK_ISSUE_URL,
  FEEDBACK_STATUS_CANCELLED,
  FEEDBACK_STATUS_FALLBACK,
  FEEDBACK_STATUS_NETWORK_ERROR,
  FEEDBACK_STATUS_NOT_SIGNED_IN,
  FEEDBACK_STATUS_SUBMITTING,
  FEEDBACK_STATUS_SUCCESS,
  FEEDBACK_STATUS_UPLOAD_FAILED,
  feedbackIdLine,
  feedbackSessionLine,
  withFeedbackVersionPrefix,
} from '../constant/feedback';
import { isManagedUsageProvider } from '../constant/cloud-code-tui';
import { resolveDescription, t } from '../i18n';
import {
  loadTokenActivity,
  loadTokenActivityStats,
  type TokenActivityStats,
} from '../services/token-activity';
import { submitFeedbackWithAttachments } from '../../feedback/feedback-attachments';
import { createAsyncTtlMemo, type AsyncTtlMemo } from '../utils/async-memo';
import { formatErrorMessage } from '../utils/event-payload';
import { openUrl } from '#/utils/open-url';
import { promptFeedbackAttachment, promptFeedbackInput } from './prompts';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export async function handleFeedbackCommand(host: SlashCommandHost): Promise<void> {
  const fallback = (reason: string): void => {
    // One logical notice, one call: the transient notice slot is single-entry,
    // so a multi-line result must arrive as a single message.
    host.showStatus(`${reason}\n${FEEDBACK_ISSUE_URL}`);
    openUrl(FEEDBACK_ISSUE_URL);
  };

  const providerKey = host.state.appState.availableModels[host.state.appState.model]?.provider;
  if (!isManagedUsageProvider(providerKey)) {
    fallback(resolveDescription(FEEDBACK_STATUS_NOT_SIGNED_IN));
    return;
  }

  // Stage 1: collect the free-form feedback text.
  const input = await promptFeedbackInput(host);
  if (input === undefined) {
    host.showStatus(resolveDescription(FEEDBACK_STATUS_CANCELLED));
    return;
  }

  // Stage 2: ask whether to attach diagnostics (logs / codebase).
  const level = await promptFeedbackAttachment(host);
  if (level === undefined) {
    host.showStatus(resolveDescription(FEEDBACK_STATUS_CANCELLED));
    return;
  }

  const version = withFeedbackVersionPrefix(host.state.appState.version);
  const spinner = host.showLoginProgressSpinner(resolveDescription(FEEDBACK_STATUS_SUBMITTING));
  // Guarantee the spinner's underlying setInterval is always cleared, even when
  // submitFeedback or submitFeedbackWithAttachments throws — otherwise the
  // interval (and its per-frame requestRender) leaks for the rest of the session.
  let stopped = false;
  const stopSpinner = (opts: { ok: boolean; label: string }): void => {
    if (stopped) return;
    stopped = true;
    spinner.stop(opts);
  };
  try {
    const res = await host.harness.auth.submitFeedback({
      content: input.value,
      sessionId: host.state.appState.sessionId,
      version,
      os: `${osType()} ${osRelease()}`,
      model: host.state.appState.model.length > 0 ? host.state.appState.model : null,
    });

    if (res.kind !== 'ok') {
      stopSpinner({ ok: false, label: res.message });
      fallback(resolveDescription(FEEDBACK_STATUS_FALLBACK));
      return;
    }

    // Stage 3: prepare and upload each requested attachment independently.
    const attachmentFailed = await submitFeedbackWithAttachments(host, res.feedbackId, level);

    stopSpinner({ ok: true, label: resolveDescription(FEEDBACK_STATUS_SUCCESS) });
    // One logical notice, one call: the transient notice slot is single-entry,
    // so a multi-line result must arrive as a single message.
    host.showStatus(
      [
        feedbackSessionLine(host.state.appState.sessionId),
        feedbackIdLine(res.feedbackId),
        ...(attachmentFailed ? [resolveDescription(FEEDBACK_STATUS_UPLOAD_FAILED)] : []),
      ].join('\n'),
    );
  } catch (error) {
    stopSpinner({ ok: false, label: resolveDescription(FEEDBACK_STATUS_NETWORK_ERROR) });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Info commands
// ---------------------------------------------------------------------------

interface SessionUsageResult {
  readonly usage?: SessionUsage;
  readonly error?: string;
}

interface ManagedUsageResult {
  readonly usage?: ManagedUsageReport;
  readonly error?: string;
}

interface CodexUsageResult {
  readonly usage?: CodexPlanUsage;
  readonly error?: string;
}

/**
 * Short-TTL memos for the expensive /status reads, so reopening the panel
 * within a session is instant. The wire-log loads keep their underlying
 * per-file (mtime, size) parse cache; the memo only skips the directory walk
 * for a few seconds. Managed usage (a network call) is memoized per provider
 * for a minute — errors are not cached, so a transient failure retries on
 * the next open.
 */
const TOKEN_ACTIVITY_MEMO_TTL_MS = 3_000;
const MANAGED_USAGE_MEMO_TTL_MS = 60_000;

const EMPTY_TOKEN_ACTIVITY_STATS: TokenActivityStats = {
  totalTokens: 0,
  activeDays: 0,
  mostActiveDay: undefined,
  favoriteModel: undefined,
  sessionCount: 0,
  longestSessionMs: undefined,
};

const tokenActivityMemo = createAsyncTtlMemo(
  () => loadTokenActivity(),
  TOKEN_ACTIVITY_MEMO_TTL_MS,
);
const tokenActivityStatsMemo = createAsyncTtlMemo(
  () => loadTokenActivityStats(),
  TOKEN_ACTIVITY_MEMO_TTL_MS,
);

type ManagedUsageAuth = SlashCommandHost['harness']['auth'];

// Keyed by the auth facade (i.e. per TUI instance) so the memo never leaks a
// cached report across accounts or test hosts.
let managedUsageMemos = new WeakMap<
  ManagedUsageAuth,
  AsyncTtlMemo<[string | undefined], ManagedUsageResult>
>();

function managedUsageReport(
  host: SlashCommandHost,
  provider: string | undefined,
): Promise<ManagedUsageResult> {
  const { auth } = host.harness;
  let memo = managedUsageMemos.get(auth);
  if (memo === undefined) {
    memo = createAsyncTtlMemo(
      (managedProvider: string | undefined) => fetchManagedUsageReport(host, managedProvider),
      MANAGED_USAGE_MEMO_TTL_MS,
      {
        key: (managedProvider) => managedProvider ?? '',
        cacheWhen: (result) => result.error === undefined,
      },
    );
    managedUsageMemos.set(auth, memo);
  }
  return memo(provider);
}

// Same per-facade keying and success-only caching as the managed-usage memo:
// reopening /status within the TTL never refetches, and a failed endpoint
// read retries on the next open.
let codexUsageMemos = new WeakMap<ManagedUsageAuth, AsyncTtlMemo<[], CodexUsageResult>>();

function codexUsageReport(host: SlashCommandHost): Promise<CodexUsageResult> {
  const { auth } = host.harness;
  let memo = codexUsageMemos.get(auth);
  if (memo === undefined) {
    memo = createAsyncTtlMemo(() => fetchCodexUsageReport(host), MANAGED_USAGE_MEMO_TTL_MS, {
      cacheWhen: (result) => result.error === undefined,
    });
    codexUsageMemos.set(auth, memo);
  }
  return memo();
}

/** Test hook: drop the short-TTL data memos (mirrors clearTokenActivityCache). */
export function clearStatusPanelDataMemos(): void {
  tokenActivityMemo.clear();
  tokenActivityStatsMemo.clear();
  managedUsageMemos = new WeakMap();
  codexUsageMemos = new WeakMap();
}

/**
 * /status — the tabbed dashboard (Status | Kimi Code | ChatGPT | Stats). The
 * dialog mounts immediately with the synchronous app-state fields; every
 * asynchronous data source resolves independently and repaints only its own
 * section, so a slow endpoint (managed usage, the wire-log walk) never delays
 * the rest.
 */
export async function showStatusPanel(
  host: SlashCommandHost,
  initialTab: StatusDialogTab = 'status',
  returnTo?: () => void,
): Promise<void> {
  const appState = host.state.appState;
  const onCancel = (): void => {
    host.restoreEditor(editorSlotHandle);
    returnTo?.();
  };
  // ChatGPT reset-credit redeem endpoints for the dialog's armed-confirm
  // state machine. The idempotency key is minted inside `consume`, so every
  // user-confirmed attempt carries its own redeem_request_id (never per
  // render); a success busts the 60s usage memo and refetches so the tab
  // repaints the reset windows and the remaining count. The closures touch
  // `update` only at call time, after its initialization below.
  const redeemResetCredit: StatusDialogRedeemController = {
    preview: async () => {
      const list = await host.harness.auth.listCodexResetCredits(CHATGPT_CODEX_PROVIDER_NAME);
      return list.credits;
    },
    consume: (creditId) =>
      host.harness.auth.consumeCodexResetCredit(
        randomUUID(),
        creditId,
        CHATGPT_CODEX_PROVIDER_NAME,
      ),
    requestRender: () => host.state.ui.requestRender(),
    refreshUsage: () => {
      codexUsageMemos.get(host.harness.auth)?.clear();
      void codexUsageReport(host).then((codexUsage) => {
        update({
          chatgpt: {
            codexUsageLoading: false,
            codexUsage: codexUsage.usage ?? null,
          },
        });
      });
    },
  };
  const dialog = new StatusDialogComponent({
    initialTab,
    status: {
      version: appState.version,
      model: appState.model,
      workDir: appState.workDir,
      sessionId: appState.sessionId,
      sessionTitle: appState.sessionTitle,
      availableModels: appState.availableModels,
      permissionMode: appState.permissionMode,
      contextUsage: appState.contextUsage,
      contextTokens: appState.contextTokens,
      maxContextTokens: appState.maxContextTokens,
      mcpServers: undefined,
      mcpServersLoading: true,
      sandbox: undefined,
      sandboxLoading: host.session !== undefined,
    },
    kimi: {
      account: undefined,
      sessionUsage: undefined,
      sessionUsageError: undefined,
      sessionUsageLoading: true,
      availableModels: appState.availableModels,
      managedUsage: undefined,
      managedUsageError: undefined,
      managedUsageLoading: true,
    },
    chatgpt: {
      account: undefined,
      sessionUsage: undefined,
      sessionUsageError: undefined,
      sessionUsageLoading: true,
      availableModels: appState.availableModels,
      rateLimit: null,
      codexUsage: undefined,
      codexUsageLoading: false,
    },
    stats: { buckets: undefined, stats: undefined },
    redeemResetCredit,
    onCancel,
  });
  const editorSlotHandle = host.mountEditorReplacement(dialog);
  const update = (patch: StatusDialogUpdate): void => {
    dialog.update(patch);
    host.state.ui.requestRender();
  };

  void loadSessionUsageReport(host).then((sessionUsage) => {
    update({
      kimi: {
        sessionUsageLoading: false,
        sessionUsage: sessionUsage.usage,
        sessionUsageError: sessionUsage.error,
      },
      chatgpt: {
        sessionUsageLoading: false,
        sessionUsage: sessionUsage.usage,
        sessionUsageError: sessionUsage.error,
        rateLimit: sessionUsage.usage?.rateLimit ?? null,
      },
    });
  });
  void loadAccountSnapshot(host, CLOUD_CODE_PROVIDER_NAME).then((kimiAccount) => {
    update({ kimi: { account: kimiAccount } });
    // The managed-usage endpoint belongs to the Kimi account, so it chains
    // off the snapshot rather than the parallel batch.
    void loadManagedUsageReport(host, kimiAccount.state === 'logged-in').then((managedUsage) => {
      update({
        kimi: {
          managedUsageLoading: false,
          managedUsage: managedUsage?.usage,
          managedUsageError: managedUsage?.error,
        },
      });
    });
  });
  void loadAccountSnapshot(host, CHATGPT_CODEX_PROVIDER_NAME).then((chatGptAccount) => {
    const loggedIn = chatGptAccount.state === 'logged-in';
    update({ chatgpt: { account: chatGptAccount, codexUsageLoading: loggedIn } });
    if (!loggedIn) return;
    // The fresh endpoint read upgrades the header snapshot when it lands; a
    // failure leaves the header snapshot (and its stale marker) untouched.
    void codexUsageReport(host).then((codexUsage) => {
      update({
        chatgpt: {
          codexUsageLoading: false,
          codexUsage: codexUsage.usage ?? null,
        },
      });
    });
  });
  void loadMcpServerList(host).then((mcpServers) => {
    update({ status: { mcpServers, mcpServersLoading: false } });
  });
  const statusSession = host.session;
  if (statusSession !== undefined) {
    void statusSession.getSandboxStatus().then(
      (sandbox) => {
        update({ status: { sandbox, sandboxLoading: false } });
      },
      () => {
        update({ status: { sandboxLoading: false } });
      },
    );
  }
  void tokenActivityMemo().then(
    (tokenActivity) => {
      update({ stats: { buckets: tokenActivity.buckets } });
    },
    () => {
      update({ stats: { buckets: [] } });
    },
  );
  void tokenActivityStatsMemo().then(
    (stats) => {
      update({ stats: { stats } });
    },
    () => {
      update({ stats: { stats: EMPTY_TOKEN_ACTIVITY_STATS } });
    },
  );
}

/** /usage — alias for /status landing directly on the first account tab. */
export async function showUsage(host: SlashCommandHost, returnTo?: () => void): Promise<void> {
  return showStatusPanel(host, 'kimi', returnTo);
}

/** /status [status|usage|kimi|chatgpt|stats] — the dashboard, optionally preselecting a tab. */
export async function showStatusReport(host: SlashCommandHost, args = ''): Promise<void> {
  const arg = args.trim().toLowerCase();
  const tab: StatusDialogTab =
    arg === 'usage' || arg === 'kimi'
      ? 'kimi'
      : arg === 'chatgpt'
        ? 'chatgpt'
        : arg === 'stats'
          ? 'stats'
          : 'status';
  return showStatusPanel(host, tab);
}

/** Account snapshot with credential-store failures mapped to signed-out. */
async function loadAccountSnapshot(
  host: SlashCommandHost,
  providerName: string,
): Promise<StatusTabAccount> {
  try {
    const snapshot = await host.harness.auth.getAccountSnapshot(providerName);
    return {
      state: snapshot.state,
      email: snapshot.email,
      planType: snapshot.planType,
    };
  } catch {
    // A broken credential store must not break /status — treat as signed out.
    return { state: 'not-logged-in' };
  }
}

/** MCP server list for the Status tab; undefined when the RPC is unavailable. */
async function loadMcpServerList(
  host: SlashCommandHost,
): Promise<readonly McpServerInfo[] | undefined> {
  try {
    return await host.requireSession().listMcpServers();
  } catch {
    return undefined;
  }
}

export async function showMcpServers(host: SlashCommandHost): Promise<void> {
  let servers: readonly McpServerInfo[];
  try {
    servers = await host.requireSession().listMcpServers();
  } catch (error) {
    host.showError(t('commands.mcp.loadFailed', { error: formatErrorMessage(error) }));
    return;
  }

  const title = servers.length > 0 ? ` MCP (${servers.length}) ` : ' MCP ';
  const panel = new UsagePanelComponent(
    () => buildMcpStatusReportLines({ servers }),
    'primary',
    title,
  );
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

async function loadSessionUsageReport(host: SlashCommandHost): Promise<SessionUsageResult> {
  try {
    return { usage: await host.requireSession().getUsage() };
  } catch (error) {
    return { error: formatErrorMessage(error) };
  }
}

/**
 * Kimi plan usage, fetched only when the account is logged in. The usage
 * endpoint belongs to the Kimi account, so a non-managed active model falls
 * back to the default (Kimi) provider resolution. Successful reports are
 * memoized briefly per provider (see managedUsageReport).
 */
function loadManagedUsageReport(
  host: SlashCommandHost,
  kimiLoggedIn: boolean,
): Promise<ManagedUsageResult | undefined> {
  if (!kimiLoggedIn) return Promise.resolve(undefined);
  const alias = host.state.appState.model;
  const providerKey = host.state.appState.availableModels[alias]?.provider;
  const managedProvider = isManagedUsageProvider(providerKey) ? providerKey : undefined;
  return managedUsageReport(host, managedProvider);
}

/** Raw managed-usage endpoint call, mapped to a report-or-error result. */
async function fetchManagedUsageReport(
  host: SlashCommandHost,
  managedProvider: string | undefined,
): Promise<ManagedUsageResult> {
  let res;
  try {
    res = await host.harness.auth.getManagedUsage(managedProvider);
  } catch (error) {
    return { error: formatErrorMessage(error) };
  }
  if (res.kind === 'error') {
    return { error: res.message };
  }
  return { usage: { summary: res.summary, limits: res.limits, extraUsage: res.extraUsage } };
}

/**
 * Raw codex usage-endpoint call, mapped to a report-or-error result. The
 * error is never rendered — it only keeps the failure out of the memo so
 * the next /status open retries.
 */
async function fetchCodexUsageReport(host: SlashCommandHost): Promise<CodexUsageResult> {
  try {
    return { usage: await host.harness.auth.fetchCodexUsage(CHATGPT_CODEX_PROVIDER_NAME) };
  } catch (error) {
    return { error: formatErrorMessage(error) };
  }
}

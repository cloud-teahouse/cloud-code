/**
 * MailboxService — delivery and protocol orchestration on top of
 * {@link MailboxStore}.
 *
 * Two watcher families turn inbox writes into model-visible input:
 *
 *   - a per-team LEADER watcher steers unread messages from the team's
 *     `leader` inbox into the main agent's turn (the same steer/flush path
 *     background-task notifications already use — idle turns included);
 *   - a per-run TEAMMATE watcher steers unread messages from a teammate's
 *     inbox into that teammate's turn while a turn is active. Delivery is
 *     run-scoped: messages arriving after the run's final turn stay unread
 *     and are drained as catch-up at the next run start, instead of
 *     launching turns outside the teammate's AsyncLocalStorage scope.
 *
 * Shutdown protocol: a `shutdown_request` addressed to a teammate is
 * delivered as a wrap-up notice, and a grace timer gives the model a
 * bounded window to finish cleanly; on expiry the watcher stops the
 * teammate's background task through the leader's BackgroundManager (the
 * same path TaskStop rides, so the task settles `killed` with a proper
 * reason) and posts `shutdown_approved` to the leader's inbox.
 */

import type { Agent } from '../..';
import type { ApprovalRequest, ApprovalResponse } from '#/rpc';
import type { AgentMeta } from '../../session';
import { abortable } from '../../utils/abort';
import { sleep } from '../../utils/promise';
import { generateBase36Id } from '../../utils/random-id';
import { escapeXml, escapeXmlAttr } from '../../utils/xml-escape';
import {
  LEADER_INBOX,
  MailboxStore,
  type MailboxMessage,
  type TaskAssignmentBody,
} from './mailbox';
import type { MailboxOrigin } from '../context/types';

export { DEFAULT_INBOX_READ_HISTORY_LIMIT } from './mailbox';

export const DEFAULT_MAILBOX_POLL_INTERVAL_MS = 500;
export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
/**
 * Fallback-track permission wait ceiling: an unanswered mailbox
 * permission request denies deterministically after this long. The primary
 * track (the leader's interactive queue) has no timeout by design — it is
 * the same surface the leader's own asks use.
 */
export const DEFAULT_PERMISSION_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
/** Cap on the tool-input JSON stored in a permission request body. */
const PERMISSION_REQUEST_INPUT_PREVIEW_CHARS = 2_000;

/** Session-side capabilities the service needs, provided as closures. */
export interface MailboxHooks {
  /** Live view of the session agent metadata (the roster authority). */
  readonly roster: () => Readonly<Record<string, AgentMeta>>;
  /** The leader agent, when instantiated. */
  readonly leader: () => Agent | undefined;
  /**
   * Stop the background task backing an agent (the leader's
   * BackgroundManager, resolved by the session). Returns false when the
   * agent has no live task — the shutdown then only needs the ack.
   */
  readonly stopAgentTask: (agentId: string, reason: string) => Promise<boolean>;
  /**
   * Observe every persisted mailbox send (any sender, any kind — the store
   * hook is forwarding-level, so direct `store.send` callers are covered
   * too). The session turns this into the `mailbox.activity` protocol
   * event for read-only team viewers.
   */
  readonly emitActivity?: ((teamName: string, message: MailboxMessage) => void) | undefined;
}

export interface MailboxServiceOptions {
  readonly pollIntervalMs?: number | undefined;
  readonly shutdownGraceMs?: number | undefined;
  readonly permissionRequestTimeoutMs?: number | undefined;
  /**
   * Inbox ring cap: newest read messages retained per inbox on append;
   * unread messages are always kept. Default
   * {@link DEFAULT_INBOX_READ_HISTORY_LIMIT}.
   */
  readonly inboxReadHistoryLimit?: number | undefined;
}

export interface TeammateWatchInput {
  readonly teamName: string;
  readonly name: string;
  readonly agentId: string;
  readonly agent: Agent;
  readonly controller: AbortController;
}

interface LeaderWatch {
  readonly teamName: string;
  timer: ReturnType<typeof setInterval>;
  delivering: boolean;
}

interface PendingShutdown {
  readonly requestId: string;
  readonly reason?: string | undefined;
  ackSent: boolean;
}

interface TeammateWatch extends TeammateWatchInput {
  readonly timer: ReturnType<typeof setInterval>;
  pendingShutdown?: PendingShutdown | undefined;
  stopped: boolean;
  delivering: boolean;
}

export class MailboxService {
  readonly store: MailboxStore;
  private readonly pollIntervalMs: number;
  private readonly shutdownGraceMs: number;
  private readonly permissionRequestTimeoutMs: number;
  private readonly leaderWatches = new Map<string, LeaderWatch>();
  private readonly teammateWatches = new Map<string, TeammateWatch>();
  /**
   * Permission request ids with a live waiter in
   * {@link MailboxService.requestPermissionViaMailbox}. The teammate watcher
   * must leave matching `permission_response` envelopes unread for that
   * waiter: steering them into the turn (and marking them read) races the
   * waiter's poll, and the loser side turns an answered request into a full
   * permissionRequestTimeoutMs denial.
   */
  private readonly pendingPermissionRequestIds = new Set<string>();
  private closed = false;

  constructor(
    sessionDir: string,
    private readonly hooks: MailboxHooks,
    options: MailboxServiceOptions = {},
  ) {
    this.store = new MailboxStore(sessionDir, {
      readHistoryLimit: options.inboxReadHistoryLimit,
      onSend: (teamName, message) => {
        this.hooks.emitActivity?.(teamName, message);
      },
    });
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_MAILBOX_POLL_INTERVAL_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.permissionRequestTimeoutMs =
      options.permissionRequestTimeoutMs ?? DEFAULT_PERMISSION_REQUEST_TIMEOUT_MS;
  }

  // ── addressing ─────────────────────────────────────────────────────

  /**
   * Validate a (team, recipient) address. The leader inbox always resolves;
   * a teammate recipient must exist in the roster with a matching team.
   */
  resolveRecipient(
    teamName: string,
    to: string,
  ): { readonly ok: true } | { readonly ok: false; readonly error: string } {
    if (to === LEADER_INBOX) return { ok: true };
    for (const meta of Object.values(this.hooks.roster())) {
      if (meta.teammate?.teamName === teamName && meta.teammate.name === to) {
        return { ok: true };
      }
    }
    return {
      ok: false,
      error: `No teammate named "${to}" in team "${teamName}". Check the name, or address the leader as "${LEADER_INBOX}".`,
    };
  }

  // ── sending ────────────────────────────────────────────────────────

  /** Send a plain message; starts leader delivery when addressed upstream. */
  async sendMessage(
    teamName: string,
    from: string,
    to: string,
    text: string,
    summary?: string,
  ): Promise<MailboxMessage> {
    const message = await this.store.send(teamName, {
      from,
      to,
      kind: 'message',
      body: { text, summary },
    });
    if (to === LEADER_INBOX) this.ensureLeaderWatcher(teamName);
    return message;
  }

  /** Assignment notification for a direct task owner. */
  async sendTaskAssignment(
    teamName: string,
    from: string,
    to: string,
    assignment: TaskAssignmentBody,
  ): Promise<MailboxMessage> {
    return this.store.send(teamName, {
      from,
      to,
      kind: 'task_assignment',
      body: assignment,
    });
  }

  /** Post a shutdown request to a teammate's inbox; delivery drives the stop. */
  async requestShutdown(
    teamName: string,
    from: string,
    to: string,
    reason?: string,
  ): Promise<MailboxMessage> {
    return this.store.send(teamName, {
      from,
      to,
      kind: 'shutdown_request',
      body: { requestId: `shutdown_${Date.now().toString(36)}`, reason },
    });
  }

  // ── leader permission bridge ───────────────────────────────────────

  /**
   * Route a teammate's interactive approval through the leader.
   *
   * Primary track: the leader's own approval queue (`leader.rpc
   * .requestApproval`) with a `requester` badge so the user sees WHICH
   * teammate is asking — concurrent asks from several teammates queue in
   * the same UI as the leader's own. No timeout by design: it is the same
   * surface the leader's asks use, and the teammate's run signal cancels.
   *
   * Fallback track (no interactive handler — headless/server without a
   * connected client): a `permission_request` envelope to the leader's
   * inbox, delivered by the leader watcher; the leader model answers with
   * SendMessage `permission_response`, which the waiter matches by
   * requestId out of order (the read-index semantics exist for exactly
   * this). Unanswered requests deny deterministically on timeout; a
   * stopped teammate's wait maps to `cancelled` instead of hanging.
   */
  async requestPermissionViaLeader(input: {
    readonly teamName: string;
    readonly name: string;
    readonly request: ApprovalRequest & { readonly input?: unknown };
    readonly signal: AbortSignal;
  }): Promise<ApprovalResponse> {
    const { teamName, name, request, signal } = input;
    try {
      signal.throwIfAborted();
      const leader = this.hooks.leader();
      const requestApproval = leader?.rpc?.requestApproval;
      if (requestApproval !== undefined) {
        return await requestApproval(
          {
            turnId: request.turnId,
            toolCallId: request.toolCallId,
            toolName: request.toolName,
            action: request.action,
            display: request.display,
            requester: { name, teamName },
          },
          { signal },
        );
      }
      return await this.requestPermissionViaMailbox(teamName, name, request, signal);
    } catch (error) {
      if (signal.aborted || error === signal.reason) {
        return { decision: 'cancelled' };
      }
      throw error;
    }
  }

  private async requestPermissionViaMailbox(
    teamName: string,
    name: string,
    request: ApprovalRequest & { readonly input?: unknown },
    signal: AbortSignal,
  ): Promise<ApprovalResponse> {
    const requestId = generatePermissionRequestId();
    // Register before sending: the answer can land in the teammate's inbox
    // immediately, and the teammate watcher must know to leave it for this
    // waiter's poll (see pendingPermissionRequestIds).
    this.pendingPermissionRequestIds.add(requestId);
    try {
      await this.store.send(teamName, {
        from: name,
        to: LEADER_INBOX,
        kind: 'permission_request',
        body: {
          requestId,
          toolName: request.toolName,
          toolUseId: request.toolCallId,
          description: request.action,
          input: previewPermissionInput(request.input),
          permissionSuggestions: [],
        },
      });
      this.ensureLeaderWatcher(teamName);

      const deadline = Date.now() + this.permissionRequestTimeoutMs;
      for (;;) {
        signal.throwIfAborted();
        const unread = await this.store.unread(teamName, name);
        const match = unread.find(
          (message): message is MailboxMessage & { readonly kind: 'permission_response' } =>
            message.kind === 'permission_response' && message.body.requestId === requestId,
        );
        if (match !== undefined) {
          await this.store.markRead(teamName, name, [match.id]);
          return match.body.subtype === 'success'
            ? { decision: 'approved' }
            : {
                decision: 'rejected',
                feedback: match.body.error ?? 'Permission rejected by the leader',
              };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return {
            decision: 'rejected',
            feedback:
              `Permission request timed out after ${String(Math.round(this.permissionRequestTimeoutMs / 1000))}s ` +
              'waiting for the leader. Do not retry blindly — report the blockage in your summary.',
          };
        }
        await abortable(sleep(Math.min(this.pollIntervalMs, remaining)), signal);
      }
    } finally {
      this.pendingPermissionRequestIds.delete(requestId);
    }
  }

  private async sendShutdownApproved(
    teamName: string,
    from: string,
    requestId: string,
  ): Promise<void> {
    await this.store.send(teamName, {
      from,
      to: LEADER_INBOX,
      kind: 'shutdown_approved',
      body: { requestId },
    });
    this.ensureLeaderWatcher(teamName);
  }

  // ── delivery: leader watcher ───────────────────────────────────────

  /** Idempotently start steering a team's leader inbox into the main agent. */
  ensureLeaderWatcher(teamName: string): void {
    if (this.closed || this.leaderWatches.has(teamName)) return;
    const watch: LeaderWatch = {
      teamName,
      timer: setInterval(() => {
        void this.deliverLeaderInbox(watch).catch(() => {});
      }, this.pollIntervalMs),
      delivering: false,
    };
    watch.timer.unref?.();
    this.leaderWatches.set(teamName, watch);
    // Deliver anything already queued (e.g. messages written before the
    // watcher existed) on the next tick rather than waiting a full interval.
    void this.deliverLeaderInbox(watch).catch(() => {});
  }

  private async deliverLeaderInbox(watch: LeaderWatch): Promise<void> {
    // Serialize ticks: an in-flight delivery still owes its markRead, so an
    // overlapping tick would re-read (and re-inject) the same messages.
    if (watch.delivering) return;
    watch.delivering = true;
    try {
      const teamName = watch.teamName;
      const unread = await this.store.unread(teamName, LEADER_INBOX);
      if (unread.length === 0) return;
      const leader = this.hooks.leader();
      if (leader === undefined) return;
      for (const message of unread) {
        leader.turn.steer([{ type: 'text', text: renderMailboxMessage(teamName, message) }], {
          kind: 'mailbox',
          teamName,
          from: message.from,
          messageId: message.id,
        } satisfies MailboxOrigin);
      }
      await this.store.markRead(
        teamName,
        LEADER_INBOX,
        unread.map((message) => message.id),
      );
    } finally {
      watch.delivering = false;
    }
  }

  // ── delivery: teammate watcher ─────────────────────────────────────

  /**
   * Watch a teammate's inbox for one run. Replaces any previous watch for
   * the same agent (resume/retry re-arm it). The watch stops when the run's
   * controller aborts; a still-pending shutdown is acked at that point
   * (the run ending during the grace window means the notice was honored).
   */
  startTeammateWatcher(input: TeammateWatchInput): void {
    if (this.closed) return;
    this.stopTeammateWatcher(input.agentId);
    const watch: TeammateWatch = {
      ...input,
      timer: setInterval(() => {
        void this.deliverTeammateInbox(watch).catch(() => {});
      }, this.pollIntervalMs),
      stopped: false,
      delivering: false,
    };
    watch.timer.unref?.();
    this.teammateWatches.set(input.agentId, watch);
    input.controller.signal.addEventListener(
      'abort',
      () => {
        this.stopTeammateWatcher(input.agentId);
      },
      { once: true },
    );
    // Catch-up drain: messages queued while no run was active deliver now.
    void this.deliverTeammateInbox(watch).catch(() => {});
  }

  private stopTeammateWatcher(agentId: string): void {
    const watch = this.teammateWatches.get(agentId);
    if (watch === undefined) return;
    this.teammateWatches.delete(agentId);
    watch.stopped = true;
    clearInterval(watch.timer);
    const pending = watch.pendingShutdown;
    if (pending !== undefined && !pending.ackSent) {
      pending.ackSent = true;
      void this.sendShutdownApproved(watch.teamName, watch.name, pending.requestId).catch(() => {});
    }
  }

  private async deliverTeammateInbox(watch: TeammateWatch): Promise<void> {
    if (watch.stopped || watch.delivering) return;
    watch.delivering = true;
    try {
      const unread = await this.store.unread(watch.teamName, watch.name);
      if (unread.length === 0) return;

      const shutdowns = unread.filter(
        (message): message is MailboxMessage & { readonly kind: 'shutdown_request' } =>
          message.kind === 'shutdown_request',
      );
      // A permission_response with a live waiter is consumed by that waiter's
      // poll, not by the model: steering it here (and marking it read) would
      // race the waiter and strand the request until the timeout denies it.
      const deliverables = unread.filter(
        (message) =>
          message.kind !== 'shutdown_request' &&
          !(
            message.kind === 'permission_response' &&
            this.pendingPermissionRequestIds.has(message.body.requestId)
          ),
      );

      // Ordinary messages only inject into an ACTIVE turn: a steer with no
      // live turn would launch one outside the teammate's ALS scope, so those
      // stay unread for the next run instead.
      if (deliverables.length > 0 && watch.agent.turn.hasActiveTurn) {
        for (const message of deliverables) {
          watch.agent.turn.steer(
            [{ type: 'text', text: renderMailboxMessage(watch.teamName, message) }],
            {
              kind: 'mailbox',
              teamName: watch.teamName,
              from: message.from,
              messageId: message.id,
            } satisfies MailboxOrigin,
          );
        }
        await this.store.markRead(
          watch.teamName,
          watch.name,
          deliverables.map((message) => message.id),
        );
      }

      for (const shutdown of shutdowns) {
        if (watch.pendingShutdown !== undefined) {
          await this.store.markRead(watch.teamName, watch.name, [shutdown.id]);
          continue;
        }
        watch.pendingShutdown = {
          requestId: shutdown.body.requestId,
          reason: shutdown.body.reason,
          ackSent: false,
        };
        await this.store.markRead(watch.teamName, watch.name, [shutdown.id]);
        if (watch.agent.turn.hasActiveTurn) {
          watch.agent.turn.steer(
            [{ type: 'text', text: renderMailboxMessage(watch.teamName, shutdown) }],
            {
              kind: 'mailbox',
              teamName: watch.teamName,
              from: shutdown.from,
              messageId: shutdown.id,
            } satisfies MailboxOrigin,
          );
          setTimeout(() => {
            void this.initiateShutdownStop(watch);
          }, this.shutdownGraceMs).unref?.();
        } else {
          // No active turn: nothing to wrap up — stop immediately.
          await this.initiateShutdownStop(watch);
        }
      }
    } finally {
      watch.delivering = false;
    }
  }

  /**
   * Grace expired (or nothing to wrap up): stop the teammate's task through
   * the leader's BackgroundManager — the TaskStop path, so the task settles
   * `killed` with the shutdown reason — and ack the leader. The ack is
   * claimed up front: stopping the task aborts the run controller, which
   * tears this watch down, and the teardown acks any still-pending
   * shutdown — without the claim the leader would get it twice.
   */
  private async initiateShutdownStop(watch: TeammateWatch): Promise<void> {
    const pending = watch.pendingShutdown;
    if (pending === undefined || pending.ackSent) return;
    pending.ackSent = true;
    const reason =
      pending.reason !== undefined
        ? `Shutdown requested by the leader: ${pending.reason}`
        : 'Shutdown requested by the leader';
    const stopped = await this.hooks.stopAgentTask(watch.agentId, reason);
    if (!stopped && watch.agent.turn.hasActiveTurn) {
      // The task lookup failed but the run is still alive (e.g. task not yet
      // registered): fall back to aborting the run controller directly.
      watch.controller.abort(reason);
    }
    await this.sendShutdownApproved(watch.teamName, watch.name, pending.requestId).catch(() => {});
  }

  // ── lifecycle ──────────────────────────────────────────────────────

  /** Stop every watcher (session close). Inbox contents persist on disk. */
  async close(): Promise<void> {
    this.closed = true;
    for (const watch of this.leaderWatches.values()) {
      clearInterval(watch.timer);
    }
    this.leaderWatches.clear();
    for (const agentId of Array.from(this.teammateWatches.keys())) {
      this.stopTeammateWatcher(agentId);
    }
  }
}

// ── model rendering ──────────────────────────────────────────────────

/** `preq_{8 base36 chars}` — permission request/response correlation id. */
function generatePermissionRequestId(): string {
  return generateBase36Id('preq_');
}

/**
 * The tool input stored in a permission request body: the raw record when it
 * serializes small, otherwise a truncated JSON preview — the interactive
 * track always has the full display payload, this only feeds the fallback
 * rendering.
 */
function previewPermissionInput(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  const record = input as Record<string, unknown>;
  const json = JSON.stringify(record);
  if (json.length <= PERMISSION_REQUEST_INPUT_PREVIEW_CHARS) return record;
  return { preview: `${json.slice(0, PERMISSION_REQUEST_INPUT_PREVIEW_CHARS)}…(truncated)` };
}

/**
 * One message as a `<teammate-message>` element. Plain and protocol kinds
 * alike render as readable text — the model should see the same content a
 * UI would; protocol consumers parse the structured bodies out of
 * band, not from this rendering.
 */
export function renderMailboxMessage(teamName: string, message: MailboxMessage): string {
  const head = `<teammate-message from="${escapeXmlAttr(message.from)}" team="${escapeXmlAttr(teamName)}" kind="${message.kind}">`;
  switch (message.kind) {
    case 'message':
      return [head, escapeXml(message.body.text), '</teammate-message>'].join('\n');
    case 'task_assignment': {
      const body = message.body;
      const lines = [
        head,
        `You have been assigned task #${String(body.taskId)}: ${escapeXml(body.subject)}`,
      ];
      if (body.description !== undefined && body.description.length > 0) {
        lines.push('', escapeXml(body.description));
      }
      lines.push(
        '',
        'Mark the task in_progress with TeamTaskUpdate when you start it, and completed when done.',
        '</teammate-message>',
      );
      return lines.join('\n');
    }
    case 'shutdown_request': {
      const reason =
        message.body.reason !== undefined ? `: ${escapeXml(message.body.reason)}` : '';
      return [
        head,
        `The leader requested your shutdown${reason}. Wrap up your current work and ` +
          'finish your summary now — this task will be stopped shortly.',
        '</teammate-message>',
      ].join('\n');
    }
    case 'shutdown_approved':
      return [
        head,
        `Teammate "${escapeXml(message.from)}" acknowledged your shutdown request and is stopping.`,
        '</teammate-message>',
      ].join('\n');
    case 'shutdown_rejected':
      return [
        head,
        `Teammate "${escapeXml(message.from)}" rejected your shutdown request${message.body.reason !== undefined ? `: ${escapeXml(message.body.reason)}` : ''}.`,
        '</teammate-message>',
      ].join('\n');
    case 'permission_request': {
      const inputPreview = JSON.stringify(message.body.input);
      return [
        head,
        `Teammate "${escapeXml(message.from)}" requests permission for ${escapeXml(message.body.toolName)}: ${escapeXml(message.body.description)}`,
        `request_id: ${message.body.requestId}`,
        `input: ${escapeXml(inputPreview.length > 800 ? `${inputPreview.slice(0, 800)}…(truncated)` : inputPreview)}`,
        '',
        `To answer, call SendMessage(to: "${escapeXml(message.from)}", message: {type: "permission_response", request_id: "${message.body.requestId}", approve: true|false, feedback: "optional reason"}).`,
        '</teammate-message>',
      ].join('\n');
    }
    case 'permission_response':
      return [
        head,
        `Permission request ${message.body.requestId} ${message.body.subtype === 'success' ? 'approved' : `rejected${message.body.error !== undefined ? `: ${escapeXml(message.body.error)}` : ''}`}.`,
        '</teammate-message>',
      ].join('\n');
  }
}

/** Cap on the wire preview of a mailbox activity event. */
const ACTIVITY_PREVIEW_CHARS = 120;

function previewLine(text: string): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return flat.length <= ACTIVITY_PREVIEW_CHARS
    ? flat
    : `${flat.slice(0, ACTIVITY_PREVIEW_CHARS)}…`;
}

/**
 * A short single-line, UI-ready summary of a mailbox envelope for the
 * `mailbox.activity` protocol event — read-only team viewers show this
 * instead of the full body (which stays in the inbox file).
 */
export function mailboxActivityPreview(message: MailboxMessage): string {
  switch (message.kind) {
    case 'message':
      return previewLine(message.body.summary ?? message.body.text);
    case 'task_assignment':
      return previewLine(`task #${String(message.body.taskId)}: ${message.body.subject}`);
    case 'shutdown_request':
      return previewLine(message.body.reason ?? '');
    case 'shutdown_approved':
    case 'shutdown_rejected':
      return previewLine(message.body.reason ?? message.body.requestId);
    case 'permission_request':
      return previewLine(`${message.body.toolName}: ${message.body.description}`);
    case 'permission_response':
      return message.body.subtype === 'success'
        ? previewLine(`approved ${message.body.requestId}`)
        : previewLine(`rejected ${message.body.requestId}${message.body.error !== undefined ? `: ${message.body.error}` : ''}`);
  }
}

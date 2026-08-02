/**
 * Teammate idle keep-alive, modeled on Claude Code's in-process runner main
 * loop. A teammate used to be "one prompt to completion": the run ended with
 * the prompt turn and anything posted afterwards waited for the next resume.
 * With the mailbox and the shared task list in place, a teamed teammate now
 * stays alive for a bounded idle window after its turn settles: while the
 * team still has claimable/assigned work or unread mailbox messages, the run
 * nudges a fresh turn so the teammate picks the work up instead of dying.
 *
 * This module holds the pure half — what counts as work and the nudge
 * text — so it is unit-testable without a Session; the loop itself lives in
 * `SessionSubagentHost` (it owns turns, signals, and the run lifecycle).
 *
 * What deliberately does NOT count as work: tasks the teammate already owns
 * in `in_progress` (the teammate just had its turn and left them that way —
 * maybe blocked, maybe done in spirit; re-nudging those would churn tokens
 * on a self-inflicted loop) and unread `shutdown_request` envelopes (the
 * per-run mailbox watcher owns the shutdown protocol: notice, grace window,
 * task stop — in every turn state). The next trigger for owned work is a
 * new message or a leader action, exactly as in CC.
 */

import type { MailboxMessage, MailboxStore } from './mailbox';
import type { TeamStore } from './team-store';
import type { TeammateIdentity } from './teammate-context';

/** Knobs for the keep-alive loop (`SessionOptions.teammate`). */
export interface TeammateKeepAliveOptions {
  /**
   * How long a settled teammate run waits for new team work before exiting
   * cleanly. `0` disables keep-alive (the run ends with the prompt turn).
   * Default
   * {@link DEFAULT_TEAMMATE_KEEP_ALIVE_IDLE_TIMEOUT_MS}.
   */
  readonly idleTimeoutMs?: number | undefined;
  /** Work-check poll cadence while idling. Default {@link DEFAULT_TEAMMATE_KEEP_ALIVE_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number | undefined;
}

/**
 * Bounded idle window: CC waits forever (its teammates are long-lived
 * peers); ours are still run-scoped background tasks, so a teammate with
 * nothing left to do exits cleanly after this long instead of holding the
 * task (and its per-run timeout) open.
 */
export const DEFAULT_TEAMMATE_KEEP_ALIVE_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** Matches the mailbox delivery poll cadence. */
export const DEFAULT_TEAMMATE_KEEP_ALIVE_POLL_INTERVAL_MS = 500;

/**
 * Consecutive nudges issued for an unchanged work signature before the loop
 * gives up: the work is still there but the model is not picking it up, so
 * waiting out the idle timeout would burn polls for nothing. New work
 * (a different signature) resets the counter.
 */
export const MAX_STAGNANT_NUDGES = 3;

export interface TeammateWork {
  /** Model-visible nudge text for the fresh turn. */
  readonly nudge: string;
  /**
   * Unread non-shutdown messages to inline into the nudge turn's prompt
   * (and mark read once the turn starts). Inlining is deliberate: steering
   * them through the per-run watcher would race the nudge turn — a fast
   * turn can end before the watcher's next poll, leaving the messages
   * unread and the loop re-nudging the same signature forever. Shutdown
   * requests are excluded: the watcher owns the shutdown protocol (grace
   * window + task stop) in every turn state.
   */
  readonly messages: readonly MailboxMessage[];
  /**
   * Stable fingerprint of the work that triggered this nudge (task ids +
   * unread message ids). Compared across loop iterations for the stagnation
   * guard.
   */
  readonly signature: string;
}

export function resolveKeepAliveOptions(options: TeammateKeepAliveOptions | undefined): {
  readonly idleTimeoutMs: number;
  readonly pollIntervalMs: number;
} {
  return {
    idleTimeoutMs:
      options?.idleTimeoutMs ?? DEFAULT_TEAMMATE_KEEP_ALIVE_IDLE_TIMEOUT_MS,
    pollIntervalMs:
      options?.pollIntervalMs ?? DEFAULT_TEAMMATE_KEEP_ALIVE_POLL_INTERVAL_MS,
  };
}

/**
 * The work a settled teammate should pick up, if any: unread mailbox
 * messages, tasks assigned to it but not yet started, and claimable
 * (pending, unowned) team tasks. `identity.teamName` must be defined.
 */
export async function findTeammateWork(
  teamStore: TeamStore,
  mailboxStore: MailboxStore,
  identity: TeammateIdentity,
): Promise<TeammateWork | undefined> {
  const teamName = identity.teamName;
  if (teamName === undefined) return undefined;
  const [unread, tasks] = await Promise.all([
    mailboxStore.unread(teamName, identity.name),
    teamStore.listTasks(teamName),
  ]);
  // Shutdown protocol traffic belongs to the watcher (see TeammateWork).
  const messages = unread.filter((message) => message.kind !== 'shutdown_request');
  const assigned = (tasks ?? []).filter(
    (task) => task.status === 'pending' && task.owner === identity.name,
  );
  const claimable = (tasks ?? []).filter(
    (task) => task.status === 'pending' && task.owner === undefined,
  );
  if (messages.length === 0 && assigned.length === 0 && claimable.length === 0) {
    return undefined;
  }

  const lines: string[] = [];
  if (messages.length > 0) {
    lines.push(
      `- ${String(messages.length)} unread mailbox message${messages.length === 1 ? '' : 's'} (attached below — read and act on ${messages.length === 1 ? 'it' : 'them'}).`,
    );
  }
  if (assigned.length > 0) {
    lines.push(
      `- ${assigned.length === 1 ? 'Task' : 'Tasks'} assigned to you, not yet started: ${assigned.map((task) => `#${String(task.id)} ${task.subject}`).join('; ')}. Mark in_progress with TeamTaskUpdate and work ${assigned.length === 1 ? 'it' : 'them'} to completion.`,
    );
  }
  if (claimable.length > 0) {
    lines.push(
      `- ${String(claimable.length)} unclaimed task${claimable.length === 1 ? '' : 's'} in the team queue. Claim the next one with TeamTaskClaim.`,
    );
  }
  const nudge = [
    'Your team has work for you after your last turn:',
    ...lines,
    'Pick it up now. If nothing here is actually actionable for you, say so to the leader with SendMessage and finish.',
  ].join('\n');

  const signature = [
    ...messages.map((message) => `m:${message.id}`),
    ...assigned.map((task) => `a:${String(task.id)}`),
    ...claimable.map((task) => `c:${String(task.id)}`),
  ].join('|');
  return { nudge, messages, signature };
}

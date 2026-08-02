/**
 * Mailbox — per-team inboxes and protocol message envelopes.
 *
 * On-disk layout: one inbox JSON per team member at
 * `<sessionDir>/teams/<team>/inboxes/<member>.json`, with a
 * per-message read index instead of a separate cursor file. The team leader
 * has a reserved inbox name ({@link LEADER_INBOX}) in every team so
 * teammates can address it without it being a roster member.
 *
 * Unlike the reference implementation (multi-process teammates + lockfile),
 * all writers here are in-process, so read-append-write races are serialized
 * by a per-inbox promise queue — the same divergence TeamStore documented
 * for the task list. Atomic crash safety still comes from the per-id JSON
 * store (temp + fsync + rename).
 *
 * Messages are protocol envelopes, not plain text: a discriminated union on
 * `kind` with a typed `body` per kind. Permission request/response bodies
 * are defined here; their producers and consumers live in the permission
 * bridge.
 */

import { join } from 'pathe';

import { createPerIdJsonStore, type PerIdJsonStore } from '../../utils/per-id-json-store';
import { generateBase36Id } from '../../utils/random-id';
import { TEAM_NAME_PATTERN } from './team-store';

/** Reserved inbox owner for the team's leader (the leader is not a roster member). */
export const LEADER_INBOX = 'leader';

const MEMBER_NAME_PATTERN = TEAM_NAME_PATTERN;

/** `msg_{8 base36 chars}` — same shape as background task ids. */
function generateMessageId(): string {
  return generateBase36Id('msg_');
}

// ── Protocol bodies ──────────────────────────────────────────────────

export interface PlainMessageBody {
  readonly text: string;
  /** 5-10 word preview for UI surfaces (optional). */
  readonly summary?: string | undefined;
}

export interface TaskAssignmentBody {
  readonly taskId: number;
  readonly subject: string;
  readonly description?: string | undefined;
  readonly assignedBy: string;
}

export interface ShutdownRequestBody {
  readonly requestId: string;
  readonly reason?: string | undefined;
}

/** shutdown_approved / shutdown_rejected share the verdict shape. */
export interface ShutdownVerdictBody {
  readonly requestId: string;
  readonly reason?: string | undefined;
}

/**
 * Permission-bridge schema (producer/consumer live in the bridge): a
 * teammate's tool-permission request to the leader. Field names align with
 * the SDK control-channel snake_case.
 */
export interface PermissionRequestBody {
  readonly requestId: string;
  readonly toolName: string;
  readonly toolUseId: string;
  readonly description: string;
  readonly input: Record<string, unknown>;
  readonly permissionSuggestions?: readonly unknown[] | undefined;
}

/** Permission-bridge schema: the leader's verdict on a permission request. */
export interface PermissionResponseBody {
  readonly requestId: string;
  readonly subtype: 'success' | 'error';
  readonly updatedInput?: Record<string, unknown> | undefined;
  readonly permissionUpdates?: readonly unknown[] | undefined;
  readonly error?: string | undefined;
}

interface MailboxMessageBase {
  /** Unique message id (`msg_xxxxxxxx`). */
  readonly id: string;
  /** Sender: a teammate name, or {@link LEADER_INBOX}. */
  readonly from: string;
  /** Recipient: a teammate name, or {@link LEADER_INBOX}. */
  readonly to: string;
  /** ISO-8601 creation time. */
  readonly createdAt: string;
  /** Read index: false until the recipient's delivery path has injected it. */
  readonly read: boolean;
}

export type MailboxMessage = MailboxMessageBase &
  (
    | { readonly kind: 'message'; readonly body: PlainMessageBody }
    | { readonly kind: 'task_assignment'; readonly body: TaskAssignmentBody }
    | { readonly kind: 'shutdown_request'; readonly body: ShutdownRequestBody }
    | { readonly kind: 'shutdown_approved'; readonly body: ShutdownVerdictBody }
    | { readonly kind: 'shutdown_rejected'; readonly body: ShutdownVerdictBody }
    | { readonly kind: 'permission_request'; readonly body: PermissionRequestBody }
    | { readonly kind: 'permission_response'; readonly body: PermissionResponseBody }
  );

export type MailboxMessageKind = MailboxMessage['kind'];
export type MailboxMessageBody = MailboxMessage['body'];

export interface OutboundMailboxMessage {
  readonly from: string;
  readonly to: string;
  readonly kind: MailboxMessageKind;
  readonly body: MailboxMessageBody;
}

interface InboxFile {
  readonly messages: MailboxMessage[];
}

/**
 * Inbox ring cap (background MAX_OUTPUT_BYTES pattern):
 * after each append an inbox keeps every UNREAD message plus the newest
 * `readHistoryLimit` read ones; older read messages are dropped so
 * long-lived teams don't grow inbox files forever. Unread messages — most
 * importantly unread `permission_request`/`shutdown_request` protocol
 * envelopes — are never dropped, regardless of the cap: dropping one would
 * strand the waiter the read-index semantics exist for.
 */
export const DEFAULT_INBOX_READ_HISTORY_LIMIT = 100;

export interface MailboxStoreOptions {
  /**
   * Newest read messages retained per inbox on append. Pass
   * `Number.POSITIVE_INFINITY` to disable pruning. Default
   * {@link DEFAULT_INBOX_READ_HISTORY_LIMIT}.
   */
  readonly readHistoryLimit?: number | undefined;
  /**
   * Fired synchronously after a message is persisted to an inbox. The
   * session turns this into the `mailbox.activity` protocol event for
   * read-only team viewers.
   */
  readonly onSend?:
    | ((teamName: string, message: MailboxMessage) => void)
    | undefined;
}

/**
 * Apply the ring cap: all unread messages + the newest `limit` read ones,
 * preserving chronological order. Returns the input when within budget.
 */
export function pruneInboxReadHistory(
  messages: readonly MailboxMessage[],
  limit: number,
): MailboxMessage[] {
  let readCount = 0;
  for (const message of messages) {
    if (message.read) readCount += 1;
  }
  if (readCount <= limit) return [...messages];
  // The newest `limit` read messages live at the tail: walk backwards to
  // find the index of the oldest read message to keep.
  let kept = 0;
  let firstKeptIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.read) {
      kept += 1;
      if (kept === limit) {
        firstKeptIndex = i;
        break;
      }
    }
  }
  const keptReadIds = new Set(
    messages.slice(firstKeptIndex).filter((message) => message.read).map((message) => message.id),
  );
  return messages.filter((message) => !message.read || keptReadIds.has(message.id));
}

/** Cheap structural guard for the per-id store's drop rules. */
function isInboxFile(obj: unknown): obj is InboxFile {
  if (typeof obj !== 'object' || obj === null) return false;
  const record = obj as Record<string, unknown>;
  return Array.isArray(record['messages']);
}

/**
 * Persistence for team inboxes. One store per session; per-team per-id
 * stores are created lazily. All mutations of one inbox are serialized
 * through its own promise queue (see the module header for the lockfile
 * divergence note).
 */
export class MailboxStore {
  private readonly stores = new Map<string, PerIdJsonStore<InboxFile>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /**
   * Read-through cache, mirroring TeamStore's: the per-inbox mutation queue
   * is the only writer (all writers are in-process — see the module header),
   * so cached contents stay fresh between mutations and poll watchers no
   * longer re-read and re-parse the inbox file on every tick. Missing inboxes
   * are cached as `undefined` too; a later `send` creates the file through
   * `mutate`, which updates the cache on the same write.
   */
  private readonly inboxCache = new Map<string, InboxFile | undefined>();
  private readonly readHistoryLimit: number;
  private readonly onSend: ((teamName: string, message: MailboxMessage) => void) | undefined;

  constructor(
    private readonly sessionDir: string,
    options: MailboxStoreOptions = {},
  ) {
    this.readHistoryLimit = options.readHistoryLimit ?? DEFAULT_INBOX_READ_HISTORY_LIMIT;
    this.onSend = options.onSend;
  }

  /**
   * Append a message to the recipient's inbox. The inbox file is created on
   * first write; the ring cap ({@link MailboxStoreOptions.readHistoryLimit})
   * prunes old read messages on the same write. Returns the stored envelope
   * (with id/timestamp/read index).
   */
  async send(teamName: string, message: OutboundMailboxMessage): Promise<MailboxMessage> {
    const envelope = await this.mutate(teamName, message.to, (current) => {
      const stored: MailboxMessage = {
        ...message,
        id: generateMessageId(),
        createdAt: new Date().toISOString(),
        read: false,
      } as MailboxMessage;
      const next: InboxFile = {
        messages: pruneInboxReadHistory(
          [...(current?.messages ?? []), stored],
          this.readHistoryLimit,
        ),
      };
      return { file: next, result: stored };
    });
    this.onSend?.(teamName, envelope);
    return envelope;
  }

  /** Every message in a member's inbox, oldest first. Missing inbox → []. */
  async inbox(teamName: string, member: string): Promise<readonly MailboxMessage[]> {
    return (await this.read(teamName, member))?.messages ?? [];
  }

  /** Unread messages only, oldest first. */
  async unread(teamName: string, member: string): Promise<readonly MailboxMessage[]> {
    return (await this.inbox(teamName, member)).filter((message) => !message.read);
  }

  /** Advance the read index over the given message ids. No-op for unknown ids. */
  async markRead(teamName: string, member: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    await this.mutate(teamName, member, (current) => {
      if (current === undefined) return { file: current, result: undefined };
      const next: InboxFile = {
        messages: current.messages.map((message) =>
          idSet.has(message.id) ? { ...message, read: true } : message,
        ),
      };
      return { file: next, result: undefined };
    });
  }

  // ── internals ──────────────────────────────────────────────────────

  private inboxStore(teamName: string): PerIdJsonStore<InboxFile> {
    if (!TEAM_NAME_PATTERN.test(teamName)) {
      throw new Error(`Invalid team name: "${teamName}"`);
    }
    let store = this.stores.get(teamName);
    if (store === undefined) {
      store = createPerIdJsonStore<InboxFile>({
        rootDir: this.sessionDir,
        subdir: join('teams', teamName, 'inboxes'),
        idRegex: MEMBER_NAME_PATTERN,
        isValid: isInboxFile,
        entityName: 'member name',
      });
      this.stores.set(teamName, store);
    }
    return store;
  }

  private async read(teamName: string, member: string): Promise<InboxFile | undefined> {
    const store = this.inboxStore(teamName);
    const key = `${teamName}/${member}`;
    if (this.inboxCache.has(key)) return this.inboxCache.get(key);
    const fromDisk = await store.read(member);
    this.inboxCache.set(key, fromDisk);
    return fromDisk;
  }

  /** Serialize one read-append-write per inbox; the queue survives failures. */
  private mutate<T>(
    teamName: string,
    member: string,
    fn: (current: InboxFile | undefined) => { file: InboxFile | undefined; result: T },
  ): Promise<T> {
    const key = `${teamName}/${member}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(async () => {
      const current = await this.read(teamName, member);
      const { file, result } = fn(current);
      if (file !== undefined && file !== current) {
        await this.inboxStore(teamName).write(member, file);
        this.inboxCache.set(key, file);
      }
      return result;
    });
    this.queues.set(key, next.catch(() => {}));
    return next;
  }
}

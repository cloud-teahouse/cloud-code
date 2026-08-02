import type {
  ApprovalRequest,
  ApprovalResponse,
  Event,
  QuestionRequest,
  QuestionResult,
  RPCMethods,
  SDKAPI,
  ToolCallRequest,
  ToolCallResponse,
} from '@cloud-code/agent-core';
import type { ResyncRequiredParams, SessionCursor } from '@cloud-code/protocol';

import type { EventJournal, JournalCursor } from './event-journal';

type SessionScoped<T> = T & { readonly sessionId: string; readonly agentId: string };

/**
 * The bridge-side endpoint of one client connection, as seen by the
 * multiplexer. Implemented by `BridgeConnection`.
 */
export interface ReverseRpcConnection {
  readonly closed: boolean;
  /** Fire-and-forget event notification; `cursor` rides on durable events. */
  sendEvent(event: Event, cursor?: JournalCursor): void;
  /**
   * Tell the connection its resume cursor could not be honored (ws-control
   * resync semantics); it must rebuild state from a resumeSession snapshot.
   */
  sendResyncRequired(params: ResyncRequiredParams): void;
  requestApproval(request: SessionScoped<ApprovalRequest>): Promise<ApprovalResponse>;
  requestQuestion(request: SessionScoped<QuestionRequest>): Promise<QuestionResult>;
  toolCall(request: SessionScoped<ToolCallRequest>): Promise<ToolCallResponse>;
}

/**
 * Connection fan-out adapter in front of the core's single `SDKRPC` handle.
 *
 * `CloudCodeCore` accepts exactly one reverse-RPC handle; with several client
 * connections attached, this multiplexer routes each reverse call to the
 * right one:
 *
 *  - Events fan out to every connection subscribed to `event.sessionId`.
 *  - `requestApproval` / `requestQuestion` / `toolCall` route to the
 *    connection that OWNS the session. Routing is keyed by `sessionId`,
 *    never `agentId`: a subagent's approval request carries the subagent's
 *    agentId but must still reach the connection owning its session
 *    (design §6.3).
 *  - With no owning connection (or a dead one), calls fail closed with the
 *    same semantics as the in-process "no handler registered" path
 *    (approval→cancelled, question→null, toolCall→isError).
 *
 * Ownership: the latest `createSession`/`resumeSession`/`reloadSession`/
 * `forkSession` on a connection claims the session for that connection;
 * subscriptions are additive (a second client attaching a session receives
 * its events too).
 */
export class SdkMultiplexer {
  private readonly owners = new Map<string, ReverseRpcConnection>();
  private readonly subscribers = new Map<string, Set<ReverseRpcConnection>>();

  constructor(private readonly journal?: EventJournal) {}

  /** Claim session ownership for a connection and subscribe it to events. */
  claimSession(sessionId: string, connection: ReverseRpcConnection): void {
    this.owners.set(sessionId, connection);
    this.subscribe(sessionId, connection);
  }

  /**
   * Subscribe a connection to a session's event stream. With a resume
   * `cursor` and a journal, missed durable events are replayed first —
   * atomically with the subscription, so live events can neither overtake
   * nor duplicate the replay; a stale cursor yields `resync_required`
   * (ws-control cursor semantics, design §4 v2).
   */
  subscribe(sessionId: string, connection: ReverseRpcConnection, cursor?: SessionCursor): void {
    const set = this.subscribers.get(sessionId) ?? new Set<ReverseRpcConnection>();
    set.add(connection);
    this.subscribers.set(sessionId, set);
    if (cursor === undefined || this.journal === undefined) return;
    const replay = this.journal.replay(sessionId, cursor);
    if (replay.status === 'resync_required') {
      connection.sendResyncRequired({
        sessionId,
        reason: replay.reason,
        currentSeq: replay.cursor.seq,
        epoch: replay.cursor.epoch,
      });
      return;
    }
    for (const entry of replay.entries) {
      connection.sendEvent(entry.event, { seq: entry.seq, epoch: replay.cursor.epoch });
    }
  }

  /**
   * Drop all state for a session that no longer exists (closed or deleted).
   *
   * Unlike {@link releaseConnection}, which reacts to a connection going away
   * and deliberately keeps the journal so a reconnect can replay, this is the
   * end of the session itself: its retained events are dead weight, and a
   * later cursor for it correctly resyncs.
   */
  forgetSession(sessionId: string): void {
    this.owners.delete(sessionId);
    this.subscribers.delete(sessionId);
    this.journal?.forgetSession(sessionId);
  }

  /** Drop all ownership/subscription state held by a (closed) connection. */
  releaseConnection(connection: ReverseRpcConnection): void {
    for (const [sessionId, owner] of this.owners) {
      if (owner === connection) this.owners.delete(sessionId);
    }
    for (const [sessionId, set] of this.subscribers) {
      set.delete(connection);
      if (set.size === 0) this.subscribers.delete(sessionId);
    }
  }

  ownerOf(sessionId: string): ReverseRpcConnection | undefined {
    return this.owners.get(sessionId);
  }

  /** `SDKAPI.emitEvent` — journal, then fan out to the session's subscribers. */
  readonly emitEvent = (event: Event): void => {
    // Journaling happens before fan-out, so a connection that (re)subscribes
    // with a cursor never sees seq N live and then again in a replay.
    const cursor = this.journal?.append(event);
    const targets = this.subscribers.get(event.sessionId);
    if (targets === undefined) return;
    for (const connection of targets) {
      connection.sendEvent(event, cursor);
    }
  };

  readonly requestApproval = (
    request: SessionScoped<ApprovalRequest>,
  ): Promise<ApprovalResponse> => {
    const owner = this.owners.get(request.sessionId);
    if (owner === undefined || owner.closed) {
      return Promise.resolve({
        decision: 'cancelled',
        feedback: 'No approval handler registered.',
      });
    }
    return owner.requestApproval(request);
  };

  readonly requestQuestion = (
    request: SessionScoped<QuestionRequest>,
  ): Promise<QuestionResult> => {
    const owner = this.owners.get(request.sessionId);
    if (owner === undefined || owner.closed) {
      return Promise.resolve(null);
    }
    return owner.requestQuestion(request);
  };

  readonly toolCall = (request: SessionScoped<ToolCallRequest>): Promise<ToolCallResponse> => {
    const owner = this.owners.get(request.sessionId);
    if (owner === undefined || owner.closed) {
      return Promise.resolve({
        output: `SDK custom tool calls are not supported: ${request.toolCallId}`,
        isError: true,
      });
    }
    return owner.toolCall(request);
  };

  /** The reverse-RPC handle handed to `CloudCodeCore` at construction. */
  asSdkRpc(): RPCMethods<SDKAPI> {
    return this as unknown as RPCMethods<SDKAPI>;
  }
}

/**
 * Base class for promise-based reverse RPC dialog controllers.
 *
 * Approval and question flows wait for a UI action before returning a response.
 * Subclasses only need to define the default cancellation response.
 *
 * When concurrent requests arrive (e.g. multiple parallel subagents each
 * needing approval), only one panel is shown at a time; additional requests
 * are queued in arrival order and advance after the current one resolves.
 */

export interface ReverseRpcUIHooks<TPayload> {
  showPanel(payload: TPayload): void;
  hidePanel(): void;
}

interface Pending<TPayload, TResponse> {
  readonly payload: TPayload;
  readonly resolve: (data: TResponse) => void;
}

/**
 * Window after the user's last panel interaction during which a programmatic
 * resolver (`tryAutoResolveCurrent`) must back off. Mirrors Claude Code's
 * `onUserInteraction()` guard: an async auto-approver (e.g. a classifier
 * resolving late) must never yank the dialog out from under the user's
 * cursor.
 */
export const USER_INTERACTION_GUARD_MS = 2_000;

export abstract class ReverseRpcController<TPayload, TResponse> {
  private uiHooks: ReverseRpcUIHooks<TPayload> | null = null;
  private current: Pending<TPayload, TResponse> | null = null;
  private queue: Array<Pending<TPayload, TResponse>> = [];
  private lastUserInteractionAt = 0;

  setUIHooks(hooks: ReverseRpcUIHooks<TPayload>): void {
    this.uiHooks = hooks;
  }

  /**
   * Called when a reverse RPC request arrives from core. The returned promise
   * resolves after the user responds or `cancelAll` forces cancellation.
   */
  show(payload: TPayload): Promise<TResponse> {
    return new Promise<TResponse>((resolve) => {
      const entry: Pending<TPayload, TResponse> = { payload, resolve };
      if (this.current === null) {
        this.current = entry;
        // A freshly shown panel has no interaction yet — the guard window
        // starts with the user's first keystroke on it.
        this.lastUserInteractionAt = 0;
        this.uiHooks?.showPanel(payload);
      } else {
        this.queue.push(entry);
      }
    });
  }

  /**
   * Panels report engagement here (arrow-key navigation, feedback typing) so
   * programmatic resolvers can tell the user is actively working the dialog.
   */
  noteUserInteraction(): void {
    if (this.current === null) return;
    this.lastUserInteractionAt = Date.now();
  }

  hasRecentUserInteraction(windowMs: number = USER_INTERACTION_GUARD_MS): boolean {
    return this.lastUserInteractionAt !== 0 && Date.now() - this.lastUserInteractionAt < windowMs;
  }

  /**
   * Resolve the visible request without a user decision — the entry point for
   * async auto-approval. Refuses (returns false, request stays pending) while
   * the user has interacted with the panel within the guard window; callers
   * that race the user must defer or give up, never force-close the dialog.
   */
  tryAutoResolveCurrent(data: TResponse, windowMs?: number): boolean {
    if (this.current === null || this.hasRecentUserInteraction(windowMs)) return false;
    this.respond(data);
    return true;
  }

  /** Called by the UI after the user makes a panel choice. */
  respond(data: TResponse): void {
    const pending = this.current;
    this.current = null;
    this.lastUserInteractionAt = 0;
    pending?.resolve(data);
    if (pending !== null) {
      this.drainAutoResolved(pending.payload, data);
    }
    this.advanceOrHide();
  }

  /** Cancels all pending requests during shutdown or session switches. */
  cancelAll(reason: string): void {
    const all = [...(this.current === null ? [] : [this.current]), ...this.queue];
    this.current = null;
    this.queue = [];
    this.uiHooks?.hidePanel();
    for (const entry of all) {
      entry.resolve(this.createCancelResponse(reason));
    }
  }

  hasPending(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  private advanceOrHide(): void {
    const next = this.queue.shift();
    if (next === undefined) {
      this.uiHooks?.hidePanel();
      return;
    }
    this.current = next;
    this.uiHooks?.showPanel(next.payload);
  }

  private drainAutoResolved(resolvedPayload: TPayload, response: TResponse): void {
    const remaining: Array<Pending<TPayload, TResponse>> = [];
    for (const entry of this.queue) {
      const auto = this.autoResolveFor(resolvedPayload, response, entry.payload);
      if (auto === undefined) {
        remaining.push(entry);
      } else {
        entry.resolve(auto);
      }
    }
    this.queue = remaining;
  }

  /**
   * Subclasses override to short-circuit queued requests when an answer to the
   * just-resolved one (e.g. an approve-for-session) implies the same answer
   * for matching queued requests. Return `undefined` to leave the queued
   * request waiting for its own panel turn.
   */
  protected autoResolveFor(
    _resolvedPayload: TPayload,
    _response: TResponse,
    _queuedPayload: TPayload,
  ): TResponse | undefined {
    return undefined;
  }

  protected abstract createCancelResponse(reason: string): TResponse;
}

/**
 * TeammateContext — runtime context for in-process teammates.
 *
 * In-process teammates share the leader's Node process, so AsyncLocalStorage
 * provides the per-teammate identity isolation that process-based teammates
 * get from env vars. Any code in the call stack can answer "am I inside a
 * teammate, and which one" without threading identity through every
 * signature.
 *
 * The context is established per run by the subagent host (spawn, resume,
 * and retry all wrap the child run), so everything a teammate does — turns,
 * tool dispatches, hooks — inherits its scope. Concurrent teammates never
 * see each other's context: each `runWithTeammateContext` scopes its own
 * async tree.
 *
 * Consumers:
 * - Topology guards key off the identity (see
 *   `TeammateSpawnDenyPermissionPolicy`, which reads the same identity via
 *   the agent-instance latch so out-of-scope dispatch paths stay covered).
 * - Mailbox addressing and the permission bridge read
 *   `getTeammateContext()` directly.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Stable teammate identity: a display name plus the team it belongs to.
 * Persisted in the session agent metadata so resume/retry runs (and
 * restored sessions) re-establish the same identity.
 */
export interface TeammateIdentity {
  /** Display name, e.g. "researcher". Unique within a team by convention. */
  readonly name: string;
  /** Team this teammate belongs to, when spawned into one. */
  readonly teamName?: string | undefined;
}

/**
 * Runtime context for an in-process teammate, stored in AsyncLocalStorage.
 */
export interface TeammateContext extends TeammateIdentity {
  /** Agent id of the teammate's child agent instance. */
  readonly agentId: string;
  /** Agent id of the leader that spawned this teammate. */
  readonly parentAgentId: string;
  /**
   * Lifecycle handle for the teammate's current run: aborted when the
   * backing background task is stopped/killed (and on leader cancel of a
   * foreground run). Teammate-side waiters should race this signal rather
   * than waiting unboundedly.
   */
  readonly abortController: AbortController;
  /** Discriminator — always true for in-process teammates. */
  readonly isInProcess: true;
}

const teammateContextStorage = new AsyncLocalStorage<TeammateContext>();

/**
 * The current in-process teammate context, or undefined when the call stack
 * does not belong to a teammate.
 */
export function getTeammateContext(): TeammateContext | undefined {
  return teammateContextStorage.getStore();
}

/** True when the current call stack runs inside an in-process teammate. */
export function isInProcessTeammate(): boolean {
  return teammateContextStorage.getStore() !== undefined;
}

/**
 * Run `fn` with `context` installed as the active teammate context. All
 * async work scheduled from within `fn` (directly or through continuations)
 * observes the same context; the previous scope is restored when `fn`
 * returns.
 */
export function runWithTeammateContext<T>(context: TeammateContext, fn: () => T): T {
  return teammateContextStorage.run(context, fn);
}

/** Build a TeammateContext from spawn/run configuration. */
export function createTeammateContext(config: {
  readonly agentId: string;
  readonly parentAgentId: string;
  readonly name: string;
  readonly teamName?: string | undefined;
  readonly abortController: AbortController;
}): TeammateContext {
  return {
    agentId: config.agentId,
    parentAgentId: config.parentAgentId,
    name: config.name,
    teamName: config.teamName,
    abortController: config.abortController,
    isInProcess: true,
  };
}

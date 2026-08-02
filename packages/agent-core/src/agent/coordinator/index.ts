import type { Agent } from '..';

import COORDINATOR_MODE_PROMPT from './prompt.md?raw';

/**
 * Coordinator mode: a session-level mode switch, not a tool.
 * While active, the main thread's system prompt is role-rewritten into an
 * orchestrator of background workers through the append bus — Claude Code's
 * `coordinator` branch of the system-prompt override priority
 * (override > coordinator > agent > custom > default) mapped onto the
 * addendum mechanism.
 *
 * Why the append bus and not a profile switch: the addendum is a tail
 * section (`append:coordinator-mode`, `cache: 'dynamic'`), so entering the
 * mode mid-session busts only the prompt tail — the static prefix (and its
 * provider cache) survives. It is also exactly reversible (`clearAddendum`)
 * without re-rendering the profile, and the bus is session-owned in the same
 * way the mode is: `restoreEnter` re-registers the addendum on resume, per
 * the bus contract documented in `system-prompt-assembly.ts`.
 *
 * The mode is main-thread-only: subagents never coordinate (a worker's
 * spawn of further workers is denied by
 * `CoordinatorWorkerSpawnDenyPermissionPolicy`, keeping the agent graph two
 * levels deep).
 */
export const COORDINATOR_MODE_ADDENDUM_ID = 'coordinator-mode';

export class CoordinatorMode {
  protected active = false;

  constructor(protected readonly agent: Agent) {}

  enter(): void {
    if (this.active) return;
    this.agent.records.logRecord({ type: 'coordinator_mode.enter' });
    this.active = true;
    this.applyPromptAddendum();
    this.agent.emitStatusUpdated();
  }

  /**
   * Records-replay half of {@link enter}: restore the flag and re-register
   * the addendum with the bus (membership is session-owned and does not
   * persist on its own; the joined prompt does). No record is written —
   * replay must not append.
   */
  restoreEnter(): void {
    this.active = true;
    this.applyPromptAddendum();
  }

  exit(): void {
    if (!this.active) return;
    this.agent.records.logRecord({ type: 'coordinator_mode.exit' });
    this.active = false;
    this.agent.clearSystemPromptAddendum(COORDINATOR_MODE_ADDENDUM_ID);
    this.agent.emitStatusUpdated();
  }

  restoreExit(): void {
    this.active = false;
    this.agent.clearSystemPromptAddendum(COORDINATOR_MODE_ADDENDUM_ID);
  }

  get isActive(): boolean {
    return this.active;
  }

  private applyPromptAddendum(): void {
    this.agent.setSystemPromptAddendum(COORDINATOR_MODE_ADDENDUM_ID, COORDINATOR_MODE_PROMPT);
  }
}

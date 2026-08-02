import { formatTaskList } from '#/tools/background/task-list';

import type { Agent } from '..';
import { BehaviorRemindersInjector } from './behavior-reminders';
import { GoalInjector } from './goal';
import type { DynamicInjector } from './injector';
import { PermissionModeInjector } from './permission-mode';
import { PluginSessionStartInjector } from './plugin-session-start';
import { PlanModeInjector } from './plan-mode';
import { renderReminder } from './reminder';
import { SkillActivationInjector } from './skill-activation';
import { TodoListReminderInjector } from './todo-list';
import { ToolsDiffInjector } from './tools-diff';

// Standard tier, prohibition last (recency): the guidance comes first, the
// "do not" closes the prose; the task table rides after it as a data
// attachment (see injection/reminder.ts).
const ACTIVE_BACKGROUND_TASK_REMINDER = renderReminder({
  authority: 'standard',
  body:
    'The conversation was compacted, so the earlier messages that started these background ' +
    'tasks are gone — but the tasks are still running from before. Use TaskList to list them, ' +
    'TaskOutput for a non-blocking status/output snapshot, and TaskStop to cancel one — ' +
    'completion arrives via automatic notification.',
  prohibition: 'Do not start duplicates.',
});

export class InjectionManager {
  private readonly injectors: DynamicInjector[];
  // Goal context is injected at continuation boundaries (turn start, each
  // continuation, after compaction) via `injectGoal()`, NOT in the per-step
  // `inject()` loop. Boundary-cadence append-only injection keeps one fresh copy
  // near the tail without mutating the prefix, so prompt caching is preserved and
  // the context does not grow O(n^2) the way per-step injection did.
  private readonly goalInjector: GoalInjector | null;
  // Same boundary cadence, but NOT main-only: subagents announce their own
  // loadable tool set. See ToolsDiffInjector for why it also diverges on origin.
  private readonly toolsDiffInjector: ToolsDiffInjector;
  // `paths`-gated skill activation: immediate announcements on tool results
  // plus boundary catch-up. Also not main-only — a subagent's touch activates
  // skills in the session-shared registry.
  private readonly skillActivationInjector: SkillActivationInjector;
  // Long-conversation behavioral-rule re-injection: turn-boundary (interval)
  // plus forced post-compaction. See BehaviorRemindersInjector.
  private readonly behaviorRemindersInjector: BehaviorRemindersInjector;

  constructor(protected readonly agent: Agent) {
    this.injectors = [
      new PluginSessionStartInjector(agent),
      new TodoListReminderInjector(agent),
      new PlanModeInjector(agent),
      new PermissionModeInjector(agent),
    ];
    this.goalInjector = agent.type === 'main' ? new GoalInjector(agent) : null;
    this.toolsDiffInjector = new ToolsDiffInjector(agent);
    this.skillActivationInjector = new SkillActivationInjector(agent);
    this.behaviorRemindersInjector = new BehaviorRemindersInjector(agent);
  }

  async inject(): Promise<void> {
    for (const injector of this.injectors) {
      await injector.inject();
    }
  }

  /**
   * Appends a fresh goal-context reminder at a continuation boundary. Append-only
   * (never mutates the prefix) so prompt caching is preserved; no-ops when goal
   * mode is off, the agent is not the main agent, or there is nothing to inject.
   */
  async injectGoal(): Promise<void> {
    await this.activeGoalInjector()?.inject();
  }

  /**
   * Appends a loadable-tools diff announcement when the loadable set changed.
   * Boundary cadence (turn start + post-compaction); no-op when the disclosure
   * gate is closed or nothing changed.
   */
  injectToolsDiff(): void {
    this.toolsDiffInjector.inject();
  }

  /**
   * Tool-result hook for `paths`-gated skills: activate any whose patterns
   * match the touched paths and announce them at the message-stream tail.
   * No-op when no conditional skills are pending or nothing new matched.
   */
  activatePathSkillsForToolResult(toolName: string, args: unknown): void {
    this.skillActivationInjector.activateForToolResult(toolName, args);
  }

  /**
   * Boundary catch-up for skill activations (turn start + post-compaction):
   * heals undo/compaction/resume/sibling-agent gaps. See SkillActivationInjector.
   */
  injectSkillActivation(): void {
    this.skillActivationInjector.inject();
  }

  /**
   * Long-conversation behavioral-rule re-injection, boundary cadence (turn
   * start). Append-only, interval-gated, no-op when `[behavior_reminders]`
   * is disabled. See BehaviorRemindersInjector.
   */
  injectBehaviorReminders(): void {
    this.behaviorRemindersInjector.injectAtTurnBoundary();
  }

  async injectAfterCompaction(): Promise<void> {
    await this.injectGoal();
    this.injectToolsDiff();
    this.injectSkillActivation();
    this.injectActiveBackgroundTasks();
    await this.inject();
    // Forced post-compaction re-injection: the behavioral rules anchor lands
    // last so it closes the re-injected tail (recency position).
    this.behaviorRemindersInjector.injectAfterCompaction();
  }

  /**
   * Post-compaction only: re-surface still-running background tasks. Folding the
   * live context to [recent user prompts, summary] drops the messages that
   * started them and their status updates, so without this the model can forget
   * a task is running and spawn a duplicate. Appended as an `injection`-origin
   * reminder, so the next compaction drops and rebuilds it — kept fresh, never
   * stacked. Runs only on the live path: restore replays the persisted reminder
   * and `FullCompaction.begin` short-circuits before compaction there.
   */
  private injectActiveBackgroundTasks(): void {
    const tasks = this.agent.background.list(true);
    if (tasks.length === 0) return;
    this.agent.context.appendSystemReminder(
      `${ACTIVE_BACKGROUND_TASK_REMINDER}\n\n${formatTaskList(tasks, true)}`,
      { kind: 'injection', variant: 'background_task_status' },
    );
  }

  onContextClear(): void {
    for (const injector of this.lifecycleInjectors()) {
      injector.onContextClear();
    }
  }

  onContextCompacted(): void {
    for (const injector of this.lifecycleInjectors()) {
      try {
        injector.onContextCompacted();
      } catch {
        continue;
      }
    }
  }

  onContextMessageRemoved(index: number): void {
    for (const injector of this.lifecycleInjectors()) {
      injector.onContextMessageRemoved(index);
    }
  }

  /** Per-step injectors plus the boundary goal injector, for lifecycle events. */
  private lifecycleInjectors(): DynamicInjector[] {
    const goalInjector = this.activeGoalInjector();
    return goalInjector === null ? this.injectors : [goalInjector, ...this.injectors];
  }

  private activeGoalInjector(): GoalInjector | null {
    return this.goalInjector;
  }
}

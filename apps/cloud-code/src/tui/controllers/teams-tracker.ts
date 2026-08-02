/**
 * TeamTracker — pure, UI-free aggregator for the `/teams` browser
 * (read-only team/mailbox views).
 *
 * Fed with every session event from `SessionEventHandler.handleEvent`
 * (same attach point as `WorkflowTracker`), it maintains:
 *  - the latest snapshot of every team seen this session (roster + shared
 *    task list) from `team.updated` events — snapshots are full-state, so
 *    the latest one wins, no merging;
 *  - a tail-capped ring of recent mailbox activity across all teams from
 *    `mailbox.activity` events, deduplicated by message id (durable events
 *    can be replayed after a reconnect).
 *
 * Member liveness is NOT tracked here: it already flows on the task events
 * (`AgentTaskInfo.teammate`) into `SessionEventHandler.backgroundTasks`;
 * the browser controller joins the two at render time.
 *
 * The tracker is intentionally session-agnostic: it knows nothing about
 * `Session`, theming or i18n, which keeps it trivially unit-testable.
 */

import type { Event, MailboxActivityMessage, TeamWire } from '@cloud-code/sdk';

export type { TeamTaskWire, TeamWire } from '@cloud-code/sdk';

/** How many mailbox activity entries are kept across all teams. */
export const MAX_TEAM_ACTIVITY_ENTRIES = 50;

export class TeamTracker {
  private readonly teams = new Map<string, TeamWire>();
  private readonly activityIds = new Set<string>();
  private activity: MailboxActivityMessage[] = [];
  private readonly listeners = new Set<() => void>();

  reset(): void {
    this.teams.clear();
    this.activityIds.clear();
    this.activity = [];
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Team snapshots in first-seen order. */
  getTeams(): readonly TeamWire[] {
    return [...this.teams.values()];
  }

  getTeam(name: string): TeamWire | undefined {
    return this.teams.get(name);
  }

  /** Recent mailbox activity, oldest first; filtered by team when given. */
  getActivity(teamName?: string): readonly MailboxActivityMessage[] {
    if (teamName === undefined) return this.activity;
    return this.activity.filter((entry) => entry.teamName === teamName);
  }

  handleEvent(event: Event): void {
    switch (event.type) {
      case 'team.updated': {
        // Full-state snapshot: the latest one wins outright.
        this.teams.set(event.team.name, event.team);
        this.notify();
        return;
      }
      case 'mailbox.activity': {
        const message = event.message;
        // Durable events replay after a reconnect — keep each id once.
        if (this.activityIds.has(message.id)) return;
        this.activityIds.add(message.id);
        this.activity.push(message);
        if (this.activity.length > MAX_TEAM_ACTIVITY_ENTRIES) {
          const dropped = this.activity.splice(0, this.activity.length - MAX_TEAM_ACTIVITY_ENTRIES);
          for (const entry of dropped) this.activityIds.delete(entry.id);
        }
        this.notify();
        return;
      }
      default:
        return;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

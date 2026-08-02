/**
 * TeamsBrowserController — mounts/closes the `/teams` overlay and keeps it
 * live (read-only team/mailbox views). Mirrors the
 * workflows-browser controller: data comes from the `TeamTracker` attached
 * to the session event stream (see `session-event-handler.ts`); the
 * controller pushes a fresh snapshot on every tracker change and joins
 * member liveness from the background-task map (`AgentTaskInfo.teammate`)
 * on each repaint. A 1s tick is unnecessary — the view has no elapsed-time
 * readouts — so tracker notifications are the only live-push path.
 */

import type { BackgroundTaskInfo } from '@cloud-code/sdk';
import type { Component, ProcessTerminal, TUI } from '@cloud-code/pi-tui';

import type { EditorSlotContainer } from '../components/chrome/gutter-container';
import { TeamsBrowserApp } from '../components/dialogs/teams-browser';
import type { CustomEditor } from '../components/editor/custom-editor';
import type { TeamTracker } from './teams-tracker';

export interface TeamsBrowserHost {
  readonly state: {
    readonly teamsBrowser: TeamsBrowserState | undefined;
    readonly terminal: ProcessTerminal;
    readonly ui: TUI;
    readonly editor: CustomEditor;
    readonly editorContainer: EditorSlotContainer;
  };
  readonly teamTracker: TeamTracker;
  readonly backgroundTasks: ReadonlyMap<string, BackgroundTaskInfo>;
  /** True while a blocking panel (approval/question) owns the editor slot. */
  hasBlockingEditorSlotPanel(): boolean;
  setTeamsBrowser(value: TeamsBrowserState | undefined): void;
}

export interface TeamsBrowserState {
  component: TeamsBrowserApp;
  savedChildren: readonly Component[];
  selectedTeamName: string | undefined;
  unsubscribe: () => void;
}

export class TeamsBrowserController {
  constructor(private readonly host: TeamsBrowserHost) {}

  show(): void {
    const { state } = this.host;
    if (state.teamsBrowser !== undefined) return;
    // A takeover hides the whole layout tree; it must never cover a blocking
    // panel (its unanswered RPC would have no visible UI). See
    // docs/tui-modal-surfaces.md for the blocking-surface invariant.
    if (this.host.hasBlockingEditorSlotPanel()) return;

    const tracker = this.host.teamTracker;
    const teams = tracker.getTeams();
    const selectedTeamName = teams[0]?.name;

    const component = new TeamsBrowserApp(
      {
        teams,
        activity: tracker.getActivity(),
        memberLiveness: this.buildMemberLiveness(),
        selectedTeamName,
        onSelect: (teamName) => {
          this.handleSelect(teamName);
        },
        onCancel: () => {
          this.close();
        },
      },
      state.terminal,
    );

    const savedChildren = [...state.ui.children];
    state.ui.clear();
    state.ui.addChild(component);
    state.ui.setFocus(component);
    state.ui.requestRender(true);

    const unsubscribe = tracker.subscribe(() => {
      this.repaint();
    });

    this.host.setTeamsBrowser({
      component,
      savedChildren,
      selectedTeamName,
      unsubscribe,
    });
  }

  close(): void {
    const { state } = this.host;
    const browser = state.teamsBrowser;
    if (browser === undefined) return;

    browser.unsubscribe();

    state.ui.clear();
    for (const child of browser.savedChildren) {
      state.ui.addChild(child);
    }
    this.host.setTeamsBrowser(undefined);
    // Focus returns to the surface beneath the takeover: the slot's current
    // content (a mounted panel, or the editor) — not blindly the editor, which
    // may have been swapped out for a panel while the takeover was open.
    state.ui.setFocus(state.editorContainer.children[0] ?? state.editor);
    // Takeover close: repaint the viewport in place so the session's native
    // scrollback survives (a destructive full clear would wipe it).
    state.ui.requestCollapseRender();
  }

  repaint(): void {
    const { state } = this.host;
    const browser = state.teamsBrowser;
    if (browser === undefined) return;

    const tracker = this.host.teamTracker;
    const teams = tracker.getTeams();
    if (
      browser.selectedTeamName !== undefined &&
      !teams.some((team) => team.name === browser.selectedTeamName)
    ) {
      browser.selectedTeamName = teams[0]?.name;
    }
    browser.component.setProps({
      teams,
      activity: tracker.getActivity(),
      memberLiveness: this.buildMemberLiveness(),
      selectedTeamName: browser.selectedTeamName,
      onSelect: (teamName) => {
        this.handleSelect(teamName);
      },
      onCancel: () => {
        this.close();
      },
    });
    state.ui.requestRender();
  }

  private handleSelect(teamName: string): void {
    const browser = this.host.state.teamsBrowser;
    if (browser === undefined) return;
    if (browser.selectedTeamName === teamName) return;
    browser.selectedTeamName = teamName;
    this.repaint();
  }

  /**
   * Join member liveness from the background-task map: each agent task
   * carries its teammate identity (`AgentTaskInfo.teammate`), so a member's
   * live status is the status of the task backing its agent id.
   */
  private buildMemberLiveness(): ReadonlyMap<string, BackgroundTaskInfo['status']> {
    const liveness = new Map<string, BackgroundTaskInfo['status']>();
    for (const info of this.host.backgroundTasks.values()) {
      if (info.kind !== 'agent' || info.agentId === undefined) continue;
      // A member may accumulate several tasks over resume runs; the latest
      // write wins, matching the map's own replacement order.
      liveness.set(info.agentId, info.status);
    }
    return liveness;
  }
}

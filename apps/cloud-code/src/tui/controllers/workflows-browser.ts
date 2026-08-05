import type { BackgroundTaskInfo, Session } from '@cloud-code/sdk';
import type { Component, ProcessTerminal, TUI } from '@cloud-code/pi-tui';

import type { EditorSlotContainer } from '../components/chrome/gutter-container';
import { TaskOutputViewer } from '../components/dialogs/task-output-viewer';
import {
  WorkflowsBrowserApp,
  type WorkflowsBrowserProps,
} from '../components/dialogs/workflows-browser';
import type { CustomEditor } from '../components/editor/custom-editor';
import type { TeamTracker } from './teams-tracker';
import type { WorkflowTracker } from './workflows-tracker';

export interface WorkflowsBrowserHost {
  readonly state: {
    readonly workflowsBrowser: WorkflowsBrowserState | undefined;
    readonly terminal: ProcessTerminal;
    readonly ui: TUI;
    readonly editor: CustomEditor;
    readonly editorContainer: EditorSlotContainer;
  };
  readonly workflowTracker: WorkflowTracker;
  readonly teamTracker: TeamTracker;
  readonly backgroundTasks: ReadonlyMap<string, BackgroundTaskInfo>;
  readonly session: Session | undefined;
  /** Optional bridges exposed by the host when the task RPC controller owns them. */
  readonly stopTask?: (taskId: string) => Promise<void> | void;
  readonly openOutput?: (taskId: string) => Promise<void> | void;
  readonly foregroundTask?: (taskId: string) => Promise<void> | void;
  /** True while a blocking panel (approval/question) owns the editor slot. */
  hasBlockingEditorSlotPanel(): boolean;
  setWorkflowsBrowser(value: WorkflowsBrowserState | undefined): void;
}

/** Bridges the dashboard actions to existing task/output RPC channels. */
export interface WorkflowsBrowserActions {
  readonly stopTask?: (taskId: string) => Promise<void> | void;
  readonly openOutput?: (taskId: string) => Promise<void> | void;
  readonly foregroundTask?: (taskId: string) => Promise<void> | void;
}

export interface WorkflowsOutputViewerState {
  component: TaskOutputViewer;
  savedChildren: readonly Component[];
  taskId: string;
  pollTimer: NodeJS.Timeout;
}

export interface WorkflowsBrowserState {
  component: WorkflowsBrowserApp;
  savedChildren: readonly Component[];
  selectedAgentId: string | undefined;
  unsubscribe: () => void;
  tickTimer: NodeJS.Timeout | undefined;
  viewer?: WorkflowsOutputViewerState;
}

export class WorkflowsBrowserController {
  constructor(
    private readonly host: WorkflowsBrowserHost,
    private readonly actions: WorkflowsBrowserActions = {},
  ) {}

  show(): void {
    const { state } = this.host;
    if (state.workflowsBrowser !== undefined) return;
    // A takeover hides the whole layout tree; it must never cover a blocking
    // panel (its unanswered RPC would have no visible UI). See
    // docs/tui-modal-surfaces.md for the blocking-surface invariant.
    if (this.host.hasBlockingEditorSlotPanel()) return;

    const tracker = this.host.workflowTracker;
    const agents = tracker.getAgents();
    const selectedAgentId =
      agents.find((a) => a.status === 'running')?.agentId ?? agents[0]?.agentId;

    const component = new WorkflowsBrowserApp(this.buildProps(agents, selectedAgentId), state.terminal);

    const savedChildren = [...state.ui.children];
    state.ui.clear();
    state.ui.addChild(component);
    state.ui.setFocus(component);
    state.ui.requestRender(true);

    const unsubscribe = tracker.subscribe(() => {
      this.repaint();
    });
    // Durations are computed from `endedAt ?? Date.now()`, so this channel is
    // deliberately limited to one repaint per second while work is alive.
    const tickTimer = setInterval(() => {
      const currentAgents = tracker.getAgents();
      if (currentAgents.every((agent) => agent.endedAt !== undefined)) return;
      this.repaint();
    }, 1000);

    this.host.setWorkflowsBrowser({
      component,
      savedChildren,
      selectedAgentId,
      unsubscribe,
      tickTimer,
    });
  }

  close(): void {
    const { state } = this.host;
    const browser = state.workflowsBrowser;
    if (browser === undefined) return;

    browser.unsubscribe();
    if (browser.tickTimer !== undefined) clearInterval(browser.tickTimer);
    if (browser.viewer !== undefined) clearInterval(browser.viewer.pollTimer);
    browser.viewer = undefined;

    state.ui.clear();
    for (const child of browser.savedChildren) {
      state.ui.addChild(child);
    }
    this.host.setWorkflowsBrowser(undefined);
    state.ui.setFocus(state.editorContainer.children[0] ?? state.editor);
    state.ui.requestCollapseRender();
  }

  repaint(): void {
    const { state } = this.host;
    const browser = state.workflowsBrowser;
    if (browser === undefined) return;

    const agents = this.host.workflowTracker.getAgents();
    if (
      browser.selectedAgentId !== undefined &&
      !agents.some((agent) => agent.agentId === browser.selectedAgentId)
    ) {
      browser.selectedAgentId = agents[0]?.agentId;
    }
    browser.component.setProps(this.buildProps(agents, browser.selectedAgentId));
    state.ui.requestRender();
  }

  private buildProps(
    agents: readonly WorkflowAgentNodeLike[],
    selectedAgentId: string | undefined,
  ): WorkflowsBrowserProps {
    return {
      agents,
      selectedAgentId,
      scope: this.resolveScope(agents),
      backgroundTasks: this.host.backgroundTasks,
      onSelect: (agentId) => {
        this.handleSelect(agentId);
      },
      onCancel: () => {
        this.close();
      },
      onStopConfirmed: (taskId) => {
        void this.handleStop(taskId);
      },
      onOpenOutput: (taskId) => {
        void this.handleOpenOutput(taskId);
      },
      onForeground: this.hasForegroundBridge()
        ? (taskId) => {
            void this.handleForeground(taskId);
          }
        : undefined,
    };
  }

  private resolveScope(agents: readonly WorkflowAgentNodeLike[]): string | undefined {
    const teamNames = new Set<string>();
    for (const agent of agents) {
      const teamName = agent.teamName;
      if (teamName !== undefined && teamName.length > 0) teamNames.add(teamName);
    }
    if (teamNames.size === 1) return [...teamNames][0];
    const trackedTeams = this.host.teamTracker.getTeams();
    if (teamNames.size === 0 && trackedTeams.length === 1) return trackedTeams[0]?.name;
    return undefined;
  }

  private hasForegroundBridge(): boolean {
    return this.actions.foregroundTask !== undefined || this.host.foregroundTask !== undefined;
  }

  private handleSelect(agentId: string): void {
    const browser = this.host.state.workflowsBrowser;
    if (browser === undefined) return;
    if (browser.selectedAgentId === agentId) return;
    browser.selectedAgentId = agentId;
    this.repaint();
  }

  private async handleStop(taskId: string): Promise<void> {
    const stopTask = this.actions.stopTask ?? this.host.stopTask;
    if (stopTask !== undefined) {
      await stopTask(taskId);
      return;
    }
    await this.host.session?.stopBackgroundTask(taskId, {
      reason: 'The user interrupted this agent from the /workflows panel',
    });
  }

  private async handleOpenOutput(taskId: string): Promise<void> {
    const openOutput = this.actions.openOutput ?? this.host.openOutput;
    if (openOutput !== undefined) {
      await openOutput(taskId);
      return;
    }
    await this.openOutputViewer(taskId);
  }

  private async openOutputViewer(taskId: string): Promise<void> {
    const { state } = this.host;
    const browser = state.workflowsBrowser;
    const session = this.host.session;
    if (browser === undefined || browser.viewer !== undefined || session === undefined) return;

    let output: string;
    try {
      output = await session.getBackgroundTaskOutput(taskId);
    } catch {
      return;
    }
    const current = this.host.state.workflowsBrowser;
    if (current === undefined || current !== browser) return;

    const viewer = new TaskOutputViewer(
      {
        taskId,
        info: this.host.backgroundTasks.get(taskId),
        output,
        onClose: () => {
          this.closeOutputViewer();
        },
      },
      state.terminal,
    );
    const savedChildren = [...state.ui.children];
    state.ui.clear();
    state.ui.addChild(viewer);
    state.ui.setFocus(viewer);
    state.ui.requestRender(true);

    const pollTimer = setInterval(() => {
      void this.refreshOutputViewer(browser, taskId, viewer);
    }, 1000);
    browser.viewer = { component: viewer, savedChildren, taskId, pollTimer };
  }

  private async refreshOutputViewer(
    browser: WorkflowsBrowserState,
    taskId: string,
    viewer: TaskOutputViewer,
  ): Promise<void> {
    const session = this.host.session;
    if (session === undefined) return;
    try {
      const output = await session.getBackgroundTaskOutput(taskId);
      const current = this.host.state.workflowsBrowser;
      if (current !== browser || browser.viewer?.component !== viewer) return;
      viewer.setProps({
        taskId,
        info: this.host.backgroundTasks.get(taskId),
        output,
        onClose: () => this.closeOutputViewer(),
      });
      this.host.state.ui.requestRender();
    } catch {
      // The snapshot remains useful when the task disappears between polls.
    }
  }

  private closeOutputViewer(): void {
    const browser = this.host.state.workflowsBrowser;
    if (browser === undefined || browser.viewer === undefined) return;
    const viewer = browser.viewer;
    clearInterval(viewer.pollTimer);
    browser.viewer = undefined;
    this.host.state.ui.clear();
    for (const child of viewer.savedChildren) this.host.state.ui.addChild(child);
    this.host.state.ui.setFocus(browser.component);
    this.host.state.ui.requestCollapseRender();
  }

  private async handleForeground(taskId: string): Promise<void> {
    const foregroundTask = this.actions.foregroundTask ?? this.host.foregroundTask;
    await foregroundTask?.(taskId);
  }
}

type WorkflowAgentNodeLike = WorkflowsBrowserProps['agents'][number];

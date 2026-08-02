/**
 * WorkflowsBrowserController — mounts/closes the `/workflows` overlay and
 * keeps it live. Data comes from the `WorkflowTracker` attached to the
 * session event stream (see `session-event-handler.ts`): the controller
 * pushes a fresh snapshot on every tracker change and on a 1s tick so
 * elapsed times of running agents keep advancing while no events flow.
 */

import type { Component, ProcessTerminal, TUI } from '@cloud-code/pi-tui';

import type { EditorSlotContainer } from '../components/chrome/gutter-container';
import { WorkflowsBrowserApp } from '../components/dialogs/workflows-browser';
import type { CustomEditor } from '../components/editor/custom-editor';
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
  /** True while a blocking panel (approval/question) owns the editor slot. */
  hasBlockingEditorSlotPanel(): boolean;
  setWorkflowsBrowser(value: WorkflowsBrowserState | undefined): void;
}

export interface WorkflowsBrowserState {
  component: WorkflowsBrowserApp;
  savedChildren: readonly Component[];
  selectedAgentId: string | undefined;
  unsubscribe: () => void;
  tickTimer: NodeJS.Timeout | undefined;
}

export class WorkflowsBrowserController {
  constructor(private readonly host: WorkflowsBrowserHost) {}

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

    const component = new WorkflowsBrowserApp(
      {
        agents,
        selectedAgentId,
        onSelect: (agentId) => {
          this.handleSelect(agentId);
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
    // The tick only exists to advance elapsed-time readouts. Durations are
    // computed from `endedAt ?? Date.now()`, so once every agent has an
    // endedAt (terminal or reconciled state) the rendered frame is frozen
    // and repainting would produce byte-identical output — skip it. Any real
    // change still arrives through the tracker subscription above.
    const tickTimer = setInterval(() => {
      const agents = tracker.getAgents();
      if (agents.every((a) => a.endedAt !== undefined)) return;
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

    state.ui.clear();
    for (const child of browser.savedChildren) {
      state.ui.addChild(child);
    }
    this.host.setWorkflowsBrowser(undefined);
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
    const browser = state.workflowsBrowser;
    if (browser === undefined) return;

    const agents = this.host.workflowTracker.getAgents();
    if (
      browser.selectedAgentId !== undefined &&
      !agents.some((a) => a.agentId === browser.selectedAgentId)
    ) {
      browser.selectedAgentId = agents[0]?.agentId;
    }
    browser.component.setProps({
      agents,
      selectedAgentId: browser.selectedAgentId,
      onSelect: (agentId) => {
        this.handleSelect(agentId);
      },
      onCancel: () => {
        this.close();
      },
    });
    state.ui.requestRender();
  }

  private handleSelect(agentId: string): void {
    const browser = this.host.state.workflowsBrowser;
    if (browser === undefined) return;
    if (browser.selectedAgentId === agentId) return;
    browser.selectedAgentId = agentId;
    this.repaint();
  }
}

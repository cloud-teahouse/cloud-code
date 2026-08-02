/**
 * WorkflowTracker — pure, UI-free aggregator for the `/workflows` browser.
 *
 * Fed with every session event (main agent + subagents) from
 * `SessionEventHandler.handleEvent`, it maintains a per-agent node:
 * lifecycle status, model, current step, cumulative usage, elapsed timing,
 * a tail-buffered thinking summary, the most recent tool calls and an
 * ordered chain-of-thought activity stream (thinking segments interleaved
 * with tool calls). The workflows overlay reads a snapshot via
 * {@link getAgents} and re-renders through {@link subscribe}, so running
 * agents update live while the panel is open.
 *
 * Everything is keyed by the event's `agentId`; subagent lifecycle events
 * (`subagent.*`) are emitted on the *parent* agent and instead carry the
 * child id in `subagentId` (plus the parent in `parentAgentId`). Terminal
 * states the lifecycle has no spelling for (killed / timed_out / lost)
 * arrive via the task events (`background.task.*` / `task.*`, kind
 * `agent`), which are authoritative for detached/background agents.
 *
 * The tracker is intentionally session-agnostic: it knows nothing about
 * `Session`, theming or i18n, which keeps it trivially unit-testable.
 */

import type { Event, TokenUsage } from '@cloud-code/sdk';

import { MAIN_AGENT_ID } from '../constant/cloud-code-tui';
import { argsRecord, serializeToolResultOutput } from '../utils/event-payload';

export type WorkflowAgentStatus =
  | 'idle'
  | 'waiting'
  | 'running'
  | 'suspended'
  | 'done'
  | 'failed'
  | 'killed'
  | 'timed_out'
  | 'lost';

export interface WorkflowToolEntry {
  readonly id: string;
  name: string;
  argsText: string;
  status: 'running' | 'done' | 'failed';
  resultText: string | undefined;
}

/**
 * One ordered entry in an agent's chain-of-thought stream. Thinking deltas
 * coalesce into the trailing thinking segment until a tool call interrupts;
 * tool entries are shared by reference with {@link WorkflowAgentNode.tools},
 * so in-flight args/results update the stream live.
 */
export type WorkflowActivityEntry =
  | { readonly kind: 'thinking'; text: string }
  | { readonly kind: 'tool'; readonly tool: WorkflowToolEntry };

export interface WorkflowAgentNode {
  readonly agentId: string;
  name: string;
  parentAgentId: string | undefined;
  parentToolCallId: string | undefined;
  swarmIndex: number | undefined;
  runInBackground: boolean;
  description: string | undefined;
  status: WorkflowAgentStatus;
  /** Suspension reason or failure message, depending on `status`. */
  statusDetail: string | undefined;
  /** Model id from `agent.status.updated`; absent until the agent emits one. */
  model: string | undefined;
  step: number;
  startedAt: number;
  endedAt: number | undefined;
  usage: TokenUsage | undefined;
  contextTokens: number | undefined;
  thinkingText: string;
  thinkingTruncated: boolean;
  /** Most recent tool calls (oldest first), capped at {@link MAX_TOOL_ENTRIES}. */
  tools: WorkflowToolEntry[];
  toolCallCount: number;
  /**
   * Ordered chain-of-thought stream (thinking segments interleaved with tool
   * calls), oldest first, capped at {@link MAX_ACTIVITY_ENTRIES}.
   */
  activity: WorkflowActivityEntry[];
  /** True once the activity cap dropped entries from the head. */
  activityTruncated: boolean;
  resultSummary: string | undefined;
  /**
   * Mutation counter, bumped by the tracker on every write to this node.
   * Lets renderers memoize derived content per node without deep-comparing
   * the mutable fields (activity entries are updated in place).
   */
  revision: number;
}

/** Tail cap for the per-agent thinking buffer (chars). */
const THINKING_TAIL_CHARS = 4000;
/** Tail cap for one thinking segment in the activity stream (chars). */
const ACTIVITY_THINKING_TAIL_CHARS = 1200;
/** Tail cap for a single tool call's accumulated arguments text (chars). */
const ARGS_TAIL_CHARS = 2000;
/** Tail cap for a single tool result summary (chars). */
const RESULT_TAIL_CHARS = 400;
/** How many tool entries are kept per agent. */
const MAX_TOOL_ENTRIES = 30;
/** How many activity-stream entries are kept per agent. */
const MAX_ACTIVITY_ENTRIES = 60;

/** Total token count across all buckets of a {@link TokenUsage}. */
export function workflowNodeTotalTokens(node: WorkflowAgentNode): number {
  const usage = node.usage;
  if (usage === undefined) return 0;
  return usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation + usage.output;
}

function tailAppend(text: string, delta: string, cap: number): { text: string; truncated: boolean } {
  const next = text + delta;
  if (next.length <= cap) return { text: next, truncated: false };
  return { text: next.slice(next.length - cap), truncated: true };
}

function tailCap(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(text.length - cap);
}

function summarizeArgs(args: unknown): string {
  const record = argsRecord(args);
  const keys = Object.keys(record);
  if (keys.length === 0) return '';
  const serialized = JSON.stringify(record);
  return serialized.replaceAll(/\s+/g, ' ');
}

export class WorkflowTracker {
  private readonly agents = new Map<string, WorkflowAgentNode>();
  private readonly listeners = new Set<() => void>();

  reset(): void {
    this.agents.clear();
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot in first-seen order; the caller builds the tree. */
  getAgents(): readonly WorkflowAgentNode[] {
    return [...this.agents.values()];
  }

  getAgent(agentId: string): WorkflowAgentNode | undefined {
    return this.agents.get(agentId);
  }

  handleEvent(event: Event): void {
    switch (event.type) {
      case 'subagent.spawned': {
        const node = this.ensureAgent(event.subagentId);
        node.name = event.subagentName;
        node.parentAgentId = event.parentAgentId ?? event.agentId;
        if (node.parentAgentId === node.agentId) node.parentAgentId = undefined;
        node.parentToolCallId = event.parentToolCallId;
        node.swarmIndex = event.swarmIndex;
        node.runInBackground = event.runInBackground;
        node.description = event.description;
        // A re-spawn (resumed agent taking a new task) starts a fresh run:
        // reset the lifecycle and chain, keep the node identity.
        node.status = 'waiting';
        node.statusDetail = undefined;
        node.step = 0;
        node.startedAt = Date.now();
        node.endedAt = undefined;
        node.thinkingText = '';
        node.thinkingTruncated = false;
        node.tools = [];
        node.toolCallCount = 0;
        node.activity = [];
        node.activityTruncated = false;
        node.resultSummary = undefined;
        this.notify(node);
        return;
      }
      case 'subagent.started': {
        const node = this.ensureAgent(event.subagentId);
        node.status = 'running';
        node.statusDetail = undefined;
        node.endedAt = undefined;
        this.notify(node);
        return;
      }
      case 'subagent.suspended': {
        const node = this.ensureAgent(event.subagentId);
        node.status = 'suspended';
        node.statusDetail = event.reason;
        this.notify(node);
        return;
      }
      case 'subagent.completed': {
        const node = this.ensureAgent(event.subagentId);
        node.status = 'done';
        node.statusDetail = undefined;
        node.endedAt = Date.now();
        if (event.usage !== undefined) node.usage = event.usage;
        if (event.contextTokens !== undefined) node.contextTokens = event.contextTokens;
        node.resultSummary = event.resultSummary;
        this.notify(node);
        return;
      }
      case 'subagent.failed': {
        const node = this.ensureAgent(event.subagentId);
        node.status = 'failed';
        node.statusDetail = event.error;
        node.endedAt = Date.now();
        this.notify(node);
        return;
      }
      case 'turn.started': {
        const node = this.ensureAgent(event.agentId);
        // Subagent lifecycle events own subagent status; a stray turn event
        // must not resurrect a terminal node. The main agent has no
        // lifecycle events, so turn boundaries drive it.
        if (event.agentId === MAIN_AGENT_ID || node.status === 'idle') {
          node.status = 'running';
          node.endedAt = undefined;
        }
        this.notify(node);
        return;
      }
      case 'turn.ended': {
        if (event.agentId !== MAIN_AGENT_ID) return;
        const node = this.ensureAgent(event.agentId);
        node.status = event.reason === 'failed' ? 'failed' : 'idle';
        if (event.reason === 'failed') {
          node.statusDetail = event.error?.message;
        }
        node.endedAt = Date.now();
        this.notify(node);
        return;
      }
      case 'turn.step.started': {
        const node = this.ensureAgent(event.agentId);
        node.step = event.step;
        this.notify(node);
        return;
      }
      case 'thinking.delta': {
        if (event.delta.length === 0) return;
        const node = this.ensureAgent(event.agentId);
        const next = tailAppend(node.thinkingText, event.delta, THINKING_TAIL_CHARS);
        node.thinkingText = next.text;
        node.thinkingTruncated = node.thinkingTruncated || next.truncated;
        // Coalesce into the trailing thinking segment; a tool call since the
        // last delta opens a fresh segment, keeping the stream interleaved.
        const tail = node.activity[node.activity.length - 1];
        if (tail !== undefined && tail.kind === 'thinking') {
          tail.text = tailCap(tail.text + event.delta, ACTIVITY_THINKING_TAIL_CHARS);
        } else {
          this.pushActivity(node, { kind: 'thinking', text: tailCap(event.delta, ACTIVITY_THINKING_TAIL_CHARS) });
        }
        this.notify(node);
        return;
      }
      case 'tool.call.started': {
        const node = this.ensureAgent(event.agentId);
        const entry: WorkflowToolEntry = {
          id: event.toolCallId,
          name: event.name,
          argsText: tailCap(summarizeArgs(event.args), ARGS_TAIL_CHARS),
          status: 'running',
          resultText: undefined,
        };
        node.tools.push(entry);
        node.toolCallCount += 1;
        if (node.tools.length > MAX_TOOL_ENTRIES) {
          node.tools.splice(0, node.tools.length - MAX_TOOL_ENTRIES);
        }
        this.pushActivity(node, { kind: 'tool', tool: entry });
        this.notify(node);
        return;
      }
      case 'tool.call.delta': {
        if (event.toolCallId.length === 0) return;
        const node = this.ensureAgent(event.agentId);
        const entry = this.findToolEntry(node, event.toolCallId);
        if (entry === undefined) return;
        if (event.name !== undefined && entry.name.length === 0) entry.name = event.name;
        if (event.argumentsPart !== undefined) {
          entry.argsText = tailCap(entry.argsText + event.argumentsPart, ARGS_TAIL_CHARS);
        }
        this.notify(node);
        return;
      }
      case 'tool.result': {
        const node = this.ensureAgent(event.agentId);
        let entry = this.findToolEntry(node, event.toolCallId);
        if (entry === undefined) {
          // Result without a matching start (subscription attached
          // mid-flight): record it so the chain stays complete.
          entry = {
            id: event.toolCallId,
            name: event.toolCallId,
            argsText: '',
            status: 'running',
            resultText: undefined,
          };
          node.tools.push(entry);
          node.toolCallCount += 1;
          if (node.tools.length > MAX_TOOL_ENTRIES) {
            node.tools.splice(0, node.tools.length - MAX_TOOL_ENTRIES);
          }
          this.pushActivity(node, { kind: 'tool', tool: entry });
        }
        entry.status = event.isError === true ? 'failed' : 'done';
        entry.resultText = tailCap(serializeToolResultOutput(event.output), RESULT_TAIL_CHARS);
        this.notify(node);
        return;
      }
      case 'agent.status.updated': {
        const node = this.ensureAgent(event.agentId);
        const usage = event.usage?.total ?? event.usage?.currentTurn;
        if (usage !== undefined) node.usage = usage;
        if (event.contextTokens !== undefined) node.contextTokens = event.contextTokens;
        if (event.model !== undefined) node.model = event.model;
        this.notify(node);
        return;
      }
      case 'background.task.started':
      case 'task.started': {
        // A foreground subagent detached (Ctrl+B) re-registers as a
        // background agent task: flip the badge so the tree matches reality.
        const info = event.info;
        if (info.kind !== 'agent' || info.agentId === undefined) return;
        const node = this.ensureAgent(info.agentId);
        node.runInBackground = true;
        this.notify(node);
        return;
      }
      case 'background.task.terminated':
      case 'task.terminated': {
        // Task-level terminal states the subagent lifecycle has no spelling
        // for (killed / timed_out / lost) surface here — e.g. a background
        // agent stopped from the tasks browser. The task record is
        // authoritative, so it may also resolve a still-open node.
        const info = event.info;
        if (info.kind !== 'agent' || info.agentId === undefined) return;
        if (info.status === 'running') return;
        const node = this.ensureAgent(info.agentId);
        node.status = info.status === 'completed' ? 'done' : info.status;
        node.statusDetail = info.stopReason ?? node.statusDetail;
        node.endedAt = info.endedAt ?? Date.now();
        this.notify(node);
        return;
      }
      default:
        return;
    }
  }

  private ensureAgent(agentId: string): WorkflowAgentNode {
    const existing = this.agents.get(agentId);
    if (existing !== undefined) return existing;
    const node: WorkflowAgentNode = {
      agentId,
      name: agentId === MAIN_AGENT_ID ? MAIN_AGENT_ID : agentId,
      parentAgentId: undefined,
      parentToolCallId: undefined,
      swarmIndex: undefined,
      runInBackground: false,
      description: undefined,
      status: agentId === MAIN_AGENT_ID ? 'idle' : 'running',
      statusDetail: undefined,
      model: undefined,
      step: 0,
      startedAt: Date.now(),
      endedAt: undefined,
      usage: undefined,
      contextTokens: undefined,
      thinkingText: '',
      thinkingTruncated: false,
      tools: [],
      toolCallCount: 0,
      activity: [],
      activityTruncated: false,
      resultSummary: undefined,
      revision: 0,
    };
    this.agents.set(agentId, node);
    return node;
  }

  private pushActivity(node: WorkflowAgentNode, entry: WorkflowActivityEntry): void {
    node.activity.push(entry);
    if (node.activity.length > MAX_ACTIVITY_ENTRIES) {
      node.activity.splice(0, node.activity.length - MAX_ACTIVITY_ENTRIES);
      node.activityTruncated = true;
    }
  }

  private findToolEntry(
    node: WorkflowAgentNode,
    toolCallId: string,
  ): WorkflowToolEntry | undefined {
    // Recent entries live at the tail; search backwards.
    for (let i = node.tools.length - 1; i >= 0; i -= 1) {
      const entry = node.tools[i]!;
      if (entry.id === toolCallId) return entry;
    }
    return undefined;
  }

  private notify(node?: WorkflowAgentNode): void {
    if (node !== undefined) node.revision += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

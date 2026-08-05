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
import type { TeamTracker } from './teams-tracker';

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

export type WorkflowCurrentActivity = {
  readonly kind: 'thinking' | 'tool' | 'retry' | 'waiting-approval' | 'idle';
  readonly label: string;
  readonly toolName?: string;
};

type AgentPhase = NonNullable<Extract<Event, { type: 'agent.status.updated' }>['phase']>;

export interface WorkflowToolEntry {
  readonly id: string;
  name: string;
  argsText: string;
  status: 'running' | 'done' | 'failed';
  resultText: string | undefined;
}

/**
 * One ordered entry in an agent's chain-of-thought stream. Thinking deltas
 * coalesce into the trailing thinking segment and assistant text deltas into
 * the trailing text segment until a tool call interrupts; tool entries are
 * shared by reference with {@link WorkflowAgentNode.tools}, so in-flight
 * args/results update the stream live.
 */
export type WorkflowActivityEntry =
  | { readonly kind: 'thinking'; text: string }
  | { readonly kind: 'text'; text: string }
  | { readonly kind: 'tool'; readonly tool: WorkflowToolEntry };

export interface WorkflowAgentNode {
  readonly agentId: string;
  name: string;
  parentAgentId: string | undefined;
  parentToolCallId: string | undefined;
  swarmIndex: number | undefined;
  runInBackground: boolean;
  description: string | undefined;
  /** The task prompt the parent handed this agent (subagent.spawned) — the
   * workflows detail view renders it as the conversation's first user message. */
  prompt: string | undefined;
  status: WorkflowAgentStatus;
  /** Suspension reason or failure message, depending on `status`. */
  statusDetail: string | undefined;
  lastEventAt: number | undefined;
  currentActivity: WorkflowCurrentActivity | undefined;
  /** Model id from `agent.status.updated`; absent until the agent emits one. */
  model: string | undefined;
  step: number;
  startedAt: number;
  endedAt: number | undefined;
  usage: TokenUsage | undefined;
  contextTokens: number | undefined;
  lastOutput: string | undefined;
  progress: { done: number; total: number } | undefined;
  taskId: string | undefined;
  teamName: string | undefined;
  taskSubject: string | undefined;
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
/** Tail cap for one assistant text segment in the activity stream (chars). */
const ACTIVITY_TEXT_TAIL_CHARS = 4000;
/** Tail cap for a single tool call's accumulated arguments text (chars). */
const ARGS_TAIL_CHARS = 2000;
/** Tail cap for a single tool result summary (chars). */
const RESULT_TAIL_CHARS = 400;
/** Tail cap for the most recent assistant output (chars). */
const LAST_OUTPUT_TAIL_CHARS = 200;
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
  if (delta.length >= cap) return { text: delta.slice(-cap), truncated: true };
  const keep = cap - delta.length;
  const prefix = text.length > keep ? text.slice(-keep) : text;
  return { text: prefix + delta, truncated: text.length > keep };
}

function appendAssistantOutput(text: string | undefined, delta: string): string {
  const deltaTail =
    delta.length > LAST_OUTPUT_TAIL_CHARS ? delta.slice(-LAST_OUTPUT_TAIL_CHARS) : delta;
  const normalized = deltaTail.replaceAll(/\r\n?|\n|\\r\\n?|\\n/g, ' ');
  if (normalized.length === 0) return text ?? '';
  return tailAppend(text ?? '', normalized, LAST_OUTPUT_TAIL_CHARS).text;
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

function isTerminalStatus(status: WorkflowAgentStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'killed' || status === 'timed_out' || status === 'lost';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readProgress(record: Record<string, unknown> | undefined): { done: number; total: number } | undefined {
  if (record === undefined) return undefined;
  const done =
    finiteNumber(record['done']) ?? finiteNumber(record['completed']) ?? finiteNumber(record['current']);
  const total =
    finiteNumber(record['total']) ?? finiteNumber(record['maximum']) ?? finiteNumber(record['max']);
  if (done === undefined || total === undefined) return undefined;
  return { done: Math.max(0, done), total: Math.max(0, total) };
}

function progressFromUpdate(update: unknown): { done: number; total: number } | undefined {
  const record = asRecord(update);
  const direct = readProgress(record);
  if (direct !== undefined) return direct;
  const custom = readProgress(asRecord(record?.['customData']));
  if (custom !== undefined) return custom;
  const nested = readProgress(asRecord(record?.['progress']));
  if (nested !== undefined) return nested;
  const percent = finiteNumber(record?.['percent']);
  if (percent !== undefined) return { done: Math.max(0, Math.min(100, percent)), total: 100 };
  const text = typeof record?.['text'] === 'string' ? record['text'] : undefined;
  const match = text?.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (match !== undefined && match !== null) {
    return { done: Number(match[1]), total: Number(match[2]) };
  }
  return undefined;
}

export class WorkflowTracker {
  private readonly agents = new Map<string, WorkflowAgentNode>();
  private readonly listeners = new Set<() => void>();
  private readonly approvalAgents = new Map<string, string>();
  private readonly teamTracker: TeamTracker | undefined;

  constructor(teamTracker?: TeamTracker) {
    this.teamTracker = teamTracker;
  }

  reset(): void {
    this.agents.clear();
    this.approvalAgents.clear();
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
    for (const node of this.agents.values()) {
      if (this.syncTeamAssignment(node)) node.revision += 1;
    }
    return [...this.agents.values()];
  }

  getAgent(agentId: string): WorkflowAgentNode | undefined {
    const node = this.agents.get(agentId);
    if (node !== undefined && this.syncTeamAssignment(node)) node.revision += 1;
    return node;
  }

  handleEvent(event: Event): void {
    const eventAt = Date.now();
    const eventNode = this.ensureAgent(event.agentId);
    this.touchEvent(eventNode, eventAt);
    if (this.handleInteractionEvent(event, eventAt)) return;

    switch (event.type) {
      case 'subagent.spawned': {
        const node = this.ensureAgent(event.subagentId);
        this.touchEvent(node, eventAt);
        node.name = event.subagentName;
        node.parentAgentId = event.parentAgentId ?? event.agentId;
        if (node.parentAgentId === node.agentId) node.parentAgentId = undefined;
        node.parentToolCallId = event.parentToolCallId;
        node.swarmIndex = event.swarmIndex;
        node.runInBackground = event.runInBackground;
        node.description = event.description;
        node.prompt = event.prompt;
        // A re-spawn (resumed agent taking a new task) starts a fresh run:
        // reset the lifecycle and chain, keep the node identity.
        node.status = 'waiting';
        node.statusDetail = undefined;
        node.currentActivity = undefined;
        node.step = 0;
        node.startedAt = eventAt;
        node.endedAt = undefined;
        node.lastOutput = undefined;
        node.progress = undefined;
        node.taskId = undefined;
        node.teamName = undefined;
        node.taskSubject = undefined;
        node.thinkingText = '';
        node.thinkingTruncated = false;
        node.tools = [];
        node.toolCallCount = 0;
        node.activity = [];
        node.activityTruncated = false;
        node.resultSummary = undefined;
        this.notify(node, eventNode);
        return;
      }
      case 'subagent.started': {
        const node = this.ensureAgent(event.subagentId);
        this.touchEvent(node, eventAt);
        node.status = 'running';
        node.statusDetail = undefined;
        node.currentActivity = this.activity('thinking');
        node.endedAt = undefined;
        this.notify(node, eventNode);
        return;
      }
      case 'subagent.suspended': {
        const node = this.ensureAgent(event.subagentId);
        this.touchEvent(node, eventAt);
        node.status = 'suspended';
        node.statusDetail = event.reason;
        node.currentActivity = this.activity('idle');
        this.notify(node, eventNode);
        return;
      }
      case 'subagent.completed': {
        const node = this.ensureAgent(event.subagentId);
        this.touchEvent(node, eventAt);
        node.status = 'done';
        node.statusDetail = undefined;
        node.currentActivity = this.activity('idle');
        node.endedAt = eventAt;
        if (event.usage !== undefined) node.usage = event.usage;
        if (event.contextTokens !== undefined) node.contextTokens = event.contextTokens;
        node.resultSummary = event.resultSummary;
        this.notify(node, eventNode);
        return;
      }
      case 'subagent.failed': {
        const node = this.ensureAgent(event.subagentId);
        this.touchEvent(node, eventAt);
        node.status = 'failed';
        node.statusDetail = event.error;
        node.currentActivity = this.activity('idle');
        node.endedAt = eventAt;
        this.notify(node, eventNode);
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
        if (!isTerminalStatus(node.status)) node.currentActivity = this.activity('thinking');
        this.notify(node);
        return;
      }
      case 'turn.ended': {
        if (event.agentId !== MAIN_AGENT_ID) {
          this.notify(eventNode);
          return;
        }
        const node = this.ensureAgent(event.agentId);
        node.status = event.reason === 'failed' ? 'failed' : 'idle';
        if (event.reason === 'failed') {
          node.statusDetail = event.error?.message;
        }
        node.currentActivity = this.activity('idle');
        node.endedAt = eventAt;
        this.notify(node);
        return;
      }
      case 'turn.step.started': {
        const node = this.ensureAgent(event.agentId);
        node.step = event.step;
        if (!isTerminalStatus(node.status)) {
          node.status = 'running';
          node.currentActivity = this.activity('thinking');
        }
        this.notify(node);
        return;
      }
      case 'thinking.delta': {
        const node = this.ensureAgent(event.agentId);
        if (event.delta.length === 0) {
          this.notify(node);
          return;
        }
        node.currentActivity = this.activity('thinking');
        const next = tailAppend(node.thinkingText, event.delta, THINKING_TAIL_CHARS);
        node.thinkingText = next.text;
        node.thinkingTruncated = node.thinkingTruncated || next.truncated;
        // Coalesce into the trailing thinking segment; a tool call since the
        // last delta opens a fresh segment, keeping the stream interleaved.
        const tail = node.activity.at(-1);
        if (tail !== undefined && tail.kind === 'thinking') {
          tail.text = tailCap(tail.text + event.delta, ACTIVITY_THINKING_TAIL_CHARS);
        } else {
          this.pushActivity(node, { kind: 'thinking', text: tailCap(event.delta, ACTIVITY_THINKING_TAIL_CHARS) });
        }
        this.notify(node);
        return;
      }
      case 'assistant.delta': {
        const node = this.ensureAgent(event.agentId);
        if (event.delta.length > 0) {
          node.lastOutput = appendAssistantOutput(node.lastOutput, event.delta);
          // Coalesce into the trailing text segment (same interleave contract
          // as thinking: a tool call opens a fresh segment).
          const tail = node.activity.at(-1);
          if (tail !== undefined && tail.kind === 'text') {
            tail.text = tailCap(tail.text + event.delta, ACTIVITY_TEXT_TAIL_CHARS);
          } else {
            this.pushActivity(node, { kind: 'text', text: tailCap(event.delta, ACTIVITY_TEXT_TAIL_CHARS) });
          }
        }
        if (!isTerminalStatus(node.status)) {
          node.status = 'running';
          node.currentActivity = this.activity('thinking');
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
        node.progress = undefined;
        node.status = 'running';
        node.currentActivity = this.activity('tool', event.name);
        if (node.tools.length > MAX_TOOL_ENTRIES) {
          node.tools.splice(0, node.tools.length - MAX_TOOL_ENTRIES);
        }
        this.pushActivity(node, { kind: 'tool', tool: entry });
        this.notify(node);
        return;
      }
      case 'tool.call.delta': {
        const node = this.ensureAgent(event.agentId);
        if (event.toolCallId.length === 0) return;
        const entry = this.findToolEntry(node, event.toolCallId);
        if (entry === undefined) return;
        if (event.name !== undefined && entry.name.length === 0) entry.name = event.name;
        if (event.argumentsPart !== undefined) {
          entry.argsText = tailCap(entry.argsText + event.argumentsPart, ARGS_TAIL_CHARS);
        }
        this.notify(node);
        return;
      }
      case 'tool.progress': {
        const node = this.ensureAgent(event.agentId);
        const entry = this.findToolEntry(node, event.toolCallId);
        if (!isTerminalStatus(node.status)) {
          node.status = 'running';
          node.currentActivity = this.activity('tool', entry?.name);
        }
        const progress = progressFromUpdate(event.update);
        if (progress !== undefined) node.progress = progress;
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
        node.progress = undefined;
        if (!isTerminalStatus(node.status)) {
          node.status = 'running';
          node.currentActivity = this.activity('idle');
        }
        this.notify(node);
        return;
      }
      case 'turn.step.completed': {
        const node = this.ensureAgent(event.agentId);
        node.step = event.step;
        if (event.usage !== undefined) node.usage = event.usage;
        if (!isTerminalStatus(node.status)) node.currentActivity = this.activity('idle');
        this.notify(node);
        return;
      }
      case 'turn.step.interrupted': {
        const node = this.ensureAgent(event.agentId);
        node.step = event.step;
        if (!isTerminalStatus(node.status)) {
          node.status = event.reason === 'error' ? 'failed' : 'idle';
          node.statusDetail = event.message ?? event.reason;
          node.currentActivity = this.activity('idle');
        }
        this.notify(node);
        return;
      }
      case 'turn.step.retrying': {
        const node = this.ensureAgent(event.agentId);
        node.step = event.step;
        if (!isTerminalStatus(node.status)) {
          node.status = 'running';
          node.statusDetail = event.errorMessage;
          node.currentActivity = this.activity('retry');
        }
        this.notify(node);
        return;
      }
      case 'turn.rate_limit_paused': {
        const node = this.ensureAgent(event.agentId);
        if (!isTerminalStatus(node.status)) {
          node.status = 'suspended';
          node.statusDetail = `Retrying at ${new Date(event.resumeAtMs).toISOString()}`;
          node.currentActivity = this.activity('retry');
        }
        this.notify(node);
        return;
      }
      case 'turn.rate_limit_resuming': {
        const node = this.ensureAgent(event.agentId);
        if (!isTerminalStatus(node.status)) {
          node.status = 'running';
          node.statusDetail = undefined;
          node.currentActivity = this.activity('retry');
        }
        this.notify(node);
        return;
      }
      case 'agent.status.updated': {
        const node = this.ensureAgent(event.agentId);
        const usage = event.usage?.total ?? event.usage?.currentTurn;
        if (usage !== undefined) node.usage = usage;
        if (event.contextTokens !== undefined) node.contextTokens = event.contextTokens;
        if (event.model !== undefined) node.model = event.model;
        if (event.phase !== undefined) this.applyPhase(node, event.phase);
        this.notify(node);
        return;
      }
      case 'background.task.started':
      case 'task.started': {
        // A foreground subagent detached (Ctrl+B) re-registers as a
        // background agent task: flip the badge so the tree matches reality.
        const info = event.info;
        if (info.kind !== 'agent' || info.agentId === undefined) {
          this.notify(eventNode);
          return;
        }
        const node = this.ensureAgent(info.agentId);
        this.touchEvent(node, eventAt);
        node.runInBackground = true;
        node.taskId = info.taskId;
        if (info.teammate?.teamName !== undefined) node.teamName = info.teammate.teamName;
        node.status = info.status === 'running' ? 'running' : node.status;
        this.syncTeamAssignment(node);
        this.notify(node, eventNode);
        return;
      }
      case 'background.task.terminated':
      case 'task.terminated': {
        // Task-level terminal states the subagent lifecycle has no spelling
        // for (killed / timed_out / lost) surface here — e.g. a background
        // agent stopped from the tasks browser. The task record is
        // authoritative, so it may also resolve a still-open node.
        const info = event.info;
        if (info.kind !== 'agent' || info.agentId === undefined) {
          this.notify(eventNode);
          return;
        }
        if (info.status === 'running') {
          this.notify(eventNode);
          return;
        }
        const node = this.ensureAgent(info.agentId);
        this.touchEvent(node, eventAt);
        node.taskId = info.taskId;
        node.status = info.status === 'completed' ? 'done' : info.status;
        node.statusDetail = info.stopReason ?? node.statusDetail;
        node.currentActivity = this.activity('idle');
        node.progress = undefined;
        node.endedAt = info.endedAt ?? eventAt;
        this.syncTeamAssignment(node);
        this.notify(node, eventNode);
        return;
      }
      case 'team.updated':
        this.syncTeamAssignments(eventNode);
        this.notify(eventNode);
        return;
      default:
        this.notify(eventNode);
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
      prompt: undefined,
      status: agentId === MAIN_AGENT_ID ? 'idle' : 'running',
      statusDetail: undefined,
      lastEventAt: undefined,
      currentActivity: undefined,
      model: undefined,
      step: 0,
      startedAt: Date.now(),
      endedAt: undefined,
      usage: undefined,
      contextTokens: undefined,
      lastOutput: undefined,
      progress: undefined,
      taskId: undefined,
      teamName: undefined,
      taskSubject: undefined,
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

  private touchEvent(node: WorkflowAgentNode, eventAt: number): void {
    if (node.lastEventAt === undefined || eventAt >= node.lastEventAt) node.lastEventAt = eventAt;
  }

  private activity(
    kind: WorkflowCurrentActivity['kind'],
    toolName?: string,
  ): WorkflowCurrentActivity {
    switch (kind) {
      case 'tool':
        return { kind, label: toolName ?? 'Tool', toolName };
      case 'retry':
        return { kind, label: 'Retrying', toolName };
      case 'waiting-approval':
        return { kind, label: 'Waiting for approval', toolName };
      case 'thinking':
        return { kind, label: 'Thinking', toolName };
      case 'idle':
        return { kind, label: 'Idle', toolName };
    }
  }

  private syncTeamAssignment(node: WorkflowAgentNode): boolean {
    const tracker = this.teamTracker;
    if (tracker === undefined || tracker.getTeams().length === 0) return false;
    const assignment = tracker.getAgentAssignment(node.agentId);
    const teamName = assignment?.teamName;
    const taskSubject = assignment?.taskSubject;
    const changed = node.teamName !== teamName || node.taskSubject !== taskSubject;
    node.teamName = teamName;
    node.taskSubject = taskSubject;
    return changed;
  }

  private syncTeamAssignments(skipRevisionFor?: WorkflowAgentNode): void {
    for (const node of this.agents.values()) {
      if (this.syncTeamAssignment(node) && node !== skipRevisionFor) node.revision += 1;
    }
  }

  private applyPhase(node: WorkflowAgentNode, phase: AgentPhase): void {
    if (isTerminalStatus(node.status) && phase.kind !== 'ended' && phase.kind !== 'interrupted') return;
    if ('step' in phase && phase.step !== undefined) node.step = phase.step;
    switch (phase.kind) {
      case 'idle':
        node.status = 'idle';
        node.currentActivity = this.activity('idle');
        return;
      case 'running':
        node.status = 'running';
        node.currentActivity = this.activity('thinking');
        return;
      case 'streaming':
        node.status = 'running';
        node.currentActivity =
          phase.stream === 'tool_call'
            ? this.activity('tool', phase.toolName)
            : this.activity('thinking');
        return;
      case 'tool_call':
        node.status = 'running';
        node.currentActivity = this.activity('tool', phase.name);
        return;
      case 'retrying':
        node.status = 'running';
        node.currentActivity = this.activity('retry');
        return;
      case 'awaiting_approval':
        node.status = 'waiting';
        node.currentActivity = this.activity('waiting-approval');
        return;
      case 'interrupted':
        node.status = phase.reason === 'error' ? 'failed' : 'idle';
        node.statusDetail = phase.message;
        node.currentActivity = this.activity('idle');
        node.endedAt = phase.at;
        return;
      case 'ended':
        node.status = phase.reason === 'failed' ? 'failed' : 'idle';
        node.currentActivity = this.activity('idle');
        node.endedAt = phase.at;
        return;
    }
  }

  private handleInteractionEvent(event: Event, eventAt: number): boolean {
    const raw = event as unknown as Record<string, unknown>;
    const type = stringField(raw, 'type');
    const sessionStatus = stringField(raw, 'status');
    const pendingInteraction = stringField(raw, 'pending_interaction');
    const isSessionRequest =
      (type === 'event.session.status_changed' &&
        (sessionStatus === 'awaiting_approval' || sessionStatus === 'awaiting_question')) ||
      (type === 'event.session.work_changed' &&
        (pendingInteraction === 'approval' || pendingInteraction === 'question'));
    const isSessionResolved =
      (type === 'event.session.status_changed' &&
        (sessionStatus === 'idle' || sessionStatus === 'running' || sessionStatus === 'aborted')) ||
      (type === 'event.session.work_changed' && pendingInteraction === 'none');
    const isRequest =
      type === 'event.approval.requested' ||
      type === 'approval.requested' ||
      type === 'event.question.requested' ||
      type === 'question.requested' ||
      isSessionRequest;
    const isResolved =
      type === 'event.approval.resolved' ||
      type === 'approval.resolved' ||
      type === 'event.approval.expired' ||
      type === 'approval.expired' ||
      type === 'event.question.answered' ||
      type === 'question.answered' ||
      type === 'event.question.dismissed' ||
      type === 'question.dismissed' ||
      isSessionResolved;
    if (!isRequest && !isResolved) return false;

    const payload =
      asRecord(raw['payload']) ??
      asRecord(raw['request']) ??
      asRecord(raw['approval']) ??
      asRecord(raw['question']);
    const read = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = stringField(payload, key) ?? stringField(raw, key);
        if (value !== undefined) return value;
      }
      return undefined;
    };
    const approvalId = read('approval_id', 'approvalId', 'question_id', 'questionId', 'id');
    const toolCallId = read('tool_call_id', 'toolCallId');
    const agentId =
      read('agentId', 'agent_id') ??
      (approvalId === undefined ? undefined : this.approvalAgents.get(`approval:${approvalId}`)) ??
      (toolCallId === undefined ? undefined : this.approvalAgents.get(`tool:${toolCallId}`)) ??
      event.agentId;
    const sessionBusy = raw['busy'] === true || raw['main_turn_active'] === true;
    const eventNode = this.agents.get(event.agentId);
    const node = this.ensureAgent(agentId);
    this.touchEvent(node, eventAt);

    if (isRequest) {
      if (approvalId !== undefined) this.approvalAgents.set(`approval:${approvalId}`, agentId);
      if (toolCallId !== undefined) this.approvalAgents.set(`tool:${toolCallId}`, agentId);
      node.status = 'waiting';
      node.statusDetail = undefined;
      node.currentActivity = this.activity('waiting-approval');
    } else {
      if (approvalId !== undefined) this.approvalAgents.delete(`approval:${approvalId}`);
      if (toolCallId !== undefined) this.approvalAgents.delete(`tool:${toolCallId}`);
      if (!isTerminalStatus(node.status)) {
        const resumed = isSessionResolved && sessionBusy;
        node.status = resumed ? 'running' : isSessionResolved ? 'idle' : 'running';
        node.currentActivity = this.activity(resumed ? 'thinking' : 'idle');
      }
    }
    this.notify(node, eventNode);
    return true;
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

  private notify(node?: WorkflowAgentNode, also?: WorkflowAgentNode): void {
    if (node !== undefined) node.revision += 1;
    if (also !== undefined && also !== node) also.revision += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

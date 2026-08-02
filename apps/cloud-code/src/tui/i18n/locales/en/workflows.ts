/** See common.ts for contribution rules. */

export const workflows = {
  // ── slash command ──
  'workflows.command.description': 'Browse the agent tree and subagent chain of thought',

  // ── header ──
  'workflows.title': 'WORKFLOWS',
  'workflows.count.running': '{count} running ',
  'workflows.count.done': '{count} done ',
  'workflows.count.failed': '{count} failed ',
  'workflows.count.total': '{count} total',

  // ── footer hints ──
  'workflows.hint.select': 'select',
  'workflows.hint.expand': 'expand/collapse',
  'workflows.hint.close': 'close',
  'workflows.hint.detail': 'detail',
  'workflows.hint.back': 'back',
  'workflows.hint.scroll': 'scroll',
  'workflows.hint.page': 'page',

  // ── agent tree pane ──
  'workflows.tree.title': 'Agents',
  'workflows.tree.empty': 'No agent activity in this session yet',
  'workflows.tree.noSubagents': 'No subagents yet — the Agent tool and AgentSwarm appear here',
  'workflows.tree.mainLabel': 'main',
  'workflows.tree.backgroundBadge': 'bg',

  // ── agent status ──
  'workflows.status.idle': 'idle',
  'workflows.status.waiting': 'waiting',
  'workflows.status.running': 'running',
  'workflows.status.suspended': 'suspended',
  'workflows.status.done': 'done',
  'workflows.status.failed': 'failed',
  'workflows.status.killed': 'killed',
  'workflows.status.timed_out': 'timed out',
  'workflows.status.lost': 'lost',

  // ── chain-of-thought pane ──
  'workflows.detail.title': 'Chain of Thought',
  'workflows.detail.empty': 'Select an agent to inspect its chain of thought',
  'workflows.detail.step': 'step {step}',
  'workflows.detail.tokens': '{tokens} tok',
  'workflows.detail.toolCount': '{count} tools',
  'workflows.detail.task': 'Task: {description}',
  'workflows.detail.result': 'Result: {summary}',
  'workflows.detail.error': 'Error: {message}',
  'workflows.detail.suspendedReason': 'Suspended: {reason}',
  'workflows.detail.activityEmpty': '(no activity recorded yet)',
  'workflows.detail.toolRunning': 'running',
  'workflows.detail.truncatedHint': '… truncated — use Read / TaskOutput for the full text',
  'workflows.detail.scrollInfo': ' {from}-{to}/{total}',

  // ── duration ──
  'workflows.duration.seconds': '{count}s',
  'workflows.duration.minutes': '{minutes}m {seconds}s',
  'workflows.duration.hours': '{hours}h {minutes}m',

  // ── misc ──
  'workflows.tooSmall': 'Terminal too small (need at least {width}x{height})',
} as const;

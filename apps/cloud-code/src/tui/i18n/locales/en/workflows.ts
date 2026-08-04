/** See common.ts for contribution rules. */

export const workflows = {
  // ── slash command ──
  'workflows.command.description': 'Browse the agent tree and monitor live runs safely',

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
  'workflows.hint.stop': 'stop',
  'workflows.hint.output': 'output',
  'workflows.hint.foreground': 'foreground',
  'workflows.hint.thinking': 'thinking',

  // ── run summary ──
  'workflows.summary.alive': 'alive {count}',
  'workflows.summary.waiting': 'waiting {count}',
  'workflows.summary.attention': 'attention {count}',
  'workflows.summary.done': 'done {count}',
  'workflows.scope.session': 'session',
  'workflows.scope.swarm': 'swarm',

  // ── agent roster ──
  'workflows.roster.title': 'Roster',
  'workflows.roster.defaultTeam': 'default',
  'workflows.roster.empty': 'No workflows are running yet',
  'workflows.roster.emptyHint': 'Start an Agent or AgentSwarm task to see it here',
  'workflows.roster.attention': '{count} attention',
  'workflows.roster.agentCount': '{count} agents',
  'workflows.roster.doneGroup': 'done ({count})',
  'workflows.roster.noTask': 'No task assigned',

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
  'workflows.detail.title': 'Agent detail',
  'workflows.detail.empty': 'Select an agent to inspect its run details',
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
  'workflows.detail.noTask': 'No task assigned',
  'workflows.detail.taskLabel': 'Task:',
  'workflows.detail.nowLabel': 'Now:',
  'workflows.detail.noOutput': 'No output yet',
  'workflows.detail.lastOutputLabel': 'Last output:',
  'workflows.detail.notAvailable': '—',
  'workflows.detail.statStep': 'step {step}',
  'workflows.detail.statTools': 'tools {count}',
  'workflows.detail.statTokens': 'tokens {tokens}',
  'workflows.detail.statContext': 'context {tokens}',
  'workflows.detail.chainTitle': 'THINKING (collapsed)',

  // ── activity timeline ──
  'workflows.activity.title': 'ACTIVITY',
  'workflows.activity.thinking': 'thinking',
  'workflows.activity.thinkingSummary': 'thinking update',
  'workflows.activity.running': 'running',
  'workflows.activity.progress': '{done}/{total}',
  'workflows.activity.empty': 'No activity recorded yet',
  'workflows.activity.stage': 'stage',
  'workflows.activity.noResult': 'No result yet',
  'workflows.activity.result': 'result',
  'workflows.activity.errorStage': 'error',
  'workflows.activity.approvalStage': 'approval',
  'workflows.activity.idle': 'idle',

  // ── interventions ──
  'workflows.intervention.confirmStop': 'Stop this agent? y/N',

  // ── duration ──
  'workflows.duration.seconds': '{count}s',
  'workflows.duration.minutes': '{minutes}m {seconds}s',
  'workflows.duration.hours': '{hours}h {minutes}m',

  // ── misc ──
  'workflows.tooSmall': 'Terminal too small (need at least {width}x{height})',
} as const;

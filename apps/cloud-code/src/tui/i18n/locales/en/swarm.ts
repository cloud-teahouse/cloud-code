/** See common.ts for contribution rules. */

export const swarm = {
  // ── swarm progress panel ──
  'swarm.title': 'Agent Swarm',
  'swarm.status.orchestrating': 'Orchestrating...',
  'swarm.status.prompting': 'Prompting...',
  'swarm.status.working': 'Working...',
  'swarm.status.completed': 'Completed.',
  'swarm.status.failed': 'Failed.',
  'swarm.status.aborted': 'Aborted.',
  'swarm.status.cancelled': 'Cancelled.',
  'swarm.status.queued': 'Queued...',
  'swarm.status.rateLimited': 'Rate limited...',
  'swarm.phase.running': 'Running',
  'swarm.phase.completed': 'Completed',
  'swarm.phase.failed': 'Failed',
  'swarm.item.resumed': '(resumed)',

  // ── agent group ──
  'swarm.group.detachHint': 'Press Ctrl+B to run in background',
  'swarm.group.finished.typed': '{count} {type} agents finished',
  'swarm.group.finished': '{count} agents finished',
  'swarm.group.running.breakdown': 'Running {count} agents ({parts})',
  'swarm.group.running': 'Running {count} agents',
  'swarm.group.breakdown.done': '{count} done',
  'swarm.group.breakdown.failed': '{count} failed',
  'swarm.group.breakdown.backgrounded': '{count} backgrounded',
  'swarm.group.breakdown.running': '{count} running',
  'swarm.group.breakdown.waiting': '{count} waiting',
  'swarm.group.breakdown.starting': '{count} starting',
  'swarm.group.tools.one': '{count} tool',
  'swarm.group.tools.other': '{count} tools',
  'swarm.group.error': 'Error: {message}',
  'swarm.group.tail.completed': '✓ Completed',
  'swarm.group.tail.failed': '✗ Failed',
  'swarm.group.tail.backgrounded': '◐ backgrounded',
  'swarm.group.tail.waiting': 'Waiting',
  'swarm.group.tail.running': 'Running',
  'swarm.group.tail.starting': 'Starting',
  'swarm.group.activity.waiting': 'Waiting to start…',
  'swarm.group.activity.working': 'Still working…',
  'swarm.group.activity.starting': 'Starting…',

  // ── swarm mode markers ──
  'swarm.marker.activated': 'Swarm activated',
  'swarm.marker.deactivated': 'Swarm deactivated',
  'swarm.marker.ended': 'Swarm ended',

  // ── step summary ──
  'swarm.stepSummary.thinking': 'thinking {count} times',
  'swarm.stepSummary.tools': 'call {count} tools',
  'swarm.stepSummary.messages': '{count} messages',

  // ── background agent status ──
  'swarm.background.subject.named': '{name} agent',
  'swarm.background.subject.plain': 'agent',
  'swarm.background.started': '{subject} started in background',
  'swarm.background.completed': '{subject} completed in background',
  'swarm.background.failed': '{subject} failed in background',
  'swarm.background.lost': '{subject} lost in background',
  'swarm.background.stopped': '{subject} stopped',
  'swarm.background.timedOut': '{subject} timed out',

  // ── /swarm command ──
  'swarm.command.taskNotStarted': 'Swarm task not started.',
  'swarm.command.alreadyOn': 'Swarm mode is already on.',
  'swarm.command.alreadyOff': 'Swarm mode is already off.',
  'swarm.command.notEnabled': 'Swarm mode not enabled.',
  'swarm.command.enableFailed': 'Failed to enable swarm mode: {error}',
  'swarm.command.disableFailed': 'Failed to disable swarm mode: {error}',
} as const;

/** Tool-call transcript: verbs, status labels, chips and summaries. See common.ts for rules. */

export const messages = {
  // ── tool call header verbs & labels ──
  'messages.toolCall.verb.using': 'Using',
  'messages.toolCall.verb.used': 'Used',
  'messages.toolCall.verb.truncated': 'Truncated',
  'messages.toolCall.bash.ran': 'Ran a command',
  'messages.toolCall.bash.running': 'Running a command',
  'messages.toolCall.glob.includeIgnored': ' · include ignored',
  'messages.toolCall.detachHint': 'Press Ctrl+B to run in background',
  'messages.toolCall.argsTruncated': 'Tool call arguments truncated by max_tokens — call never executed.',

  // ── ExitPlanMode / plan approval ──
  'messages.toolCall.plan.current': 'Current plan',
  'messages.toolCall.plan.approved': 'Approved',
  'messages.toolCall.plan.approvedWithChoice': 'Approved: {chosen}',
  'messages.toolCall.plan.autoApproved': ' · Auto-approved',
  'messages.toolCall.plan.rejected': 'Rejected',
  'messages.toolCall.plan.suggestion': '↪ Suggestion',

  // ── AskUserQuestion ──
  'messages.toolCall.ask.couldNotCollect': 'Could not collect your input',
  'messages.toolCall.ask.startedBackground': 'Started background question',
  'messages.toolCall.ask.collected': 'Collected your answers',
  'messages.toolCall.ask.startingBackground': 'Starting background question',
  'messages.toolCall.ask.waiting': 'Waiting for your input',
  'messages.toolCall.ask.dismissed': 'User dismissed the question.',

  // ── subagent card ──
  'messages.toolCall.subagent.label': 'subagent ({id})',
  'messages.toolCall.subagent.labelWithName': 'subagent {name} ({id})',
  'messages.toolCall.subagent.moreToolCalls.one': '{count} more tool call ...',
  'messages.toolCall.subagent.moreToolCalls.other': '{count} more tool calls ...',
  'messages.toolCall.subagent.phase.queued': '○ queued',
  'messages.toolCall.subagent.phase.starting': '↻ starting…',
  'messages.toolCall.subagent.phase.running': '↻ running',
  'messages.toolCall.subagent.phase.done': '✓ done',
  'messages.toolCall.subagent.phase.failed': '✗ failed',
  'messages.toolCall.subagent.phase.backgrounded': '◐ backgrounded',
  'messages.toolCall.subagent.status.completed': 'Completed',
  'messages.toolCall.subagent.status.failed': 'Failed',
  'messages.toolCall.subagent.status.running': 'Running',
  'messages.toolCall.subagent.status.backgrounded': 'Backgrounded',
  'messages.toolCall.subagent.status.queued': 'Queued',
  'messages.toolCall.subagent.status.starting': 'Starting',
  'messages.toolCall.toolCount.one': '{count} tool',
  'messages.toolCall.toolCount.other': '{count} tools',
  'messages.toolCall.bg.lost': 'Background agent lost (session restarted before completion)',
  'messages.toolCall.bg.killed': 'Background agent killed',
  'messages.toolCall.bg.timedOut': 'Background agent timed out',
  'messages.toolCall.bg.failed': 'Background agent failed',

  // ── streaming previews ──
  'messages.toolCall.write.moreLines': '... ({count} more lines, {total} total, ctrl+o to expand)',
  'messages.toolCall.edit.preparing': 'Preparing changes... {size} · {elapsed} elapsed',
  'messages.toolCall.edit.preparingFor': 'Preparing changes for {path}... {size} · {elapsed} elapsed',

  // ── AgentSwarm result summary ──
  'messages.toolCall.swarm.prefix': 'Agent swarm: ',
  'messages.toolCall.swarm.completed': '✓ {count} completed',
  'messages.toolCall.swarm.failed': '✗ {count} failed',
  'messages.toolCall.swarm.aborted': '⊘ {count} aborted',
  'messages.toolCall.swarm.label.completed': '✓ Completed.',
  'messages.toolCall.swarm.label.failed': '✗ Failed.',
  'messages.toolCall.swarm.label.aborted': '⊘ Aborted.',

  // ── header chips ──
  'messages.chip.lines.one': '{count} line',
  'messages.chip.lines.other': '{count} lines',
  'messages.chip.matches.one': '{count} match',
  'messages.chip.matches.other': '{count} matches',
  'messages.chip.noMatches': 'no matches',
  'messages.chip.files.one': '{count} file',
  'messages.chip.files.other': '{count} files',
  'messages.chip.noFiles': 'no files',
  'messages.chip.results.one': '{count} result',
  'messages.chip.results.other': '{count} results',
  'messages.chip.noResults': 'no results',
  'messages.chip.webResult': 'web result',
  'messages.chip.mediaUploaded': '{kind} · uploaded',
  'messages.chip.noGoal': 'no goal',

  // ── goal tools ──
  'messages.goal.create.failed': 'Could not start goal',
  'messages.goal.create.done': 'Started goal',
  'messages.goal.create.running': 'Starting goal',
  'messages.goal.check.failed': 'Could not check goal',
  'messages.goal.check.done': 'Checked goal',
  'messages.goal.check.running': 'Checking goal',
  'messages.goal.budget.failed': 'Could not set goal budget',
  'messages.goal.budget.done': 'Set goal budget',
  'messages.goal.budget.running': 'Setting goal budget',
  'messages.goal.report.failed': 'Could not report goal {status}',
  'messages.goal.report.done': 'Reported goal {status}',
  'messages.goal.report.running': 'Reporting goal {status}',
  'messages.goal.statusFallback': 'status',
  'messages.goal.noCurrentGoal': '  No current goal.',
  'messages.goal.statusLine': 'Goal {status}: {objective}',
  'messages.goal.status.active': 'active',
  'messages.goal.status.paused': 'paused',
  'messages.goal.status.blocked': 'blocked',
  'messages.goal.status.complete': 'complete',
  'messages.goal.turns.one': '{count} turn',
  'messages.goal.turns.other': '{count} turns',
  'messages.goal.tokens': '{count} tokens',

  // ── glance summaries & truncated output ──
  'messages.summary.more': ', +{count} more',
  'messages.truncated.moreLines': '... ({count} more lines)',
  'messages.truncated.moreLinesExpand': '... ({count} more lines, ctrl+o to expand)',
  'messages.truncated.earlierLines': '... ({count} earlier lines)',

  // ── diff preview (diff-preview.ts) ──
  'messages.diff.moreChangesHidden.one': '{count} more change hidden ({hint} to expand)',
  'messages.diff.moreChangesHidden.other': '{count} more changes hidden ({hint} to expand)',
  'messages.diff.unchangedLines.one': '{count} unchanged line',
  'messages.diff.unchangedLines.other': '{count} unchanged lines',
} as const;

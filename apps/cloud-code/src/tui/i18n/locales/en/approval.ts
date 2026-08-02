/** Approval dialog: choices, headers, danger labels, hints. See common.ts for rules. */

export const approval = {
  // ── Choice labels (adapter.ts) ──
  'approval.choice.approveOnce': 'Approve once',
  'approval.choice.approveSession': 'Approve for this session',
  'approval.choice.approveAlways': 'Approve always',
  'approval.choice.approveAlwaysDescription':
    'Save a permission rule to your user config so this is approved permanently',
  'approval.choice.reject': 'Reject',
  'approval.choice.rejectWithFeedback': 'Reject with feedback',
  'approval.choice.revise': 'Revise',
  'approval.choice.approve': 'Approve',
  'approval.choice.approveKeepModeDescription': 'Stay in the current permission mode',
  'approval.choice.approveWithAuto': 'Approve and switch to Auto mode',
  'approval.choice.approveWithAutoDescription':
    'Tools are approved automatically while the plan runs, and questions are skipped.',
  'approval.choice.approveWithFeedback': 'Approve with feedback',

  // ── Panel headers (approval-panel.ts) ──
  'approval.header.bash': 'Run this command?',
  'approval.header.write': 'Write this file?',
  'approval.header.edit': 'Apply these edits?',
  'approval.header.taskStop': 'Stop this task?',
  'approval.header.exitPlanMode': 'Ready to build with this plan?',
  'approval.header.default': 'Approve {tool}?',

  // ── Worker badge (approval-panel.ts): bridged teammate asks (A4) ──
  'approval.requesterBadge': 'Requested by teammate {name} (team: {team})',
  'approval.requesterBadgeNoTeam': 'Requested by teammate {name}',

  // ── Danger labels (adapter.ts DANGER_PATTERNS) ──
  'approval.dangerous': 'Dangerous: {label}',
  'approval.danger.recursiveDelete': 'recursive delete',
  'approval.danger.sudo': 'sudo',
  'approval.danger.pipeToShell': 'pipe to shell',
  'approval.danger.ddWrite': 'dd write',
  'approval.danger.mkfs': 'mkfs',
  'approval.danger.rawDevice': 'write to raw device',
  'approval.danger.chmod777': 'chmod 777',
  'approval.danger.forkBomb': 'fork bomb',

  // ── Hints (approval-panel.ts) ──
  'approval.hint.feedback': 'Type feedback · ↵ submit.',
  'approval.hint.select': '↑/↓ select · {numbers} choose · ↵ confirm',
  'approval.hint.preview': ' · ctrl+e preview',
  'approval.expandHint': 'ctrl+e to preview',
  'approval.hiddenLines.one': '     … {count} more line hidden (ctrl+e to preview)',
  'approval.hiddenLines.other': '     … {count} more lines hidden (ctrl+e to preview)',

  // ── Display blocks (approval-panel.ts) ──
  'approval.displayBlock.search': 'search',
  'approval.displayBlock.backgroundTask': '{status} {kind} task {id}: {description}',

  // ── Request descriptions (adapter.ts) ──
  'approval.desc.goalStart': 'Start a goal?',
  'approval.desc.edit': 'edit {path}',
  'approval.desc.fileOp': '{operation} {path}',
  'approval.desc.taskStop': 'stop task: {task}',
  'approval.desc.spawnAgent': 'spawn {name}',
  'approval.desc.invokeSkill': 'invoke skill {name}',
  'approval.desc.fetch': 'fetch {url}',
  'approval.desc.search': 'search: {query}',
  'approval.desc.todoList': 'update todo list ({count} items)',
  'approval.desc.task': '{status} task {id}: {description}',
  'approval.goalStart.title': 'Start goal: {objective}',
  'approval.goalStart.doneWhen': 'Done when: {criterion}',
  'approval.taskStop.brief': 'Stop task {id}: {description}',

  // ── Start-permission prompts (shared: start-permission-prompt.ts) ──
  'approval.startPrompt.hint': ' ↑↓ navigate · Enter select · Esc cancel',
  'approval.startPrompt.switchAuto.label': 'Switch to Auto and start',
  'approval.startPrompt.switchYolo.label': 'Switch to YOLO and start',
  'approval.startPrompt.switchYolo.description':
    'Tools and plan changes are approved automatically. Cloud Code CLI may still ask you questions.',
  'approval.startPrompt.startManual.label': 'Start in Manual',
  'approval.startPrompt.notice.manualAsk':
    'Manual mode asks you before Cloud Code CLI runs commands, edits files, or takes other risky actions.',
  'approval.startPrompt.notice.goBack': 'You can go back without losing your command.',

  // ── Goal-start prompt (goal-start-permission-prompt.ts) ──
  'approval.goalStartPrompt.title.manual': 'Start a goal with approvals on?',
  'approval.goalStartPrompt.title.yolo': 'Start a goal in YOLO mode?',
  'approval.goalStartPrompt.switchAuto.description':
    'Best if you want Cloud Code CLI to keep working while you are away. Tools are approved automatically, and questions are skipped.',
  'approval.goalStartPrompt.keepYolo.label': 'Keep YOLO and start',
  'approval.goalStartPrompt.keepYolo.description':
    'Tools and plan changes stay approved automatically. Cloud Code CLI may still ask you questions.',
  'approval.goalStartPrompt.startManual.description':
    'Keep approvals on. Cloud Code CLI will ask before risky actions, so the goal may stop and wait for you.',
  'approval.goalStartPrompt.doNotStart.label': 'Do not start',
  'approval.goalStartPrompt.doNotStart.description': 'Return to the input box with your goal command.',
  'approval.goalStartPrompt.notice.unattended':
    'Manual mode is not suitable for unattended goal work.',
  'approval.goalStartPrompt.notice.yoloApproves':
    'YOLO mode approves tools and plan changes automatically.',
  'approval.goalStartPrompt.notice.yoloQuestions': 'YOLO mode can still stop for questions.',
  'approval.goalStartPrompt.notice.switchAuto':
    'Switch to Auto if you want questions skipped during goal work.',

  // ── Swarm-start prompt (swarm-start-permission-prompt.ts) ──
  'approval.swarmStartPrompt.title': 'Start a swarm task with approvals on?',
  'approval.swarmStartPrompt.switchAuto.description':
    'Best for swarm tasks. Tools are approved automatically, and questions are skipped.',
  'approval.swarmStartPrompt.startManual.description':
    'Keep approvals on. Cloud Code CLI may stop and wait for you during the swarm task.',
  'approval.swarmStartPrompt.notice.blockSwarm':
    'Manual mode can block swarm work while agents are running.',

  // ── Coordinator-start prompt (coordinator-start-permission-prompt.ts) ──
  'approval.coordinatorStartPrompt.title': 'Enter Coordinator Mode with approvals on?',
  'approval.coordinatorStartPrompt.switchAuto.description':
    'Best for coordinated runs. Tools are approved automatically, and questions are skipped.',
  'approval.coordinatorStartPrompt.startManual.description':
    'Keep approvals on. Cloud Code CLI may stop and wait for you while workers are running.',
  'approval.coordinatorStartPrompt.notice.blockWorkers':
    'Manual mode can block worker progress while agents are running.',

  // ── Preview viewer (approval-preview.ts) ──
  'approval.preview.title': ' Preview ',
  'approval.preview.line': 'line',
  'approval.preview.page': 'page',
  'approval.preview.topBot': 'top/bot',
  'approval.preview.cancel': 'cancel',
} as const;

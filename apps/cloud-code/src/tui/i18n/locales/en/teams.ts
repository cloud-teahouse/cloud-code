/** See common.ts for contribution rules. */

export const teams = {
  // ── slash command ──
  'teams.command.description': 'Browse swarm teams, shared task lists, and mailbox activity',

  // ── header ──
  'teams.title': 'TEAMS',
  'teams.count.teams': '{count} teams ',
  'teams.count.members': '{count} members ',
  'teams.count.tasks': '{count} tasks ',
  'teams.count.activeTasks': '{count} active tasks ',

  // ── footer hints ──
  'teams.hint.select': 'select',
  'teams.hint.scroll': 'scroll',
  'teams.hint.page': 'page',
  'teams.hint.close': 'close',

  // ── team list pane ──
  'teams.list.title': 'Teams',
  'teams.list.empty': 'No teams yet — teammates spawned with a team name appear here',

  // ── detail pane ──
  'teams.detail.title': 'Team',
  'teams.detail.empty': 'Select a team to inspect it',
  'teams.detail.members': 'Members ({count})',
  'teams.detail.tasks': 'Shared tasks ({count})',
  'teams.detail.activity': 'Recent mailbox activity',
  'teams.detail.noTasks': 'No shared tasks yet',
  'teams.detail.noActivity': 'No mailbox activity yet',
  'teams.detail.scrollInfo': ' ({from}-{to} of {total})',

  // ── member liveness (joined from background task info) ──
  'teams.member.status.running': 'running',
  'teams.member.status.completed': 'completed',
  'teams.member.status.failed': 'failed',
  'teams.member.status.timed_out': 'timed out',
  'teams.member.status.killed': 'killed',
  'teams.member.status.lost': 'lost',
  'teams.member.status.idle': 'idle',

  // ── shared task status ──
  'teams.task.status.pending': 'pending',
  'teams.task.status.in_progress': 'in progress',
  'teams.task.status.completed': 'completed',
  'teams.task.unclaimed': 'unclaimed',

  // ── shared task table columns ──
  'teams.task.column.id': 'ID',
  'teams.task.column.subject': 'Subject',
  'teams.task.column.status': 'Status',
  'teams.task.column.owner': 'Owner',

  // ── mailbox activity kinds ──
  'teams.activity.kind.message': 'message',
  'teams.activity.kind.task_assignment': 'assign',
  'teams.activity.kind.shutdown_request': 'shutdown',
  'teams.activity.kind.shutdown_approved': 'shutdown ok',
  'teams.activity.kind.shutdown_rejected': 'shutdown no',
  'teams.activity.kind.permission_request': 'permission',
  'teams.activity.kind.permission_response': 'permission ans',

  // ── too-small fallback ──
  'teams.tooSmall': 'Terminal too small for the teams browser (need at least {width}x{height})',
} as const;

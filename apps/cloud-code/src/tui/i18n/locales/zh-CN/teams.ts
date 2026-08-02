/** See common.ts for contribution rules. */

export const teams = {
  // ── slash command ──
  'teams.command.description': '浏览 swarm 团队、共享任务列表与邮箱动态',

  // ── header ──
  'teams.title': '团队',
  'teams.count.teams': '{count} 个团队 ',
  'teams.count.members': '{count} 名成员 ',
  'teams.count.tasks': '{count} 项任务 ',
  'teams.count.activeTasks': '{count} 项进行中 ',

  // ── footer hints ──
  'teams.hint.select': '选择',
  'teams.hint.scroll': '滚动',
  'teams.hint.page': '翻页',
  'teams.hint.close': '关闭',

  // ── team list pane ──
  'teams.list.title': '团队',
  'teams.list.empty': '还没有团队 —— 以团队名产卵的 teammate 会出现在这里',

  // ── detail pane ──
  'teams.detail.title': '团队',
  'teams.detail.empty': '选择一个团队以查看详情',
  'teams.detail.members': '成员（{count}）',
  'teams.detail.tasks': '共享任务（{count}）',
  'teams.detail.activity': '最近邮箱动态',
  'teams.detail.noTasks': '还没有共享任务',
  'teams.detail.noActivity': '还没有邮箱动态',
  'teams.detail.scrollInfo': '（第 {from}-{to} 行，共 {total} 行）',

  // ── member liveness (joined from background task info) ──
  'teams.member.status.running': '运行中',
  'teams.member.status.completed': '已完成',
  'teams.member.status.failed': '失败',
  'teams.member.status.timed_out': '超时',
  'teams.member.status.killed': '已停止',
  'teams.member.status.lost': '丢失',
  'teams.member.status.idle': '空闲',

  // ── shared task status ──
  'teams.task.status.pending': '待领取',
  'teams.task.status.in_progress': '进行中',
  'teams.task.status.completed': '已完成',
  'teams.task.unclaimed': '未认领',

  // ── shared task table columns ──
  'teams.task.column.id': '编号',
  'teams.task.column.subject': '主题',
  'teams.task.column.status': '状态',
  'teams.task.column.owner': '负责人',

  // ── mailbox activity kinds ──
  'teams.activity.kind.message': '消息',
  'teams.activity.kind.task_assignment': '指派',
  'teams.activity.kind.shutdown_request': '关机',
  'teams.activity.kind.shutdown_approved': '关机确认',
  'teams.activity.kind.shutdown_rejected': '关机拒绝',
  'teams.activity.kind.permission_request': '权限请求',
  'teams.activity.kind.permission_response': '权限答复',

  // ── too-small fallback ──
  'teams.tooSmall': '终端窗口太小，无法显示团队面板（至少需要 {width}x{height}）',
} as const;

import type { workflows as enDomain } from '../en/workflows';

/** 贡献规范见 common.ts。 */

export const workflows: Record<keyof typeof enDomain, string> = {
  // ── 斜杠命令 ──
  'workflows.command.description': '查看 agent 实时运行并安全干预',

  // ── 标题栏 ──
  'workflows.title': '工作流',
  'workflows.count.running': '{count} 运行中 ',
  'workflows.count.done': '{count} 完成 ',
  'workflows.count.failed': '{count} 失败 ',
  'workflows.count.total': '共 {count} 个',

  // ── 底部按键提示 ──
  'workflows.hint.select': '选择',
  'workflows.hint.expand': '展开/收起',
  'workflows.hint.close': '关闭',
  'workflows.hint.detail': '详情',
  'workflows.hint.back': '返回',
  'workflows.hint.scroll': '滚动',
  'workflows.hint.interrupt': '打断',
  'workflows.hint.page': '翻页',
  'workflows.hint.stop': '停止',
  'workflows.hint.output': '输出',
  'workflows.hint.foreground': '切前台',
  'workflows.hint.thinking': '思维链',

  // ── 运行摘要 ──
  'workflows.summary.alive': '存活 {count}',
  'workflows.summary.waiting': '等待 {count}',
  'workflows.summary.attention': '注意 {count}',
  'workflows.summary.done': '完成 {count}',
  'workflows.scope.session': '会话',
  'workflows.scope.swarm': 'swarm',

  // ── agent roster ──
  'workflows.roster.title': 'Agent 列表',
  'workflows.roster.defaultTeam': '默认组',
  'workflows.roster.empty': '暂无运行中的 workflow',
  'workflows.roster.emptyHint': '启动 Agent 或 AgentSwarm 任务后会显示在这里',
  'workflows.roster.attention': '{count} 项需关注',
  'workflows.roster.agentCount': '{count} 个 agent',
  'workflows.roster.doneGroup': '已完成（{count}）',
  'workflows.roster.noTask': '未分配任务',

  // ── agent 树面板 ──
  'workflows.tree.title': 'Agent 树',
  'workflows.tree.empty': '本会话还没有 agent 活动',
  'workflows.tree.noSubagents': '暂无子代理——Agent 工具与 AgentSwarm 会显示在这里',
  'workflows.tree.mainLabel': '主 agent',
  'workflows.tree.backgroundBadge': '后台',

  // ── agent 状态 ──
  'workflows.status.idle': '空闲',
  'workflows.status.waiting': '等待',
  'workflows.status.running': '运行中',
  'workflows.status.suspended': '已挂起',
  'workflows.status.done': '完成',
  'workflows.status.failed': '失败',
  'workflows.status.killed': '已终止',
  'workflows.status.timed_out': '超时',
  'workflows.status.lost': '失联',

  // ── 思维链面板 ──
  'workflows.detail.title': 'Agent 详情',
  'workflows.detail.empty': '选择一个 agent 查看运行详情',
  'workflows.detail.step': '第 {step} 步',
  'workflows.detail.tokens': '{tokens} tok',
  'workflows.detail.toolCount': '{count} 次工具调用',
  'workflows.detail.task': '任务：{description}',
  'workflows.detail.result': '结果：{summary}',
  'workflows.detail.error': '错误：{message}',
  'workflows.detail.suspendedReason': '已挂起：{reason}',
  'workflows.detail.activityEmpty': '（暂无活动记录）',
  'workflows.detail.toolRunning': '运行中',
  'workflows.detail.truncatedHint': '……已截断——用 Read / TaskOutput 查看全文',
  'workflows.detail.scrollInfo': ' {from}-{to}/{total}',
  'workflows.detail.noTask': '未分配任务',
  'workflows.detail.taskLabel': '任务：',
  'workflows.detail.nowLabel': '当前：',
  'workflows.detail.noOutput': '暂无输出',
  'workflows.detail.lastOutputLabel': '最近输出：',
  'workflows.detail.notAvailable': '—',
  'workflows.detail.conversationTitle': '会话 · {name}',
  'workflows.detail.promptLabel': '来自主 Agent 的指令：',
  'workflows.detail.approvalReadonly': '⏸ 等待审批 — 请回到主界面处理（此处只读）',
  'workflows.detail.statusModel': '模型：',
  'workflows.detail.statusContext': '上下文：',
  'workflows.detail.statStep': '第 {step} 步',
  'workflows.detail.statTools': '工具 {count}',
  'workflows.detail.statTokens': '令牌 {tokens}',
  'workflows.detail.statContext': '上下文 {tokens}',
  'workflows.detail.chainTitle': '思维链（已折叠）',

  // ── 活动时间线 ──
  'workflows.activity.title': '活动',
  'workflows.activity.thinking': '思考',
  'workflows.activity.reply': '回复',
  'workflows.activity.thinkingSummary': '思考更新',
  'workflows.activity.running': '运行中',
  'workflows.activity.progress': '{done}/{total}',
  'workflows.activity.empty': '暂无活动记录',
  'workflows.activity.stage': '阶段',
  'workflows.activity.noResult': '暂无结果',
  'workflows.activity.result': '结果',
  'workflows.activity.errorStage': '错误',
  'workflows.activity.approvalStage': '审批',
  'workflows.activity.idle': '空闲',

  // ── 干预 ──
  'workflows.intervention.confirmStop': '打断此 agent？y/N',

  // ── 耗时 ──
  'workflows.duration.seconds': '{count}秒',
  'workflows.duration.minutes': '{minutes}分{seconds}秒',
  'workflows.duration.hours': '{hours}小时{minutes}分',

  // ── 其他 ──
  'workflows.tooSmall': '终端窗口太小（至少需要 {width}x{height}）',
};

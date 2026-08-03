import type { swarm as enDomain } from '../en/swarm';

/** 贡献规范见 common.ts。 */

export const swarm: Record<keyof typeof enDomain, string> = {
  // ── swarm 进度面板 ──
  'swarm.title': 'Agent 集群',
  'swarm.status.orchestrating': '编排中…',
  'swarm.status.prompting': '提示词中…',
  'swarm.status.working': '工作中…',
  'swarm.status.completed': '已完成。',
  'swarm.status.failed': '失败。',
  'swarm.status.aborted': '已中止。',
  'swarm.status.cancelled': '已取消。',
  'swarm.status.queued': '排队中…',
  'swarm.status.rateLimited': '已限流…',
  'swarm.phase.running': '运行中',
  'swarm.phase.completed': '已完成',
  'swarm.phase.failed': '失败',
  'swarm.item.resumed': '（续）',

  // ── agent 分组 ──
  'swarm.group.detachHint': '按 Ctrl+B 在后台运行',
  'swarm.group.finished.typed': '{count} 个 {type} agent 已完成',
  'swarm.group.finished': '{count} 个 agent 已完成',
  'swarm.group.running.breakdown': '运行 {count} 个 agent（{parts}）',
  'swarm.group.running': '运行 {count} 个 agent',
  'swarm.group.breakdown.done': '{count} 完成',
  'swarm.group.breakdown.failed': '{count} 失败',
  'swarm.group.breakdown.backgrounded': '{count} 后台',
  'swarm.group.breakdown.running': '{count} 运行',
  'swarm.group.breakdown.waiting': '{count} 等待',
  'swarm.group.breakdown.starting': '{count} 启动',
  'swarm.group.tools.one': '{count} 工具',
  'swarm.group.tools.other': '{count} 工具',
  'swarm.group.error': '错误：{message}',
  'swarm.group.tail.completed': '✓ 已完成',
  'swarm.group.tail.failed': '✗ 失败',
  'swarm.group.tail.backgrounded': '◐ 后台运行',
  'swarm.group.tail.waiting': '等待',
  'swarm.group.tail.running': '运行中',
  'swarm.group.tail.starting': '启动中',
  'swarm.group.activity.waiting': '等待启动…',
  'swarm.group.activity.working': '仍在运行…',
  'swarm.group.activity.starting': '启动中…',

  // ── swarm 模式标记 ──
  'swarm.marker.activated': '集群已激活',
  'swarm.marker.deactivated': '集群已停用',
  'swarm.marker.ended': '集群已结束',

  // ── 步骤摘要 ──
  'swarm.stepSummary.thinking': '思考 {count} 次',
  'swarm.stepSummary.tools': '调用 {count} 次',
  'swarm.stepSummary.messages': '{count} 条消息',

  // ── 后台 agent 状态 ──
  'swarm.background.subject.named': '{name} agent',
  'swarm.background.subject.plain': 'agent',
  'swarm.background.started': '{subject} 已在后台启动',
  'swarm.background.completed': '{subject} 已在后台完成',
  'swarm.background.failed': '{subject} 在后台运行失败',
  'swarm.background.lost': '{subject} 在后台失联',
  'swarm.background.stopped': '{subject} 已停止',
  'swarm.background.timedOut': '{subject} 已超时',

  // ── /swarm 命令 ──
  'swarm.command.taskNotStarted': 'swarm 任务未启动。',
  'swarm.command.alreadyOn': 'swarm 模式已开启。',
  'swarm.command.alreadyOff': 'swarm 模式已关闭。',
  'swarm.command.notEnabled': 'swarm 模式未启用。',
  'swarm.command.enableFailed': '启用 swarm 模式失败：{error}',
  'swarm.command.disableFailed': '禁用 swarm 模式失败：{error}',
};

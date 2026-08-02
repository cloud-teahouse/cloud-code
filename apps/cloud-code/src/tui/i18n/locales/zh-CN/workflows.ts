import type { workflows as enDomain } from '../en/workflows';

/** 贡献规范见 common.ts。 */

export const workflows: Record<keyof typeof enDomain, string> = {
  // ── 斜杠命令 ──
  'workflows.command.description': '查看 agent 树与子代理思维链',

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
  'workflows.hint.page': '翻页',

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
  'workflows.detail.title': '思维链',
  'workflows.detail.empty': '选择一个 agent 查看其思维链',
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

  // ── 耗时 ──
  'workflows.duration.seconds': '{count}秒',
  'workflows.duration.minutes': '{minutes}分{seconds}秒',
  'workflows.duration.hours': '{hours}小时{minutes}分',

  // ── 其他 ──
  'workflows.tooSmall': '终端窗口太小（至少需要 {width}x{height}）',
};

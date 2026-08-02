import type { tokenActivity as enDomain } from '../en/token-activity';

/** 贡献规范见 common.ts。 */

export const tokenActivity: Record<keyof typeof enDomain, string> = {
  // ── /status 统计页活动图（codex 52 周样式，本地数据）──
  'token-activity.summary': '累计 {total} · 峰值 {peak} · 连续 {streak}d',
  'token-activity.widen': '加宽终端以显示活动图',
  'token-activity.empty': '近 12 个月没有 token 活动',
  'token-activity.less': '少',
  'token-activity.more': '多',

  // 区间视图（/status Stats 页；codex view_footer + 柱状图说明）。
  'token-activity.range.daily': '每日',
  'token-activity.range.weekly': '每周',
  'token-activity.range.cumulative': '累计',
  'token-activity.weeklyCaption': '每列 = 1 周 · 最高 {peak}',
  'token-activity.cumulativeCaption': '累计总量 · 峰值 {total}',

  // 热力图月份标签行。`N月` 为全角 2 列宽，与英文缩写占位相当
  'token-activity.month.1': '1月',
  'token-activity.month.2': '2月',
  'token-activity.month.3': '3月',
  'token-activity.month.4': '4月',
  'token-activity.month.5': '5月',
  'token-activity.month.6': '6月',
  'token-activity.month.7': '7月',
  'token-activity.month.8': '8月',
  'token-activity.month.9': '9月',
  'token-activity.month.10': '10月',
  'token-activity.month.11': '11月',
  'token-activity.month.12': '12月',
};

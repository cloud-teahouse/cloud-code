import type { notices as enDomain } from '../en/notices';

/** 贡献规范见 common.ts。 */

export const notices: Record<keyof typeof enDomain, string> = {
  // ── Read 分组标题与正文 ──
  'notices.readGroup.reading': '读取 {count} 个文件…',
  'notices.readGroup.read': '读完 {count} 个文件',
  'notices.readGroup.lines.one': ' · {count} 行',
  'notices.readGroup.lines.other': ' · {count} 行',
  'notices.readGroup.failedSuffix': ' · 失败',
  'notices.readGroup.failedCount': ' · {count} 失败',
  'notices.readGroup.readingTail': ' · 读取中…',

  // ── 同名工具分组标题与正文 ──
  'notices.toolGroup.title': '{tool} ×{count}',
  'notices.toolGroup.runningSuffix': ' · {count} 个运行中…',
  'notices.toolGroup.failedSuffix': ' · 失败',
  'notices.toolGroup.failedCount': ' · {count} 失败',
  'notices.toolGroup.runningTail': ' · 运行中…',

  // ── `!` shell 运行卡片 ──
  'notices.shellRun.running': '运行中…',
  'notices.shellRun.overflow': '+{count} 行 ',
  'notices.shellRun.backgroundHint': '（ctrl+b 移到后台）',
  'notices.shellRun.outputUnavailable': '（输出不可用）',

  // ── cron 提醒卡片 ──
  'notices.cron.title.missed': '错过的定时提醒',
  'notices.cron.title.fired': '定时提醒已触发',
  'notices.cron.job': '任务 {id}',
  'notices.cron.oneShot': '单次',
  'notices.cron.coalesced': '合并了 {count} 次触发',
  'notices.cron.missed': '错过 {count} 次',
  'notices.cron.finalDelivery': '最终投递',

  // ── plan 框标题 ──
  'notices.plan.titlePrefix': ' 计划：',
  'notices.plan.title': ' 计划 ',
  'notices.plan.titleWithStatus': ' 计划{suffix} ',

  // ── thinking ──
  'notices.thinking.live': '思考中...',
  'notices.thinking.moreLines': '... （还有 {count} 行，ctrl+o 展开）',

  // ── 技能 / 插件命令卡片 ──
  'notices.skill.activated': '▶ 已激活技能：',
  'notices.plugin.invoked': '▶ 已调用命令：',
};

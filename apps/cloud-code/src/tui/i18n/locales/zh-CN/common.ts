import type { common as enCommon } from '../en/common';

/**
 * 简体中文 — 通用词条。
 *
 * 贡献规范：中文词条的显示列宽（汉字 2 列）不应超过英文原文，以免边框、
 * 对齐列爆裂；插值两侧保留半角空格（如 `{count} 轮`）。
 */

export const common: Record<keyof typeof enCommon, string> = {
  'common.hint.navigate': '↑↓ 移动',
  'common.hint.page': '←→ 翻页',
  'common.hint.select': 'Enter 选择',
  'common.hint.toggle': '空格 切换',
  'common.hint.confirm': 'Enter 确认',
  'common.hint.cancel': 'Esc 取消',
  'common.hint.back': 'Esc 返回',
  'common.hint.searchFocus': '/ ↑ 搜索',
  'common.hint.searchExit': 'Esc 返回列表',
  'common.currentMark': '← 当前',
  'common.searchPlaceholder': '搜索…',
  'common.noMatches': '无匹配项',
  'common.loading': '加载中…',
  'common.pageIndicator': '第 {page}/{total} 页',
  'common.tooSmall': '终端太窄（至少需要 {width} 列）',
};

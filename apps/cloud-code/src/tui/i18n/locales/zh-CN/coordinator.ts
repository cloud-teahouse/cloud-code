import type { coordinator as enDomain } from '../en/coordinator';

/** 贡献规范见 common.ts。 */

export const coordinator: Record<keyof typeof enDomain, string> = {
  // ── coordinator 模式标记 ──
  'coordinator.marker.activated': 'Coordinator 模式已激活',
  'coordinator.marker.deactivated': 'Coordinator 模式已关闭',

  // ── /coordinator 命令 ──
  'coordinator.command.usage': '用法：/coordinator [on|off]',
  'coordinator.command.alreadyOn': 'Coordinator 模式已处于开启状态。',
  'coordinator.command.alreadyOff': 'Coordinator 模式已处于关闭状态。',
  'coordinator.command.notEnabled': 'Coordinator 模式未开启。',
  'coordinator.command.enableFailed': '开启 Coordinator 模式失败：{error}',
  'coordinator.command.disableFailed': '关闭 Coordinator 模式失败：{error}',
} as const;

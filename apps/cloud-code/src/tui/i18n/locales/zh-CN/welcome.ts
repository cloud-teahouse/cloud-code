import type { welcome as enWelcome } from '../en/welcome';

/** 欢迎面板。贡献规范见 common.ts：显示列宽不超过英文原文。 */

export const welcome: Record<keyof typeof enWelcome, string> = {
  'welcome.title': '欢迎使用 Cloud Code CLI！',
  'welcome.getStarted.login': '运行 /login 或 /provider 开始使用。',
  'welcome.getStarted.help': '发送 /help 查看帮助信息。',
  'welcome.modelNotSet': '未设置，请运行 /login 或 /provider',
  'welcome.label.directory': '目录:',
  'welcome.label.session': '会话:',
  'welcome.label.model': '模型:',
  'welcome.label.version': '版本:',
  'welcome.label.mcp': 'MCP:',

  // 欢迎框下方的暗色提示，仅在非 release 构建渠道显示。
  'welcome.channelNote.dev': 'dev 版本，可能不稳定',
  'welcome.channelNote.beta': 'beta 版本，可能不稳定',

  // ── /dance 彩蛋 ──
  'welcome.dance.statusOn': '彩虹舞动中 — 用 {cmd} 关闭。',
  'welcome.dance.statusHint': '用 {cmd} 让彩虹常驻。',
};

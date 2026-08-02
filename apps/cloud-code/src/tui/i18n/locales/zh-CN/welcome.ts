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

  // 欢迎框下方的暗色提示，仅在非 release 构建渠道显示。两行：渠道含义 + 行动指引。
  'welcome.channelNote.dev':
    'dev 构建（内部开发版）——未经验证，可能随时损坏，不建议日常使用；\n本渠道不支持 /update。',
  'welcome.channelNote.beta':
    'beta 构建（main 滚动预发布）——改动最新，稳定性未经完整验证。\n问题反馈：github.com/cloud-teahouse/cloud-code/issues · 稳定版：npm i -g @cloud-teahouse/cloudcode-cli@latest',

  // ── /dance 彩蛋 ──
  'welcome.dance.statusOn': '彩虹舞动中 — 用 {cmd} 关闭。',
  'welcome.dance.statusHint': '用 {cmd} 让彩虹常驻。',
};

import type { utils as enDomain } from '../en/utils';

/** 贡献规范见 common.ts。 */

export const utils: Record<keyof typeof enDomain, string> = {
  // ── 后台任务 transcript 卡片（utils/background-task-status.ts） ──
  'utils.backgroundTask.subject.agent': 'agent 任务',
  'utils.backgroundTask.subject.question': 'question 任务',
  'utils.backgroundTask.subject.bash': 'bash 任务',
  'utils.backgroundTask.headline.started': '{subject} 已在后台启动',
  'utils.backgroundTask.headline.completed': '{subject} 已在后台完成',
  'utils.backgroundTask.headline.failed': '{subject} 在后台运行失败',
  'utils.backgroundTask.headline.timedOut': '{subject} 已超时',
  'utils.backgroundTask.headline.stopped': '{subject} 已停止',
  'utils.backgroundTask.headline.lost': '{subject} 已丢失',
  'utils.backgroundTask.detail.exit': '退出 {code}',
  'utils.backgroundTask.detail.stoppedReason': '已停止 — {reason}',
  'utils.backgroundTask.detail.stopped': '已停止',
  'utils.backgroundTask.detail.timedOut': '已超时',
  'utils.backgroundTask.detail.lost': '会话在完成前重启',

  // ── hook 结果 transcript 块（utils/hook-result-format.ts、utils/message-replay.ts） ──
  'utils.hookResult.title': '{event} hook',
  'utils.hookResult.titleBlocked': '{event} hook 已阻止',
  'utils.hookResult.empty': '（空）',

  // ── MCP 启动状态摘要（utils/mcp-server-status.ts） ──
  'utils.mcp.summary.failed': '{count} 失败',
  'utils.mcp.summary.needsAuth': '{count} 需授权',
  'utils.mcp.summary.connecting': '{count} 连接中',
  'utils.mcp.summary.connected': '{count} 已连接',
  'utils.mcp.summary.disabled': '{count} 已禁用',

  // ── shell 输出（utils/shell-output.ts） ──
  'utils.shellOutput.empty': '（无输出）',

  // ── 服务商错误负载（utils/event-payload.ts） ──
  'utils.eventPayload.providerFiltered':
    '服务商在可见输出前过滤了响应（finishReason={finishReason}{raw}）。',

  // ── tmux 键盘警告（utils/tmux-keyboard.ts；导出常量与此保持一致） ──
  'utils.tmux.extendedKeysOff':
    'tmux extended-keys 已关闭，带修饰键的 Enter 可能无法工作。请在 ~/.tmux.conf 中添加 `set -g extended-keys on` 并重启 tmux。',
  'utils.tmux.extendedKeysFormatXterm':
    'tmux extended-keys-format 为 xterm，Cloud Code CLI 使用 csi-u 效果最佳。请在 ~/.tmux.conf 中添加 `set -g extended-keys-format csi-u` 并重启 tmux。',

  // ── 反向 RPC（reverse-rpc/） ──
  'utils.reverseRpc.approvalHandlerFailed': '审批处理失败',
};

import type { controllers as enDomain } from '../en/controllers';

/** 贡献规范见 common.ts。 */

export const controllers: Record<keyof typeof enDomain, string> = {
  // ── 会话回放 ──
  'controllers.replay.historyUnavailable': '此会话的历史记录不可用。',
  'controllers.replay.goalUpdated': '目标已更新',
  'controllers.replay.planSentBackForRevision': '计划已退回修改',
  'controllers.replay.planReviewRejected': '计划评审已拒绝',
  'controllers.replay.planReviewCancelled': '计划评审已取消',
  'controllers.replay.feedbackDetail': '反馈：{feedback}',

  // ── /tasks 浏览器控制器 ──
  'controllers.tasksBrowser.noSession': '无活跃会话。',
  'controllers.tasksBrowser.loadFailed': '加载任务失败：{message}',
  'controllers.tasksBrowser.refreshFailed': '刷新失败：{message}',
  'controllers.tasksBrowser.refreshing': '刷新中…',
  'controllers.tasksBrowser.outputRefreshFailed': '刷新输出失败：{message}',
  'controllers.tasksBrowser.cannotOpenOutput': '无法打开输出：{message}',
  'controllers.tasksBrowser.stopping': '正在停止 {taskId}…',
  'controllers.tasksBrowser.stopFailed': '停止失败：{message}',
  'controllers.tasksBrowser.userInitiatedStop': '用户手动停止',
  'controllers.tasksBrowser.alreadyTerminal': '{taskId} 已结束，无需停止。',

  // ── /btw 面板 ──
  'controllers.btw.busyNotice': '请等待 /btw 完成后再发送新问题。',
  'controllers.btw.sendPromptFailed': '发送 /btw 提问失败：{message}',
  'controllers.btw.cancelFailed': '取消 /btw 失败：{message}',
  'controllers.btw.hookBlocked': 'Prompt hook 阻止了该请求。',
  'controllers.btw.turnEnded': 'BTW 轮次已结束，原因：{reason}',

  // ── 编辑器键盘 ──
  'controllers.editor.cancelCompactionFailed': '取消上下文压缩失败：{message}',
  'controllers.editor.noEditorConfigured':
    '未配置编辑器，请设置 $VISUAL / $EDITOR 或运行 /editor <command>。',
  'controllers.editor.externalEditorFailed': '外部编辑器失败：{message}',
  'controllers.editor.cancelledInputRecalled': '已取消，原文已回填可编辑。',

  // ── 剪贴板图片提示 ──
  'controllers.clipboardHint.imageInClipboard': '剪贴板中有图片 · 按 {shortcut} 粘贴',
};

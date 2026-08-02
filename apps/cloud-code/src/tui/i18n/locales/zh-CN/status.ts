import type { status as enDomain } from '../en/status';

/** 贡献规范见 common.ts。 */

export const status: Record<keyof typeof enDomain, string> = {
  // ── 会话启动 / 恢复 ──
  'status.sessionNotFound': '会话 "{id}" 不存在。',
  'status.sessionWrongDir': '会话 "{id}" 在其他工作目录下创建。',
  'status.noSessionsToContinue': '"{workDir}" 下没有可继续的会话；正在创建新会话。',
  'status.startupSessionMissing': '启动会话未初始化。',
  'status.providerModelsAdded.one': '{provider} · +{count} 模型。',
  'status.providerModelsAdded.other': '{provider} · +{count} 模型。',
  'status.providerRefreshSkipped': '已跳过刷新 {provider}：{reason}',

  // ── 会话切换 ──
  'status.resumeOtherWorkDir': '当前会话在其他工作目录中。\n  运行以下命令恢复：{command}',
  'status.commandCopied': '命令已复制到剪贴板',
  'status.commandCopyFailed': '复制命令到剪贴板失败',
  'status.alreadyOnSession': '已在此会话中。',
  'status.cannotSwitchWhileStreaming': '生成中无法切换会话 — 请先按 Esc 或 Ctrl-C。',
  'status.cannotSwitchWhileReplaying': '历史回放中无法切换会话。',
  'status.resumeSessionFailed': '恢复会话 {id} 失败：{message}',
  'status.sessionResumed': '已恢复会话（{id}）。',
  'status.replayFailed': '回放会话历史失败：{message}',
  'status.cannotNewWhileReplaying': '历史回放中无法创建新会话。',
  'status.newSessionFailed': '创建新会话失败：{message}',
  'status.postCreateSetupFailed': '会话创建后初始化失败：{message}',
  'status.newSessionStarted': '已创建新会话（{id}）。',
  'status.applyStartupFlagsFailed': '应用启动参数失败：{message}',

  // ── 输入 / 发送 ──
  'status.cannotSendWhileReplaying': '历史回放中无法发送输入。',
  'status.noActiveSessionForShell': '没有可执行 shell 命令的活动会话。',
  'status.modelNoImageInput': '当前模型不支持图片输入。',
  'status.modelNoVideoInput': '当前模型不支持视频输入。',
  'status.sendFailed': '发送失败：{message}',
  'status.mediaAttachmentFailed': '准备媒体附件失败：{message}',
  'status.skillFailed': '技能 "{name}" 失败：{message}',
  'status.pluginCommandFailed': '命令 "{id}" 失败：{message}',
  'status.steerFailed': '发送引导失败：{message}',

  // ── shell 命令（`!` 输入） ──
  'status.shellCommandFailed': 'shell 命令失败：{message}',
  'status.shellCancelFailed': '取消 shell 命令失败：{message}',

  // ── 移到后台（ctrl+b） ──
  'status.detach.noShellCommand': '没有正在运行的 shell 命令。',
  'status.detach.commandStarting': '命令仍在启动中 — 请重试。',
  'status.detach.commandFinished': '命令已结束。',
  'status.detach.failed': '移到后台失败：{message}',
  'status.detach.moved': '已移到后台。',
  'status.detach.movedHint': '已移到后台。/tasks 查看。',
  'status.detach.noForegroundTask': '没有正在运行的前台任务。',
  'status.detach.listTasksFailed': '列出任务失败：{message}',
  'status.detach.taskFailed': '任务 {id} 移到后台失败：{message}',
  'status.detach.tasksFinished.one': '任务已结束。',
  'status.detach.tasksFinished.other': '任务已结束。',
  'status.detach.movedTasks.one': '已将 {count} 个任务移到后台。',
  'status.detach.movedTasks.other': '已将 {count} 个任务移到后台。',
  'status.detach.movedTasksPartial': '已将 {detached}/{total} 个任务移到后台。',
  'status.detach.viewTasks': '/tasks 查看。',

  // ── 审批记录 ──
  'status.approval.approved': '已批准',
  'status.approval.approvedSession': '本次会话内已批准',
  'status.approval.approvedAlways': '已永久批准（规则已保存）',
  'status.approval.rejected': '已拒绝',
  'status.approval.cancelled': '已取消',

  // ── 登录提示 / spinner / 终端通知 ──
  'status.login.title': '登录 Cloud Code CLI',
  'status.login.hint': '按 Ctrl-C 取消',
  'status.login.waiting': '等待授权…',
  'status.login.prompt': '请在浏览器中打开下面的 URL 完成授权：',
  'status.login.codeLabel': '验证码：',
  'status.working': '工作中...',
  'status.notify.approvalRequired': 'Cloud Code CLI 需要审批',
  'status.notify.question': 'Cloud Code CLI 需要你的回答',
  'status.errorPrefix': '错误：{message}',

  // ── 会话/登录守卫（constant/cloud-code-tui.ts 存以下键，消费点 resolveDescription 解析） ──
  'status.llmNotSet': '未设置 LLM，发送 "/login" 登录',
  'status.noActiveSession': '无活动会话，发送 /login 登录。',
  'status.ctrlCHint': '再按一次 Ctrl+C 退出',
  'status.ctrlDHint': '再按一次 Ctrl+D 退出',
  'status.oauthLoginRequired': 'OAuth 登录已过期，发送 /login 登录。',

  // ── /feedback 状态行（constant/feedback.ts） ──
  'status.feedback.submitting': '正在提交反馈…',
  'status.feedback.uploading': '正在上传附件，可能需要几分钟…',
  'status.feedback.success': '反馈已提交，感谢！',
  'status.feedback.cancelled': '反馈已取消。',
  'status.feedback.networkError': '网络错误，反馈提交失败。',
  'status.feedback.fallback': '正在打开 GitHub Issues 作为回退…',
  'status.feedback.notSignedIn': '未登录，正在打开 GitHub Issues 提交反馈…',
  'status.feedback.uploadFailed': '反馈已发送；附件上传失败——见 feedback-upload.log。',
  'status.feedback.httpError': '反馈提交失败（HTTP {status}）。',
  'status.feedback.sessionLine': '会话：{sessionId}',
  'status.feedback.idLine': '反馈 ID：{feedbackId}',
  'status.feedback.errorReportHint':
    '若问题持续存在，请运行 `/export-debug-zip` 并将文件分享给我们以便诊断。请勿公开分享。',

  // ── 用户键位绑定文件（tui/keybindings/loader.ts） ──
  'status.keybindings.parseError': '{file}：{message}。已使用默认键位。',
  'status.keybindings.notAnObject': '{file}：应为「动作 → 键位」的对象。已使用默认键位。',
  'status.keybindings.unknownAction': '{file}：未知动作 "{action}"——已跳过。',
  'status.keybindings.invalidValue': '{file}："{action}" 的值应为键位字符串或字符串数组——已跳过。',
  'status.keybindings.reservedKey': '{file}："{key}" 为中断/退出保留键，不可改绑——已跳过 "{action}"。',
  'status.keybindings.conflict': '{file}："{key}" 被绑定到多个动作（{actions}）。',

  // ── TUI 配置文件（tui/config.ts） ──
  'status.tuiConfig.invalid': 'TUI 配置 ~/.cloud-code/tui.toml 无效，使用默认值。',

  // ── CLI 退出消息与启动错误（cli/run-shell.ts、cli/startup-error.ts） ──
  'status.exit.bye': '再见！',
  'status.exit.resume': '恢复此会话：cloudcode -r {sessionId}',
  'status.exit.openUrl': '打开 {url}',
  'status.startupError.failed': '错误：{operation} 失败：{message}',
  'status.startupError.operationDefault': '启动 shell',
  'status.startupError.messageLabel': '信息：',
  'status.scrollIndicator': '↓ 还有 {count} 行',
};

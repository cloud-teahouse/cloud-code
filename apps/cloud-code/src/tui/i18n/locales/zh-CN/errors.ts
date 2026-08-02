// 后端错误码 → 本地化可操作指引，附加在引擎原文 `[code] message` 之后（zh-CN）。
// 仅为指引文案——错误消息本体保持原文。

export const errors: Record<string, string> = {
  'errors.provider.api_error': '请检查 provider 状态或稍后重试。',
  'errors.provider.rate_limit': '请稍后重试或降低请求频率。',
  'errors.provider.quota_exhausted':
    'ChatGPT 套餐已用尽（{window}；{reset}）。可在 /status 的 ChatGPT 标签页查看，或用 /login 切换账号。',
  'errors.provider.auth_error': '请重新登录该 provider（见 /login）。',
  'errors.provider.connection_error': '请检查网络连接后重试。',
  'errors.context.overflow': '可运行 /compact 手动压缩、开新会话，或切换到更大窗口的模型别名。',
  'errors.session.closed': '会话已关闭；请重新打开或新建会话。',
  'errors.session.not_found': '会话可能已被移动或删除。',
  'errors.model.config_invalid': '请检查 config.toml 中的模型与 provider 条目。',
  'errors.auth.login_required': '请先运行 /login 登录对应 provider 再重试。',
  'errors.loop.max_steps_exceeded': '可在 config.toml 调大 loop_control.max_steps_per_turn 或拆分任务。',
  'errors.goal.not_found': '当前没有进行中的目标。',
  'errors.goal.already_exists': '如需新建请使用 replace。',
  'errors.goal.budget_reached': '目标已达其配置的预算上限。',
  'errors.mcp.connect_failed': '请检查 mcp.json 中该服务器的配置。',
};

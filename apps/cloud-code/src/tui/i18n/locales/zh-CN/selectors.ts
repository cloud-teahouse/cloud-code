import type { selectors as enDomain } from '../en/selectors';

/** 贡献规范见 common.ts。 */

export const selectors: Record<keyof typeof enDomain, string> = {
  // ── 输入对话框共享底栏 ──
  'selectors.inputDialog.footer': 'Enter 提交  ·  Esc 取消',

  // ── 实验性功能选择器 ──
  'selectors.experiments.title': '实验性功能',
  'selectors.experiments.hintPage': 'PgUp/PgDn 翻页',
  'selectors.experiments.hintToggle': 'Space 切换',
  'selectors.experiments.hintApply': 'Enter 应用',
  'selectors.experiments.apply': '[ 应用更改并重新加载 ]',
  'selectors.experiments.noChanges': '无更改',
  'selectors.experiments.change.one': '{count} 项更改',
  'selectors.experiments.change.other': '{count} 项更改',
  'selectors.experiments.enabled': '已启用',
  'selectors.experiments.disabled': '已禁用',
  'selectors.experiments.modified': '已修改',
  'selectors.experiments.lockedByMasterEnv': '由 CLOUD_CODE_EXPERIMENTAL_FLAG 锁定',
  'selectors.experiments.lockedByEnv': '由 {env} 锁定',
  'selectors.experiments.sourceConfig': '配置',
  'selectors.experiments.sourceDefault': '默认',

  // ── 目标队列管理器与编辑对话框 ──
  'selectors.goalQueue.title': '待处理目标',
  'selectors.goalQueue.hintNavigate': '↑↓ 移动 · Space 选择 · Alt+E 编辑 · Alt+D 删除 · Esc 取消',
  'selectors.goalQueue.hintReorder': '↑↓ 排序 · Space 完成 · Alt+E 编辑 · Alt+D 删除 · Esc 完成',
  'selectors.goalQueue.empty': '没有待处理的目标。',
  'selectors.goalQueue.selected': '已选中',
  'selectors.goalQueue.editTitle': '编辑待处理目标',
  'selectors.goalQueue.editSubtitle': '更新队列中的目标。',
  'selectors.goalQueue.editFooter': 'Enter 提交 · Shift-Enter/Ctrl-J 换行 · Esc 取消',
  'selectors.goalQueue.errorEmpty': '目标内容不能为空。',
  'selectors.goalQueue.errorTooLong': '目标内容不能超过 {max} 个字符。',
  'selectors.goalQueue.errorNotFound': '未找到排队目标。',
  'selectors.goalQueue.inputPrevious': '… {count} 行 ↑',
  'selectors.goalQueue.inputMore': '… {count} 行 ↓',

  // ── 任务输出查看器 ──
  'selectors.taskOutput.title': '任务输出',
  'selectors.taskOutput.noOutput': '[未捕获到输出]',
  'selectors.taskOutput.exitCode': '退出 {code}',
  'selectors.taskOutput.status.running': '运行中',
  'selectors.taskOutput.status.completed': '已完成',
  'selectors.taskOutput.status.failed': '失败',
  'selectors.taskOutput.status.timedOut': '已超时',
  'selectors.taskOutput.status.killed': '已终止',
  'selectors.taskOutput.status.lost': '丢失',
  'selectors.taskOutput.key.line': '行',
  'selectors.taskOutput.key.page': '翻页',
  'selectors.taskOutput.key.topBot': '顶/底',
  'selectors.taskOutput.key.cancel': '取消',

  // ── 思考强度选择器 ──
  'selectors.effort.title': '选择思考强度',
  'selectors.effort.hintSwitch': '←→ 切换',

  // ── 自定义注册表导入 ──
  'selectors.registryImport.title': '导入自定义提供商注册表',
  'selectors.registryImport.subtitle': '粘贴 api.json URL 及其 Bearer token。',
  'selectors.registryImport.urlEmpty': '注册表 URL 不能为空。',
  'selectors.registryImport.tokenEmpty': 'Bearer token 不能为空。',
  'selectors.registryImport.footerNext': 'Tab / ↑↓ 切换  ·  Enter 下一项  ·  Esc 取消',
  'selectors.registryImport.footerSubmit': 'Tab / ↑↓ 切换  ·  Enter 提交  ·  Esc 取消',
  'selectors.registryImport.urlLabel': '注册表 URL',
  'selectors.registryImport.tokenLabel': 'Bearer token',

  // ── 上下文压缩块 ──
  'selectors.compaction.compacting': '正在压缩上下文...',
  'selectors.compaction.complete': '上下文压缩完成',
  'selectors.compaction.cancelled': '上下文压缩已取消',
  'selectors.compaction.tokens': ' ({before} → {after} tokens)',
  'selectors.compaction.hintShow': '（Ctrl-O 展开压缩摘要）',
  'selectors.compaction.hintHide': '（Ctrl-O 收起压缩摘要）',
  'selectors.compaction.tip': ' · 提示 {tip}',
  'selectors.compaction.phase.building': '构建请求',
  'selectors.compaction.phase.summarizing': '生成摘要',
  'selectors.compaction.phase.finishing': '收尾',
  'selectors.compaction.progressLine': '  {bar} {percent}% · {phase} · {seconds}秒',

  // ── 权限模式选择器 ──
  'selectors.permission.manual.label': '手动',
  'selectors.permission.manual.description': '每个操作都由你亲自批准。',
  'selectors.permission.yolo.label': 'YOLO',
  'selectors.permission.yolo.description': '自动批准工具操作，但代理仍可能提问。',
  'selectors.permission.auto.label': '自动',
  'selectors.permission.auto.description': '完全自主，代理自行决定一切，不再询问。',

  // ── 反馈输入对话框 ──
  'selectors.feedback.title': '向 Cloud Code CLI 发送反馈',
  'selectors.feedback.subtitle': '告诉我们哪些好用、哪些不好用。',
  'selectors.feedback.empty': '反馈不能为空。',

  // ── 编辑器选择器 ──
  'selectors.editor.title': '选择外部编辑器',
  'selectors.editor.autoDetect': '自动检测（$VISUAL / $EDITOR）',

  // ── 更新偏好选择器 ──
  'selectors.update.on.label': '开',
  'selectors.update.on.description': '在后台安装新版本。',
  'selectors.update.off.label': '关',
  'selectors.update.off.description': '改为显示安装提示。',

  // ── 全屏模式选择器 ──
  'selectors.fullscreen.on.label': '开',
  'selectors.fullscreen.on.description': '全屏界面：输入框与状态栏固定底槽，应用内滚动。',
  'selectors.fullscreen.off.label': '关',
  'selectors.fullscreen.off.description': '经典内联回滚；不捕获鼠标——适合手机终端。',

  // ── API key 输入对话框 ──
  'selectors.apiKey.title': '输入 {platform} 的 API key',
  'selectors.apiKey.empty': 'API key 不能为空。',

  // ── base URL 输入对话框（从目录导入 provider）──
  'selectors.baseUrl.title': '输入 {platform} 的 base URL',
  'selectors.baseUrl.subtitle': '目录未声明该 provider 的端点 —— 请输入其 base URL。',
  'selectors.baseUrl.empty': 'base URL 不能为空。',

  // ── 平台选择器 ──
  'selectors.platform.title': '选择平台',

  // ── 分页模型选择器 ──
  'selectors.modelTabs.all': '全',

  // ── /import 来源选择器 ──
  'selectors.import.source.title': '选择导入来源…',
  'selectors.import.source.claude.label': 'Claude Code',
  'selectors.import.source.claude.description':
    '从 ~/.claude 导入指令、技能和 MCP 配置（交互式，由模型协助）。',
  'selectors.import.source.codex.label': 'Codex',
  'selectors.import.source.codex.description':
    '从 ~/.codex 导入指令、技能和 MCP 配置（交互式，由模型协助）。',
  'selectors.import.source.kimi.label': 'Kimi Code',
  'selectors.import.source.kimi.description':
    '从 ~/.kimi-code 导入配置、快捷键、MCP、技能、AGENTS.md、会话和输入历史（确定性导入）。',

  // ── /import 确认选择器 ──
  'selectors.import.confirm.title': '确认导入计划',
  'selectors.import.confirm.tomlNote':
    '注意：写回 config.toml 会重新序列化——值保持不变，但注释和格式会被归一化。',
  'selectors.import.confirm.snapshotNote':
    '以上计划是扫描快照——确认前请勿在其他会话中修改目标文件。',
  'selectors.import.confirm.apply.label': '执行导入',
  'selectors.import.confirm.apply.description': '导入上面列出的项；保留现有项，跳过冲突项。',
  'selectors.import.confirm.applyRename.label': '执行导入（冲突技能重命名）',
  'selectors.import.confirm.applyRename.description':
    '同时将 {count} 个冲突技能以 -kimi 后缀名导入。',
  'selectors.import.confirm.cancel.label': '取消',
  'selectors.import.confirm.cancel.description': '不导入任何内容。',

  // ── /import 凭证可选导入 ──
  'selectors.import.credentials.title': '是否同时复制 OAuth 凭证？',
  'selectors.import.credentials.notice':
    '凭证文件包含 OAuth 访问令牌和刷新令牌。复制后本安装将使用同一账号登录。请仅在可信任的设备上操作。',
  'selectors.import.credentials.no.label': '否（推荐）',
  'selectors.import.credentials.no.description': '不动凭证；如需登录请单独进行。',
  'selectors.import.credentials.yes.label': '是，复制凭证',
  'selectors.import.credentials.yes.description': '仅复制此处不存在的令牌文件；绝不覆盖现有文件。',
  'selectors.import.credentials.skipped': '未改动凭证。',
  'selectors.import.credentials.done': '已复制 {count} 个凭证文件。',
  'selectors.import.credentials.none': '未复制任何凭证文件。',
};

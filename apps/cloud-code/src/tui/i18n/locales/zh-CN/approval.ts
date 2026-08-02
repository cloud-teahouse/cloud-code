import type { approval as enApproval } from '../en/approval';

/** 审批对话框：选项、标题、危险标签、提示。贡献规范见 common.ts。 */

export const approval: Record<keyof typeof enApproval, string> = {
  // ── 选项 ──
  'approval.choice.approveOnce': '批准一次',
  'approval.choice.approveSession': '本次会话内批准',
  'approval.choice.approveAlways': '始终批准',
  'approval.choice.approveAlwaysDescription': '将权限规则保存到用户配置，此后永久批准',
  'approval.choice.reject': '拒绝',
  'approval.choice.rejectWithFeedback': '拒绝并反馈意见',
  'approval.choice.revise': '修改',
  'approval.choice.approve': '批准',
  'approval.choice.approveKeepModeDescription': '保持当前权限模式',
  'approval.choice.approveWithAuto': '批准并切换到 Auto 模式',
  'approval.choice.approveWithAutoDescription': '执行计划期间自动批准工具操作，并跳过提问。',
  'approval.choice.approveWithFeedback': '批准并附言',

  // ── 面板标题 ──
  'approval.header.bash': '运行此命令？',
  'approval.header.write': '写入此文件？',
  'approval.header.edit': '应用这些修改？',
  'approval.header.taskStop': '停止此任务？',
  'approval.header.exitPlanMode': '按此计划开始实现？',
  'approval.header.default': '批准 {tool}？',

  // ── 工人徽标（approval-panel.ts）：teammate 桥接审批（A4）──
  'approval.requesterBadge': '来自 teammate {name}（团队：{team}）',
  'approval.requesterBadgeNoTeam': '来自 teammate {name}',

  // ── 危险标签 ──
  'approval.dangerous': '危险：{label}',
  'approval.danger.recursiveDelete': '递归删除',
  'approval.danger.sudo': 'sudo',
  'approval.danger.pipeToShell': '管道到 shell',
  'approval.danger.ddWrite': 'dd 写入',
  'approval.danger.mkfs': 'mkfs',
  'approval.danger.rawDevice': '写入裸设备',
  'approval.danger.chmod777': 'chmod 777',
  'approval.danger.forkBomb': 'fork 炸弹',

  // ── 提示 ──
  'approval.hint.feedback': '输入反馈 · ↵ 提交。',
  'approval.hint.select': '↑/↓ 选择 · {numbers} 选定 · ↵ 确认',
  'approval.hint.preview': ' · ctrl+e 预览',
  'approval.expandHint': 'ctrl+e 预览',
  'approval.hiddenLines.one': '     … 还有 {count} 行未显示（ctrl+e 预览）',
  'approval.hiddenLines.other': '     … 还有 {count} 行未显示（ctrl+e 预览）',

  // ── 展示块（approval-panel.ts）──
  'approval.displayBlock.search': '搜索',
  'approval.displayBlock.backgroundTask': '{status} {kind} 任务 {id}：{description}',

  // ── 请求描述 ──
  'approval.desc.goalStart': '启动目标？',
  'approval.desc.edit': '编辑 {path}',
  'approval.desc.fileOp': '{operation} {path}',
  'approval.desc.taskStop': '停止任务：{task}',
  'approval.desc.spawnAgent': '启动子代理 {name}',
  'approval.desc.invokeSkill': '调用技能 {name}',
  'approval.desc.fetch': '抓取 {url}',
  'approval.desc.search': '搜索：{query}',
  'approval.desc.todoList': '更新待办列表（{count} 项）',
  'approval.desc.task': '{status} 任务 {id}：{description}',
  'approval.goalStart.title': '启动目标：{objective}',
  'approval.goalStart.doneWhen': '完成条件：{criterion}',
  'approval.taskStop.brief': '停止任务 {id}：{description}',

  // ── 启动权限提示（goal/swarm 共用） ──
  'approval.startPrompt.hint': ' ↑↓ 移动 · Enter 选择 · Esc 取消',
  'approval.startPrompt.switchAuto.label': '切换到 Auto 并启动',
  'approval.startPrompt.switchYolo.label': '切换到 YOLO 并启动',
  'approval.startPrompt.switchYolo.description':
    '工具和计划变更会自动批准。Cloud Code CLI 仍会向你提问。',
  'approval.startPrompt.startManual.label': '以 Manual 启动',
  'approval.startPrompt.notice.manualAsk':
    'Manual 模式会在 Cloud Code CLI 运行命令、编辑文件或采取其他风险操作前询问你。',
  'approval.startPrompt.notice.goBack': '你可以返回，命令不会丢失。',

  // ── 目标启动提示 ──
  'approval.goalStartPrompt.title.manual': '在开启审批的情况下启动目标？',
  'approval.goalStartPrompt.title.yolo': '在 YOLO 模式下启动目标？',
  'approval.goalStartPrompt.switchAuto.description':
    '适合你离开时让 Cloud Code CLI 持续工作。工具自动批准，并跳过提问。',
  'approval.goalStartPrompt.keepYolo.label': '保持 YOLO 并启动',
  'approval.goalStartPrompt.keepYolo.description':
    '工具和计划变更保持自动批准。Cloud Code CLI 仍会向你提问。',
  'approval.goalStartPrompt.startManual.description':
    '保留审批。Cloud Code CLI 会在风险操作前询问，目标可能暂停等待你。',
  'approval.goalStartPrompt.doNotStart.label': '不启动',
  'approval.goalStartPrompt.doNotStart.description': '带着目标命令返回输入框。',
  'approval.goalStartPrompt.notice.unattended': 'Manual 模式不适合无人值守的目标工作。',
  'approval.goalStartPrompt.notice.yoloApproves': 'YOLO 模式自动批准工具和计划变更。',
  'approval.goalStartPrompt.notice.yoloQuestions': 'YOLO 模式仍可能因提问而暂停。',
  'approval.goalStartPrompt.notice.switchAuto': '若想在目标工作中跳过提问，请切换到 Auto。',

  // ── Swarm 启动提示 ──
  'approval.swarmStartPrompt.title': '在开启审批的情况下启动 swarm 任务？',
  'approval.swarmStartPrompt.switchAuto.description':
    '最适合 swarm 任务。工具自动批准，并跳过提问。',
  'approval.swarmStartPrompt.startManual.description':
    '保留审批。Cloud Code CLI 可能在 swarm 任务中暂停等待你。',
  'approval.swarmStartPrompt.notice.blockSwarm': 'Manual 模式会在代理运行时阻塞 swarm 工作。',

  // ── Coordinator 启动提示 ──
  'approval.coordinatorStartPrompt.title': '在开启审批的情况下进入 Coordinator 模式？',
  'approval.coordinatorStartPrompt.switchAuto.description':
    '最适合协调运行的任务。工具自动批准，并跳过提问。',
  'approval.coordinatorStartPrompt.startManual.description':
    '保留审批。worker 运行时 Cloud Code CLI 可能暂停等待你。',
  'approval.coordinatorStartPrompt.notice.blockWorkers':
    'Manual 模式会在代理运行时阻塞 worker 进度。',

  // ── 预览查看器 ──
  'approval.preview.title': ' 预览 ',
  'approval.preview.line': '行',
  'approval.preview.page': '页',
  'approval.preview.topBot': '顶/底',
  'approval.preview.cancel': '取消',
};

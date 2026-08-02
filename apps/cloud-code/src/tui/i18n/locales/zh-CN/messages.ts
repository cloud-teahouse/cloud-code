import type { messages as enDomain } from '../en/messages';

/** 工具调用记录：动词、状态标签、chip 与摘要。贡献规范见 common.ts。 */

export const messages: Record<keyof typeof enDomain, string> = {
  // ── 工具调用标题动词与标签 ──
  'messages.toolCall.verb.using': '使用',
  'messages.toolCall.verb.used': '已使用',
  'messages.toolCall.verb.truncated': '已截断',
  'messages.toolCall.bash.ran': '已运行命令',
  'messages.toolCall.bash.running': '正在运行命令',
  'messages.toolCall.glob.includeIgnored': ' · 含忽略文件',
  'messages.toolCall.detachHint': '按 Ctrl+B 在后台运行',
  'messages.toolCall.argsTruncated': '工具调用参数达到 max_tokens — 调用未执行。',

  // ── ExitPlanMode / 计划审批 ──
  'messages.toolCall.plan.current': '当前计划',
  'messages.toolCall.plan.approved': '已批准',
  'messages.toolCall.plan.approvedWithChoice': '已批准：{chosen}',
  'messages.toolCall.plan.autoApproved': ' · 自动批准',
  'messages.toolCall.plan.rejected': '已拒绝',
  'messages.toolCall.plan.suggestion': '↪ 建议',

  // ── AskUserQuestion ──
  'messages.toolCall.ask.couldNotCollect': '无法收集你的输入',
  'messages.toolCall.ask.startedBackground': '已发起后台提问',
  'messages.toolCall.ask.collected': '已收集你的回答',
  'messages.toolCall.ask.startingBackground': '正在发起后台提问',
  'messages.toolCall.ask.waiting': '等待你的输入',
  'messages.toolCall.ask.dismissed': '用户忽略了该问题。',

  // ── 子代理卡片 ──
  'messages.toolCall.subagent.label': '子代理 ({id})',
  'messages.toolCall.subagent.labelWithName': '子代理 {name} ({id})',
  'messages.toolCall.subagent.moreToolCalls.one': '还有 {count} 次调用 ...',
  'messages.toolCall.subagent.moreToolCalls.other': '还有 {count} 次调用 ...',
  'messages.toolCall.subagent.phase.queued': '○ 排队',
  'messages.toolCall.subagent.phase.starting': '↻ 启动中…',
  'messages.toolCall.subagent.phase.running': '↻ 运行中',
  'messages.toolCall.subagent.phase.done': '✓ 完成',
  'messages.toolCall.subagent.phase.failed': '✗ 失败',
  'messages.toolCall.subagent.phase.backgrounded': '◐ 后台运行',
  'messages.toolCall.subagent.status.completed': '已完成',
  'messages.toolCall.subagent.status.failed': '失败',
  'messages.toolCall.subagent.status.running': '运行中',
  'messages.toolCall.subagent.status.backgrounded': '后台运行',
  'messages.toolCall.subagent.status.queued': '排队中',
  'messages.toolCall.subagent.status.starting': '启动中',
  'messages.toolCall.toolCount.one': '{count} 个工具',
  'messages.toolCall.toolCount.other': '{count} 个工具',
  'messages.toolCall.bg.lost': '后台代理丢失（会话在完成前重启）',
  'messages.toolCall.bg.killed': '后台代理被终止',
  'messages.toolCall.bg.timedOut': '后台代理超时',
  'messages.toolCall.bg.failed': '后台代理失败',

  // ── 流式预览 ──
  'messages.toolCall.write.moreLines': '... （还有 {count} 行，共 {total} 行，ctrl+o 展开）',
  'messages.toolCall.edit.preparing': '正在准备更改... {size} · 耗时 {elapsed}',
  'messages.toolCall.edit.preparingFor': '正在为 {path} 准备更改... {size} · 耗时 {elapsed}',

  // ── AgentSwarm 结果摘要 ──
  'messages.toolCall.swarm.prefix': 'Agent 集群： ',
  'messages.toolCall.swarm.completed': '✓ {count} 已完成',
  'messages.toolCall.swarm.failed': '✗ {count} 失败',
  'messages.toolCall.swarm.aborted': '⊘ {count} 已中止',
  'messages.toolCall.swarm.label.completed': '✓ 已完成。',
  'messages.toolCall.swarm.label.failed': '✗ 失败。',
  'messages.toolCall.swarm.label.aborted': '⊘ 已中止。',

  // ── 标题 chip ──
  'messages.chip.lines.one': '{count} 行',
  'messages.chip.lines.other': '{count} 行',
  'messages.chip.matches.one': '{count} 处匹配',
  'messages.chip.matches.other': '{count} 处匹配',
  'messages.chip.noMatches': '无匹配',
  'messages.chip.files.one': '{count} 个文件',
  'messages.chip.files.other': '{count} 个文件',
  'messages.chip.noFiles': '无文件',
  'messages.chip.results.one': '{count} 条结果',
  'messages.chip.results.other': '{count} 条结果',
  'messages.chip.noResults': '无结果',
  'messages.chip.webResult': '网页结果',
  'messages.chip.mediaUploaded': '{kind} · 已上传',
  'messages.chip.noGoal': '无目标',

  // ── goal 工具 ──
  'messages.goal.create.failed': '无法启动目标',
  'messages.goal.create.done': '已启动目标',
  'messages.goal.create.running': '正在启动目标',
  'messages.goal.check.failed': '无法查看目标',
  'messages.goal.check.done': '已查看目标',
  'messages.goal.check.running': '正在查看目标',
  'messages.goal.budget.failed': '无法设置目标预算',
  'messages.goal.budget.done': '已设置目标预算',
  'messages.goal.budget.running': '正在设置目标预算',
  'messages.goal.report.failed': '无法上报目标 {status}',
  'messages.goal.report.done': '已上报目标 {status}',
  'messages.goal.report.running': '正在上报目标 {status}',
  'messages.goal.statusFallback': '状态',
  'messages.goal.noCurrentGoal': '  当前没有目标。',
  'messages.goal.statusLine': '目标 {status}：{objective}',
  'messages.goal.status.active': '进行中',
  'messages.goal.status.paused': '已暂停',
  'messages.goal.status.blocked': '已阻塞',
  'messages.goal.status.complete': '已完成',
  'messages.goal.turns.one': '{count} 轮',
  'messages.goal.turns.other': '{count} 轮',
  'messages.goal.tokens': '{count} tokens',

  // ── 速览摘要与截断输出 ──
  'messages.summary.more': ', +{count} 更多',
  'messages.truncated.moreLines': '... （还有 {count} 行）',
  'messages.truncated.moreLinesExpand': '... （还有 {count} 行，ctrl+o 展开）',
  'messages.truncated.earlierLines': '... （之前 {count} 行）',

  // ── diff 预览（diff-preview.ts）──
  'messages.diff.moreChangesHidden.one': '还有 {count} 处修改未显示（{hint} 展开）',
  'messages.diff.moreChangesHidden.other': '还有 {count} 处修改未显示（{hint} 展开）',
  'messages.diff.unchangedLines.one': '{count} 行未变更',
  'messages.diff.unchangedLines.other': '{count} 行未变更',
};

import type { toolResults as enDomain } from '../en/tool-results';

/**
 * 简体中文 — 工具结果的本地化渲染（`ToolResultDisplayRef` 键）。模型看到的
 * 工具输出保持英文；当工具结果携带 display 指针时，TUI 向用户展示这里的
 * 译文。贡献规范见 common.ts。
 */

export const toolResults: Record<keyof typeof enDomain, string> = {
  // ── worktree ──
  'toolResult.worktree.enter.created':
    '已在 {path} 创建 worktree，分支为 {branch}（基于 {base}）。' +
    '会话现在 worktree 内工作——所有工具都在其中运行。' +
    '使用 ExitWorktree 可在会话中途退出（保留或删除）；如果会话在 worktree 内结束，' +
    'worktree 及其分支会保留在磁盘上，恢复会话时会重新挂载。',
  'toolResult.worktree.enter.createdCarried':
    '已在 {path} 创建 worktree，分支为 {branch}（基于 {base}）。' +
    '已从原检出携带 {count} 个被 gitignore 的文件（.worktreeinclude）。' +
    '会话现在 worktree 内工作——所有工具都在其中运行。' +
    '使用 ExitWorktree 可在会话中途退出（保留或删除）；如果会话在 worktree 内结束，' +
    'worktree 及其分支会保留在磁盘上，恢复会话时会重新挂载。',
  'toolResult.worktree.enter.resumed':
    '已重新挂载到位于 {path} 的现有 worktree，分支为 {branch}。' +
    '会话现在 worktree 内工作——所有工具都在其中运行。' +
    '使用 ExitWorktree 可退出（保留或删除）。',
  'toolResult.worktree.exit.kept':
    '已退出 worktree。你的工作保留在 {path}（分支 {branch}）。会话已回到 {cwd}。',
  'toolResult.worktree.exit.removed':
    '已退出并删除位于 {path} 的 worktree。会话已回到 {cwd}。',
  'toolResult.worktree.exit.removedWithDiscards':
    '已退出并删除位于 {path} 的 worktree。' +
    '丢弃的提交：{commits}，未提交的文件：{files}。会话已回到 {cwd}。',
  'toolResult.worktree.exit.blockedByAgents':
    '拒绝删除位于 {path} 的 worktree：仍有 {count} 个子代理锚定在其中（{agents}），' +
    '删除会使它们丢失工作目录。请先停止这些子代理，或选择保留 worktree。',

  // ── memory ──
  'toolResult.memory.saved':
    '记忆已保存到 {memoryPath}，并已更新 {indexPath}。' +
    'MEMORY.md 索引会注入后续会话的系统提示；记忆文件本身按需读取。',

  // ── team（TeamTask* 与 SendMessage 共用的名称校验）──
  'toolResult.team.teamNameRequired':
    '需要提供 team_name：显式传入团队名称，或在属于某个团队的 teammate 中调用。',
  'toolResult.team.teamNameInvalid':
    '团队名称"{team}"无效：请使用字母、数字、短横线或下划线，并以字母或数字开头。',

  // ── TeamTask* ──
  'toolResult.teamTask.created': '已在团队"{team}"中创建任务 #{id}：{subject}',
  'toolResult.teamTask.updated': '已更新团队"{team}"中的任务 #{id}：{subject}',
  'toolResult.teamTask.nothingToUpdate':
    '没有可更新的内容：请至少传入 status、owner、subject、description 之一。',
  'toolResult.teamTask.notFound': '团队"{team}"中不存在任务 #{id}。',
  'toolResult.teamTask.ownedByOther':
    '任务 #{id} 属于"{owner}"，而不是你（"{caller}"）。teammate 只能更新自己的任务。',
  'toolResult.teamTask.cannotReassign':
    'teammate 不能重新分配任务归属。请让 leader 重新分配。',
  'toolResult.teamTask.noTeam':
    '团队"{team}"尚不存在。使用 TeamTaskCreate 创建任务即可建立共享任务列表。',
  'toolResult.teamTask.listEmpty': '团队"{team}"没有任务。',
  'toolResult.teamTask.claimed':
    '已认领团队"{team}"中的任务 #{id}（owner：{owner}，状态：in_progress）：{subject}。' +
    '请将其作为你的新目标；完成后用 TeamTaskUpdate 将任务标记为已完成。',
  'toolResult.teamTask.noneClaimable':
    '团队"{team}"中没有可认领的任务——队列为空，或所有待处理任务都已有 owner。' +
    '请向 leader 汇报，不要循环轮询。',
  'toolResult.teamTask.claimNotTeammate':
    '只有 teammate 才能认领任务——认领者身份来自 teammate 运行时上下文，而不是参数。' +
    'leader 应在创建时分配工作（TeamTaskCreate 的 owner）。',
  'toolResult.teamTask.claimNoTeam':
    'teammate"{name}"不属于任何团队，因此无法认领任务。' +
    '生成 teammate 时传入 team_name 即可让其访问共享任务列表。',

  // ── SendMessage ──
  'toolResult.sendMessage.sent':
    '消息已发送给团队"{team}"中的"{to}"（id：{id}）。' +
    '正在运行的 teammate 会在运行途中收到；否则将在其下次恢复时送达。',
  'toolResult.sendMessage.sentLeader':
    '消息已发送给团队"{team}"的 leader（id：{id}）。leader 会在稍后的回合收到通知。',
  'toolResult.sendMessage.permissionApprovalSent':
    '已向团队"{team}"中的"{to}"发送权限批准（请求 {requestId}，id：{id}）。',
  'toolResult.sendMessage.permissionRejectionSent':
    '已向团队"{team}"中的"{to}"发送权限拒绝（请求 {requestId}，id：{id}）。',
  'toolResult.sendMessage.shutdownSent':
    '已向团队"{team}"中的"{to}"发送关闭请求（id：{id}）。' +
    'teammate 在任务停止前有一段短暂的收尾时间；它确认后你会收到通知。',
  'toolResult.sendMessage.cannotSendToSelf': '不能给自己发送消息。',
  'toolResult.sendMessage.leaderOnly':
    '只有 leader 才能发送 {type}。teammate 之间使用纯文本消息。',
  'toolResult.sendMessage.cannotSendStructuredToLeader': '不能向 leader 发送 {type}。',

  // ── cron ──
  'toolResult.cron.createdRecurring':
    '已创建循环定时任务 {id}（{cron}）；下次触发 {nextFireAt}。',
  'toolResult.cron.createdOnce':
    '已创建一次性定时任务 {id}（{cron}）；将于 {nextFireAt} 触发。',
  'toolResult.cron.createdRecurringProject':
    '已创建循环定时任务 {id}（{cron}）；下次触发 {nextFireAt}。项目级持久——通过 {projectFile} 共享。',
  'toolResult.cron.createdOnceProject':
    '已创建一次性定时任务 {id}（{cron}）；将于 {nextFireAt} 触发。项目级持久——通过 {projectFile} 共享。',
  'toolResult.cron.deleted': '已删除定时任务 {id}。',
  'toolResult.cron.deletedProject': '已删除定时任务 {id}（项目计划）。',
  'toolResult.cron.notFound': '没有 id 为 {id} 的定时任务。',
  'toolResult.cron.invalidId': '定时任务 id {id} 无效——必须是 8 位小写十六进制字符。',
  'toolResult.cron.listEmpty': '没有已计划的定时任务。',

  // ── ExitPlanMode ──
  'toolResult.exitPlanMode.dismissed': '计划审批已取消。计划模式仍然激活。',
  'toolResult.exitPlanMode.revisionsRequested': '用户请求修改计划。计划模式仍然激活。',
  'toolResult.exitPlanMode.notInPlanMode':
    'ExitPlanMode 只能在计划模式激活时调用。请先使用 EnterPlanMode（或 /plan）。',
  'toolResult.exitPlanMode.noPlanFile':
    '未找到计划文件。请先将计划写入当前计划文件，然后调用 ExitPlanMode。',
  'toolResult.exitPlanMode.noPlanFileAtPath':
    '未找到计划文件。请先将计划写入 {path}，然后调用 ExitPlanMode。',
  'toolResult.exitPlanMode.readFailed': '读取计划文件失败：{error}',
  'toolResult.exitPlanMode.exitFailed': '退出计划模式失败：{error}',

  // ── Agent ──
  'toolResult.agent.backgroundLaunched':
    '已在后台启动子代理 {agentId}（任务 {taskId}）。完成后会自动通知你。',

  // ── Bash / 后台任务 ──
  'toolResult.bash.backgroundStarted': '已在后台运行（任务 {taskId}）。完成后会自动通知你。',
  'toolResult.taskStop.stopped': '已停止任务 {taskId}（状态：{status}）。原因：{reason}。',
  'toolResult.taskStop.notFound': '未找到任务：{taskId}',
  'toolResult.taskStop.stopFailed': '停止任务失败：{taskId}',

  // ── goal ──
  'toolResult.goal.invalidStatus': '目标状态无效。请使用 `active`、`complete` 或 `blocked`。',
  'toolResult.goal.completionGateRejected': '目标未完成：完成门禁拒绝了本次尝试。目标仍处于激活状态。',
};

/**
 * Localized renderings of tool results (`ToolResultDisplayRef` keys). The
 * model-facing tool output stays English; these strings are what the TUI
 * shows the user when a tool result carries a display pointer. Counts use
 * label-style phrasing ("Discarded commits: {commits}") so templates never
 * need English plural agreement. See common.ts for contribution rules.
 */

export const toolResults = {
  // ── worktree ──
  'toolResult.worktree.enter.created':
    'Created worktree at {path} on branch {branch} (based on {base}). ' +
    'The session now works inside the worktree — all tools run there. ' +
    'Use ExitWorktree to leave mid-session (keep or remove); if the session ends while inside, ' +
    'the worktree stays on disk with its branch, and resuming the session restores it.',
  'toolResult.worktree.enter.createdCarried':
    'Created worktree at {path} on branch {branch} (based on {base}). ' +
    'Carried gitignored files from the original checkout (.worktreeinclude): {count}. ' +
    'The session now works inside the worktree — all tools run there. ' +
    'Use ExitWorktree to leave mid-session (keep or remove); if the session ends while inside, ' +
    'the worktree stays on disk with its branch, and resuming the session restores it.',
  'toolResult.worktree.enter.resumed':
    'Re-attached to existing worktree at {path} on branch {branch}. ' +
    'The session now works inside the worktree — all tools run there. ' +
    'Use ExitWorktree to leave (keep or remove).',
  'toolResult.worktree.exit.kept':
    'Exited worktree. Your work is preserved at {path} on branch {branch}. ' +
    'Session is now back in {cwd}.',
  'toolResult.worktree.exit.removed':
    'Exited and removed worktree at {path}. Session is now back in {cwd}.',
  'toolResult.worktree.exit.removedWithDiscards':
    'Exited and removed worktree at {path}. ' +
    'Discarded commits: {commits}, uncommitted files: {files}. ' +
    'Session is now back in {cwd}.',
  'toolResult.worktree.exit.blockedByAgents':
    'Refusing to remove worktree at {path}: {count} subagent(s) are still anchored inside ' +
    'it ({agents}) and would lose their working directory. Stop them first, or keep the worktree.',

  // ── memory ──
  'toolResult.memory.saved':
    'Saved memory to {memoryPath} and updated {indexPath}. ' +
    "The MEMORY.md index is injected into future sessions' system prompts; " +
    'the memory file itself is read on demand.',

  // ── team (name validation shared by TeamTask* and SendMessage) ──
  'toolResult.team.teamNameRequired':
    'team_name is required: pass the team explicitly, or call from a teammate that belongs to one.',
  'toolResult.team.teamNameInvalid':
    'Invalid team name "{team}": use letters, digits, dashes, or underscores, starting with a letter or digit.',

  // ── TeamTask* ──
  'toolResult.teamTask.created': 'Created task #{id} in team "{team}": {subject}',
  'toolResult.teamTask.updated': 'Updated task #{id} in team "{team}": {subject}',
  'toolResult.teamTask.nothingToUpdate':
    'Nothing to update: pass at least one of status, owner, subject, description.',
  'toolResult.teamTask.notFound': 'Task #{id} was not found in team "{team}".',
  'toolResult.teamTask.ownedByOther':
    'Task #{id} is owned by "{owner}", not by you ("{caller}"). ' +
    'Teammates can only update their own tasks.',
  'toolResult.teamTask.cannotReassign':
    'Teammates cannot reassign task ownership. Ask the leader to reassign it.',
  'toolResult.teamTask.noTeam':
    'Team "{team}" does not exist yet. Create tasks with TeamTaskCreate to start its shared task list.',
  'toolResult.teamTask.listEmpty': 'Team "{team}" has no tasks.',
  'toolResult.teamTask.claimed':
    'Claimed task #{id} in team "{team}" (owner: {owner}, status: in_progress): {subject}. ' +
    'Treat this as your new objective; when the work is done, mark the task completed with TeamTaskUpdate.',
  'toolResult.teamTask.noneClaimable':
    'No claimable tasks in team "{team}" — the queue is empty, or every pending task ' +
    'already has an owner. Report back to the leader instead of polling in a loop.',
  'toolResult.teamTask.claimNotTeammate':
    'Only a teammate can claim tasks — the claimer identity comes from the teammate runtime ' +
    'context, not from arguments. Leaders assign work at creation time (TeamTaskCreate owner) instead.',
  'toolResult.teamTask.claimNoTeam':
    'Teammate "{name}" does not belong to a team, so it cannot claim tasks. ' +
    'Spawn teammates with team_name to give them access to a shared task list.',

  // ── SendMessage ──
  'toolResult.sendMessage.sent':
    'Message sent to "{to}" in team "{team}" (id: {id}). ' +
    'A running teammate receives it mid-run; otherwise it is delivered on their next resume.',
  'toolResult.sendMessage.sentLeader':
    'Message sent to the leader in team "{team}" (id: {id}). The leader is notified in a later turn.',
  'toolResult.sendMessage.permissionApprovalSent':
    'Permission approval sent to "{to}" in team "{team}" (request {requestId}, id: {id}).',
  'toolResult.sendMessage.permissionRejectionSent':
    'Permission rejection sent to "{to}" in team "{team}" (request {requestId}, id: {id}).',
  'toolResult.sendMessage.shutdownSent':
    'Shutdown request sent to "{to}" in team "{team}" (id: {id}). ' +
    'The teammate gets a short wrap-up window before its task is stopped; ' +
    'you are notified when it acknowledges.',
  'toolResult.sendMessage.cannotSendToSelf': 'Cannot send a message to yourself.',
  'toolResult.sendMessage.leaderOnly':
    'Only the leader can send a {type}. Teammates message each other with plain text.',
  'toolResult.sendMessage.cannotSendStructuredToLeader': 'Cannot send a {type} to the leader.',

  // ── cron ──
  'toolResult.cron.createdRecurring':
    'Scheduled recurring cron job {id} ({cron}); next fire {nextFireAt}.',
  'toolResult.cron.createdOnce':
    'Scheduled one-shot cron job {id} ({cron}); fires {nextFireAt}.',
  'toolResult.cron.createdRecurringProject':
    'Scheduled recurring cron job {id} ({cron}); next fire {nextFireAt}. ' +
    'Project-durable — shared via {projectFile}.',
  'toolResult.cron.createdOnceProject':
    'Scheduled one-shot cron job {id} ({cron}); fires {nextFireAt}. ' +
    'Project-durable — shared via {projectFile}.',
  'toolResult.cron.deleted': 'Deleted cron job {id}.',
  'toolResult.cron.deletedProject': 'Deleted cron job {id} (project schedule).',
  'toolResult.cron.notFound': 'No cron job with id {id}.',
  'toolResult.cron.invalidId': 'Invalid cron job id {id} — must be 8 lowercase hex characters.',
  'toolResult.cron.listEmpty': 'No cron jobs scheduled.',

  // ── ExitPlanMode ──
  'toolResult.exitPlanMode.dismissed': 'Plan approval dismissed. Plan mode remains active.',
  'toolResult.exitPlanMode.revisionsRequested':
    'User requested revisions. Plan mode remains active.',
  'toolResult.exitPlanMode.notInPlanMode':
    'ExitPlanMode can only be called while plan mode is active. Use EnterPlanMode (or /plan) first.',
  'toolResult.exitPlanMode.noPlanFile':
    'No plan file found. Write the plan to the current plan file first, then call ExitPlanMode.',
  'toolResult.exitPlanMode.noPlanFileAtPath':
    'No plan file found. Write your plan to {path} first, then call ExitPlanMode.',
  'toolResult.exitPlanMode.readFailed': 'Failed to read plan file: {error}',
  'toolResult.exitPlanMode.exitFailed': 'Failed to exit plan mode: {error}',

  // ── Agent ──
  'toolResult.agent.backgroundLaunched':
    'Started background agent {agentId} (task {taskId}). You will be notified when it completes.',

  // ── Bash / background tasks ──
  'toolResult.bash.backgroundStarted':
    'Running in the background as task {taskId}. You will be notified when it completes.',
  'toolResult.taskStop.stopped': 'Stopped task {taskId} (status: {status}). Reason: {reason}.',
  'toolResult.taskStop.notFound': 'Task not found: {taskId}',
  'toolResult.taskStop.stopFailed': 'Failed to stop task: {taskId}',

  // ── goal ──
  'toolResult.goal.invalidStatus': 'Invalid goal status. Use `active`, `complete`, or `blocked`.',
  'toolResult.goal.completionGateRejected':
    'Goal not completed: the completion gate rejected this attempt. The goal is still active.',
} as const;

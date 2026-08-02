/** See common.ts for contribution rules. */

export const status = {
  // ── Session startup / resume ──
  'status.sessionNotFound': 'Session "{id}" not found.',
  'status.sessionWrongDir': 'Session "{id}" was created under a different directory.',
  'status.noSessionsToContinue': 'No sessions to continue under "{workDir}"; starting a fresh session.',
  'status.startupSessionMissing': 'Startup session was not initialized.',
  'status.providerModelsAdded.one': '{provider} · +{count} model.',
  'status.providerModelsAdded.other': '{provider} · +{count} models.',
  'status.providerRefreshSkipped': 'Skipped refreshing {provider}: {reason}',

  // ── Session switch ──
  'status.resumeOtherWorkDir':
    'Current session is in a different working directory.\n  To resume, run: {command}',
  'status.commandCopied': 'Command copied to clipboard',
  'status.commandCopyFailed': 'Failed to copy command to clipboard',
  'status.alreadyOnSession': 'Already on this session.',
  'status.cannotSwitchWhileStreaming': 'Cannot switch sessions while streaming — press Esc or Ctrl-C first.',
  'status.cannotSwitchWhileReplaying': 'Cannot switch sessions while history is replaying.',
  'status.resumeSessionFailed': 'Failed to resume session {id}: {message}',
  'status.sessionResumed': 'Resumed session ({id}).',
  'status.replayFailed': 'Failed to replay session history: {message}',
  'status.cannotNewWhileReplaying': 'Cannot start a new session while history is replaying.',
  'status.newSessionFailed': 'Failed to start a new session: {message}',
  'status.postCreateSetupFailed': 'Post-create setup failed: {message}',
  'status.newSessionStarted': 'Started a new session ({id}).',
  'status.applyStartupFlagsFailed': 'Failed to apply startup flags: {message}',

  // ── Input / send ──
  'status.cannotSendWhileReplaying': 'Cannot send input while session history is replaying.',
  'status.noActiveSessionForShell': 'No active session for shell command.',
  'status.modelNoImageInput': 'Current model does not support image input.',
  'status.modelNoVideoInput': 'Current model does not support video input.',
  'status.sendFailed': 'Failed to send: {message}',
  'status.mediaAttachmentFailed': 'Failed to prepare media attachment: {message}',
  'status.skillFailed': 'Skill "{name}" failed: {message}',
  'status.pluginCommandFailed': 'Command "{id}" failed: {message}',
  'status.steerFailed': 'Failed to steer: {message}',

  // ── Shell commands (`!` input) ──
  'status.shellCommandFailed': 'Shell command failed: {message}',
  'status.shellCancelFailed': 'Failed to cancel shell command: {message}',

  // ── Detach to background (ctrl+b) ──
  'status.detach.noShellCommand': 'No shell command running.',
  'status.detach.commandStarting': 'Command is still starting — try again.',
  'status.detach.commandFinished': 'Command already finished.',
  'status.detach.failed': 'Failed to move to background: {message}',
  'status.detach.moved': 'Moved to background.',
  'status.detach.movedHint': 'Moved to background. /tasks to view.',
  'status.detach.noForegroundTask': 'No foreground task running.',
  'status.detach.listTasksFailed': 'Failed to list tasks: {message}',
  'status.detach.taskFailed': 'Failed to detach {id}: {message}',
  'status.detach.tasksFinished.one': 'Task already finished.',
  'status.detach.tasksFinished.other': 'Tasks already finished.',
  'status.detach.movedTasks.one': 'Moved {count} task to background.',
  'status.detach.movedTasks.other': 'Moved {count} tasks to background.',
  'status.detach.movedTasksPartial': 'Moved {detached} of {total} tasks to background.',
  'status.detach.viewTasks': '/tasks to view.',

  // ── Approval transcript entries ──
  'status.approval.approved': 'Approved',
  'status.approval.approvedSession': 'Approved for session',
  'status.approval.approvedAlways': 'Approved always (rule saved)',
  'status.approval.rejected': 'Rejected',
  'status.approval.cancelled': 'Cancelled',

  // ── Login prompt / spinner / terminal notifications ──
  'status.login.title': 'Sign in to Cloud Code CLI',
  'status.login.hint': 'Press Ctrl-C to cancel',
  'status.login.waiting': 'Waiting for authorization…',
  'status.login.prompt': 'Visit the URL below in your browser to authorize:',
  'status.login.codeLabel': 'Verification code:  ',
  'status.working': 'working...',
  'status.notify.approvalRequired': 'Cloud Code CLI approval required',
  'status.notify.question': 'Cloud Code CLI needs your answer',
  'status.errorPrefix': 'Error: {message}',

  // ── Session/auth guards (constant/cloud-code-tui.ts stores these keys;
  // ── consumers resolve them with resolveDescription at display time) ──
  'status.llmNotSet': 'LLM not set, send "/login" to login',
  'status.noActiveSession': 'No active session. Send /login to login.',
  'status.ctrlCHint': 'Press Ctrl+C again to exit',
  'status.ctrlDHint': 'Press Ctrl+D again to exit',
  'status.oauthLoginRequired': 'OAuth login expired. Send /login to login.',

  // ── /feedback status lines (constant/feedback.ts) ──
  'status.feedback.submitting': 'Submitting feedback…',
  'status.feedback.uploading': 'Uploading attachments, this could take a few minutes…',
  'status.feedback.success': 'Feedback submitted, thank you!',
  'status.feedback.cancelled': 'Feedback cancelled.',
  'status.feedback.networkError': 'Network error, failed to submit feedback.',
  'status.feedback.fallback': 'Opening GitHub Issues as fallback…',
  'status.feedback.notSignedIn': "You're not signed in. Opening GitHub Issues for feedback…",
  'status.feedback.uploadFailed': 'Feedback sent; attachment upload failed — see feedback-upload.log.',
  'status.feedback.httpError': 'Failed to submit feedback (HTTP {status}).',
  'status.feedback.sessionLine': 'Session: {sessionId}',
  'status.feedback.idLine': 'Feedback ID: {feedbackId}',
  'status.feedback.errorReportHint':
    "If this persists, run `/export-debug-zip` and share the file with us for diagnosis. Please don't share it publicly.",

  // ── user keybindings file (tui/keybindings/loader.ts) ──
  'status.keybindings.parseError': '{file}: {message}. Using default keybindings.',
  'status.keybindings.notAnObject': '{file}: expected an object mapping actions to keys. Using default keybindings.',
  'status.keybindings.unknownAction': '{file}: unknown action "{action}" — skipped.',
  'status.keybindings.invalidValue':
    '{file}: "{action}" must map to a key string or an array of key strings — skipped.',
  'status.keybindings.reservedKey':
    '{file}: "{key}" is reserved for interrupt/exit and cannot be rebound — "{action}" skipped.',
  'status.keybindings.conflict': '{file}: "{key}" is bound to multiple actions ({actions}).',

  // ── TUI config file (tui/config.ts) ──
  'status.tuiConfig.invalid': 'Invalid TUI config in ~/.cloud-code/tui.toml; using defaults.',

  // ── CLI exit messages & startup errors (cli/run-shell.ts, cli/startup-error.ts) ──
  'status.exit.bye': 'Bye!',
  'status.exit.resume': 'To resume this session: cloudcode -r {sessionId}',
  'status.exit.openUrl': 'open {url}',
  'status.startupError.failed': 'error: failed to {operation}: {message}',
  'status.startupError.operationDefault': 'start shell',
  'status.startupError.messageLabel': 'message:',
  'status.scrollIndicator': '↓ {count} more',
} as const;

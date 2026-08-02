/** See common.ts for contribution rules. */

export const controllers = {
  // ── Session replay ──
  'controllers.replay.historyUnavailable': 'Session history is unavailable for this session.',
  'controllers.replay.goalUpdated': 'Goal updated',
  'controllers.replay.planSentBackForRevision': 'Plan sent back for revision',
  'controllers.replay.planReviewRejected': 'Plan review rejected',
  'controllers.replay.planReviewCancelled': 'Plan review cancelled',
  'controllers.replay.feedbackDetail': 'Feedback: {feedback}',

  // ── /tasks browser controller ──
  'controllers.tasksBrowser.noSession': 'No active session.',
  'controllers.tasksBrowser.loadFailed': 'Failed to load tasks: {message}',
  'controllers.tasksBrowser.refreshFailed': 'Refresh failed: {message}',
  'controllers.tasksBrowser.refreshing': 'Refreshing…',
  'controllers.tasksBrowser.outputRefreshFailed': 'Output refresh failed: {message}',
  'controllers.tasksBrowser.cannotOpenOutput': 'Cannot open output: {message}',
  'controllers.tasksBrowser.stopping': 'Stopping {taskId}…',
  'controllers.tasksBrowser.stopFailed': 'Stop failed: {message}',
  'controllers.tasksBrowser.userInitiatedStop': 'User initiated stop',
  'controllers.tasksBrowser.alreadyTerminal': '{taskId} is already terminal — nothing to stop.',

  // ── /btw panel ──
  'controllers.btw.busyNotice': 'Wait for /btw to finish before sending another question.',
  'controllers.btw.sendPromptFailed': 'Failed to send /btw prompt: {message}',
  'controllers.btw.cancelFailed': 'Failed to cancel /btw: {message}',
  'controllers.btw.hookBlocked': 'Prompt hook blocked the request.',
  'controllers.btw.turnEnded': 'BTW turn ended with reason: {reason}',

  // ── Editor keyboard ──
  'controllers.editor.cancelCompactionFailed': 'Failed to cancel compaction: {message}',
  'controllers.editor.noEditorConfigured':
    'No editor configured. Set $VISUAL / $EDITOR, or run /editor <command>.',
  'controllers.editor.externalEditorFailed': 'External editor failed: {message}',
  'controllers.editor.cancelledInputRecalled':
    'Cancelled — your input was restored to the editor for re-editing.',

  // ── Clipboard image hint ──
  'controllers.clipboardHint.imageInClipboard': 'Image in clipboard · {shortcut} to paste',
} as const;

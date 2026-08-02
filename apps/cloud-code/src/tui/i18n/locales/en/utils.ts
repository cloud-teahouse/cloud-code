/** See common.ts for contribution rules. */

export const utils = {
  // ── background task transcript cards (utils/background-task-status.ts) ──
  'utils.backgroundTask.subject.agent': 'agent task',
  'utils.backgroundTask.subject.question': 'question task',
  'utils.backgroundTask.subject.bash': 'bash task',
  'utils.backgroundTask.headline.started': '{subject} started in background',
  'utils.backgroundTask.headline.completed': '{subject} completed in background',
  'utils.backgroundTask.headline.failed': '{subject} failed in background',
  'utils.backgroundTask.headline.timedOut': '{subject} timed out',
  'utils.backgroundTask.headline.stopped': '{subject} stopped',
  'utils.backgroundTask.headline.lost': '{subject} lost',
  'utils.backgroundTask.detail.exit': 'exit {code}',
  'utils.backgroundTask.detail.stoppedReason': 'stopped — {reason}',
  'utils.backgroundTask.detail.stopped': 'stopped',
  'utils.backgroundTask.detail.timedOut': 'timed out',
  'utils.backgroundTask.detail.lost': 'session restarted before completion',

  // ── hook result transcript blocks (utils/hook-result-format.ts, utils/message-replay.ts) ──
  'utils.hookResult.title': '{event} hook',
  'utils.hookResult.titleBlocked': '{event} hook blocked',
  'utils.hookResult.empty': '(empty)',

  // ── MCP startup status summary (utils/mcp-server-status.ts) ──
  'utils.mcp.summary.failed': '{count} failed',
  'utils.mcp.summary.needsAuth': '{count} need auth',
  'utils.mcp.summary.connecting': '{count} connecting',
  'utils.mcp.summary.connected': '{count} connected',
  'utils.mcp.summary.disabled': '{count} disabled',

  // ── shell output (utils/shell-output.ts) ──
  'utils.shellOutput.empty': '(no output)',

  // ── provider error payloads (utils/event-payload.ts) ──
  'utils.eventPayload.providerFiltered':
    'Provider filtered the response before visible output (finishReason={finishReason}{raw}).',

  // ── tmux keyboard warnings (utils/tmux-keyboard.ts; the exported constants
  // ── mirror these entries for existing callers/tests) ──
  'utils.tmux.extendedKeysOff':
    'tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.',
  'utils.tmux.extendedKeysFormatXterm':
    'tmux extended-keys-format is xterm. Cloud Code CLI works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.',

  // ── reverse RPC (reverse-rpc/) ──
  'utils.reverseRpc.approvalHandlerFailed': 'approval handler failed',
} as const;

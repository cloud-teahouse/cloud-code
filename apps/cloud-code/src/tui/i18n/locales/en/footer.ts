/** Footer/status bar, toolbar tips, working tips, streaming session notices. */

export const footer = {
  // ── Status bar ──
  'footer.context.withTokens': 'context: {percent}% ({tokens}/{maxTokens})',
  'footer.context.percentOnly': 'context: {percent}%',
  'footer.context.avgResponse': 'avg {time}',
  'footer.context.firstToken': 'first token {time}',
  'footer.tokens.in': 'in {tokens}',
  'footer.tokens.cache': 'cache {tokens} ({percent}%)',
  'footer.tokens.out': 'out {tokens}',
  'footer.thinkingSuffix': ' thinking',
  'footer.thinkingEffortSuffix': ' thinking: {effort}',
  'footer.tasksRunning.one': '[{count} task running]',
  'footer.tasksRunning.other': '[{count} tasks running]',
  'footer.agentsRunning.one': '[{count} agent running]',
  'footer.agentsRunning.other': '[{count} agents running]',
  'footer.goal.badge': '{status} · {elapsed} · {turns}',
  'footer.goal.badgePrefix': 'goal',
  'footer.goal.status.active': 'active',
  'footer.goal.status.paused': 'paused',
  'footer.goal.status.blocked': 'blocked',
  'footer.goal.turns.one': '{count} turn',
  'footer.goal.turns.other': '{count} turns',
  'footer.goal.turnsBudget': '{used}/{budget} turns',
  'footer.vimMode.insert': 'INSERT',
  'footer.vimMode.normal': 'NORMAL',
  'footer.mode.coordinator': 'coordinator',
  'footer.notify.taskComplete': 'Cloud Code CLI task complete',

  // ── Toolbar / working tips (constant/tips.ts stores these keys) ──
  'tips.ctrlS': 'ctrl-s to add guidance without waiting for the turn to finish',
  'tips.tasks': '/tasks to check progress and status for background tasks',
  'tips.init': '/init: generate AGENTS.md',
  'tips.dance': 'Try /dance for a hidden Easter egg',
  'tips.pluginsSuperpowers': '/plugins: manage plugins — try the "superpowers" plugin',
  'tips.pluginsDatasource':
    '/plugins: manage plugins — try the "Kimi Datasource" for reliable financial, economic, and academic data',
  'tips.schedule': 'ask Cloud Code CLI to schedule tasks, e.g. "remind me at 5pm"',
  'tips.sessions': '/sessions to browse and resume earlier sessions',
  'tips.goal': '/goal for multi-step work with a clear finish line',
  'tips.goalNext': '/goal next to queue follow-up work while the current goal keeps running',
  'tips.web': '/web: use the Web UI for a better experience',
  'tips.mention': '@: mention files',
  'tips.shell': '! to run a shell command',
  'tips.fast': 'Use /fast to enable our fastest inference with increased plan usage.',
  'tips.shiftEnter': 'shift+enter: newline',
  'tips.ctrlC': 'ctrl+c: cancel',
  'tips.theme': '/theme to switch the terminal UI theme',
  'tips.auto': '/auto when you want Cloud Code CLI to handle approvals and keep going unattended',
  'tips.yolo': '/yolo to skip most approvals for trusted batch work, only use it in repos you trust',
  'tips.help': '/help: show commands',
  'tips.compact': '/compact compresses context when it gets long',
  'tips.ctrlO':
    'ctrl-o to hide or reveal tool output switching between a clean chat view and full execution details',
  'tips.shiftTab': 'shift-tab to Plan mode to review the approach before Cloud Code CLI edits files.',
  'tips.model': '/model: switch model',

  // ── Turn / session status notices (controllers) ──
  'session.turn.stoppedFiltered': 'Turn stopped: provider safety policy blocked the response.',
  'session.turn.stoppedBlocked': 'Turn stopped: prompt hook blocked the request.',
  'session.turn.filteredTitle': 'Provider safety policy blocked the response.',
  'session.turn.filteredDetail': 'The model output was filtered ({reason}).',
  'session.turn.maxTokensTruncated':
    'Model hit max_tokens — tool call was truncated before it could run.',
  'session.turn.maxTokensNoToolCall': 'Model hit max_tokens — no tool call was emitted.',
  'session.turn.maxTokensAnthropicDetail':
    'If this limit is wrong for your model, set `max_output_size` on the model alias in your Cloud Code CLI config.',
  'session.turn.interrupted': 'Interrupted by user',
  'session.turn.maxSteps': 'reached per-turn step limit (max_steps)',
  'session.turn.stepInterrupted': 'step interrupted ({reason})',
  // Foreground retry split: in-backoff presence + the rate-limit
  // pause countdown line.
  'session.turn.retrying': 'Provider request failed — retrying (attempt {nextAttempt}/{maxAttempts}) in {seconds}s…',
  'session.turn.rateLimitPaused': 'Rate limited — auto-retry in {time} (Esc to cancel)',
  'session.turn.rateLimitResuming': 'Rate limit wait over — auto-retrying now (attempt {attempt})…',
  'session.turn.rateLimitPauseCancelled': 'Auto-retry cancelled',
  // Turn completion line ("Worked for 12s") — rendered as a dim transcript
  // line with a random leading glyph. Verbs are a comma-separated past-tense
  // set; one is picked at random per completed turn.
  'session.turn.completed': '{verb} for {duration}',
  'session.turn.completionVerbs':
    'Worked,Baked,Brewed,Churned,Cooked,Crunched,Cogitated,Concocted,Crafted,Deliberated,Distilled,Forged,Hatched,Mulled,Mused,Pondered,Percolated,Simmered,Tinkered,Whittled',
  // Safety net when the catalog above somehow resolves empty.
  'session.turn.completionVerbFallback': 'Worked',
  'session.turn.durationSeconds': '{seconds}s',
  'session.turn.durationMinutes': '{minutes}m {seconds}s',
  'session.warning': 'Warning: {message}',
  'session.mcp.syncFailed': 'Failed to sync MCP server status: {error}',
  'session.mcp.connected': 'MCP server "{name}" connected · {tools} ({transport})',
  'session.mcp.tools.one': '{count} tool',
  'session.mcp.tools.other': '{count} tools',
  'session.mcp.failed': 'MCP server "{name}" failed',
  'session.mcp.failedWithError': 'MCP server "{name}" failed: {error}',
  'session.mcp.needsAuth': 'MCP server "{name}" needs OAuth — run /mcp-config login {name}',
  'session.mcp.disabled': 'MCP server "{name}" disabled',
  'session.mcp.connecting': 'MCP server "{name}" connecting…',
  'session.skill.activated': 'Activated skill: {name}',
  'session.goal.blockedTitle': 'Goal blocked.',
  'session.goal.blockedDetail': 'The next queued goal will start only after this goal is complete.',
  'session.goal.queueReadFailed': 'Failed to read upcoming goals: {error}',
  'session.goal.queueRemoveFailed':
    'Queued goal started, but could not be removed from the queue: {error}',
  'session.goal.restoreFailed': 'Queued goal could not be restored: {error}',
  'session.goal.cancelFailed': 'Queued goal could not be cancelled: {error}',
} as const;

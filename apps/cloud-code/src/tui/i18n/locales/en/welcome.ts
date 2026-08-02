/** Welcome panel + startup chrome. See common.ts for contribution rules. */

export const welcome = {
  'welcome.title': 'Welcome to Cloud Code CLI!',
  'welcome.getStarted.login': 'Run /login or /provider to get started.',
  'welcome.getStarted.help': 'Send /help for help information.',
  'welcome.modelNotSet': 'not set, run /login or /provider',
  'welcome.label.directory': 'Directory:',
  'welcome.label.session': 'Session:',
  'welcome.label.model': 'Model:',
  'welcome.label.version': 'Version:',
  'welcome.label.mcp': 'MCP:',

  // Dim note under the welcome box, shown only on non-release build channels.
  'welcome.channelNote.dev': 'dev build, may be unstable',
  'welcome.channelNote.beta': 'beta build, may be unstable',

  // ── /dance easter egg ──
  'welcome.dance.statusOn': 'Dancing — use {cmd} to turn it off.',
  'welcome.dance.statusHint': 'Use {cmd} to keep the rainbow on.',
} as const;

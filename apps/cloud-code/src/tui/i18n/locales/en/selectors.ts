/** See common.ts for contribution rules. */

export const selectors = {
  // ── shared input-dialog chrome ──
  'selectors.inputDialog.footer': 'Enter to submit  ·  Esc to cancel',

  // ── experiments selector ──
  'selectors.experiments.title': 'Experimental features',
  'selectors.experiments.hintPage': 'PgUp/PgDn page',
  'selectors.experiments.hintToggle': 'Space toggle',
  'selectors.experiments.hintApply': 'Enter apply',
  'selectors.experiments.apply': '[ Apply changes and reload ]',
  'selectors.experiments.noChanges': 'no changes',
  'selectors.experiments.change.one': '{count} change',
  'selectors.experiments.change.other': '{count} changes',
  'selectors.experiments.enabled': 'enabled',
  'selectors.experiments.disabled': 'disabled',
  'selectors.experiments.modified': 'modified',
  'selectors.experiments.lockedByMasterEnv': 'locked by CLOUD_CODE_EXPERIMENTAL_FLAG',
  'selectors.experiments.lockedByEnv': 'locked by {env}',
  'selectors.experiments.sourceConfig': 'config',
  'selectors.experiments.sourceDefault': 'default',

  // ── goal queue manager & edit dialog ──
  'selectors.goalQueue.title': 'Upcoming goals',
  'selectors.goalQueue.hintNavigate': '↑↓ navigate · Space select · Alt+E edit · Alt+D delete · Esc cancel',
  'selectors.goalQueue.hintReorder': '↑↓ reorder · Space done · Alt+E edit · Alt+D delete · Esc done',
  'selectors.goalQueue.empty': 'No upcoming goals.',
  'selectors.goalQueue.selected': 'selected',
  'selectors.goalQueue.editTitle': 'Edit upcoming goal',
  'selectors.goalQueue.editSubtitle': 'Update the queued objective.',
  'selectors.goalQueue.editFooter': 'Enter submit · Shift-Enter/Ctrl-J newline · Esc cancel',
  'selectors.goalQueue.errorEmpty': 'Goal objective cannot be empty.',
  'selectors.goalQueue.errorTooLong': 'Goal objective cannot exceed {max} characters.',
  'selectors.goalQueue.errorNotFound': 'No queued goal found.',
  'selectors.goalQueue.inputPrevious': '… {count} previous',
  'selectors.goalQueue.inputMore': '… {count} more',

  // ── task output viewer ──
  'selectors.taskOutput.title': 'Task output',
  'selectors.taskOutput.noOutput': '[no output captured]',
  'selectors.taskOutput.exitCode': 'exit {code}',
  'selectors.taskOutput.status.running': 'running',
  'selectors.taskOutput.status.completed': 'completed',
  'selectors.taskOutput.status.failed': 'failed',
  'selectors.taskOutput.status.timedOut': 'timed out',
  'selectors.taskOutput.status.killed': 'killed',
  'selectors.taskOutput.status.lost': 'lost',
  'selectors.taskOutput.key.line': 'line',
  'selectors.taskOutput.key.page': 'page',
  'selectors.taskOutput.key.topBot': 'top/bot',
  'selectors.taskOutput.key.cancel': 'cancel',

  // ── effort selector ──
  'selectors.effort.title': 'Select thinking effort',
  'selectors.effort.hintSwitch': '←→ switch',

  // ── custom registry import ──
  'selectors.registryImport.title': 'Import custom provider registry',
  'selectors.registryImport.subtitle': 'Paste an api.json URL and its Bearer token.',
  'selectors.registryImport.urlEmpty': 'Registry URL cannot be empty.',
  'selectors.registryImport.tokenEmpty': 'Bearer token cannot be empty.',
  'selectors.registryImport.footerNext': 'Tab / ↑↓ to switch  ·  Enter for next field  ·  Esc to cancel',
  'selectors.registryImport.footerSubmit': 'Tab / ↑↓ to switch  ·  Enter to submit  ·  Esc to cancel',
  'selectors.registryImport.urlLabel': 'Registry URL',
  'selectors.registryImport.tokenLabel': 'Bearer token',

  // ── compaction block ──
  'selectors.compaction.compacting': 'Compacting context...',
  'selectors.compaction.complete': 'Compaction complete',
  'selectors.compaction.cancelled': 'Compaction cancelled',
  'selectors.compaction.tokens': ' ({before} → {after} tokens)',
  'selectors.compaction.hintShow': ' (Ctrl-O to show compaction summary)',
  'selectors.compaction.hintHide': ' (Ctrl-O to hide compaction summary)',
  'selectors.compaction.tip': ' · Tip: {tip}',
  'selectors.compaction.phase.building': 'preparing',
  'selectors.compaction.phase.summarizing': 'summarizing',
  'selectors.compaction.phase.finishing': 'finishing',
  'selectors.compaction.progressLine': '  {bar} {percent}% · {phase} · {seconds}s',

  // ── permission selector ──
  'selectors.permission.manual.label': 'Manual',
  'selectors.permission.manual.description': 'Approve every action yourself.',
  'selectors.permission.yolo.label': 'YOLO',
  'selectors.permission.yolo.description': 'Auto-approve tool actions, but the agent may still ask questions.',
  'selectors.permission.auto.label': 'Auto',
  'selectors.permission.auto.description': 'Fully autonomous — agent decides everything without asking.',

  // ── feedback input dialog ──
  'selectors.feedback.title': 'Send feedback to Cloud Code CLI',
  'selectors.feedback.subtitle': "Tell us what's working or what's not.",
  'selectors.feedback.empty': 'Feedback cannot be empty.',

  // ── editor selector ──
  'selectors.editor.title': 'Select external editor',
  'selectors.editor.autoDetect': 'Auto-detect ($VISUAL / $EDITOR)',

  // ── update preference selector ──
  'selectors.update.on.label': 'On',
  'selectors.update.on.description': 'Install new versions in the background.',
  'selectors.update.off.label': 'Off',
  'selectors.update.off.description': 'Show the install prompt instead.',

  // ── fullscreen selector ──
  'selectors.fullscreen.on.label': 'On',
  'selectors.fullscreen.on.description':
    'Alternate-screen TUI: pinned input/status slot, in-app scrolling.',
  'selectors.fullscreen.off.label': 'Off',
  'selectors.fullscreen.off.description':
    'Classic inline scrollback; no mouse capture — for phone terminals.',

  // ── api key input dialog ──
  'selectors.apiKey.title': 'Enter API key for {platform}',
  'selectors.apiKey.empty': 'API key cannot be empty.',

  // ── base URL input dialog (catalog provider import) ──
  'selectors.baseUrl.title': 'Enter base URL for {platform}',
  'selectors.baseUrl.subtitle':
    'The catalog declares no endpoint for this provider — enter its base URL.',
  'selectors.baseUrl.empty': 'Base URL cannot be empty.',

  // ── platform selector ──
  'selectors.platform.title': 'Select a platform',

  // ── tabbed model selector ──
  'selectors.modelTabs.all': 'All',

  // ── /import source picker ──
  'selectors.import.source.title': 'Import from…',
  'selectors.import.source.claude.label': 'Claude Code',
  'selectors.import.source.claude.description':
    'Instructions, skills, and MCP settings from ~/.claude (interactive, model-assisted).',
  'selectors.import.source.codex.label': 'Codex',
  'selectors.import.source.codex.description':
    'Instructions, skills, and MCP settings from ~/.codex (interactive, model-assisted).',
  'selectors.import.source.kimi.label': 'Kimi Code',
  'selectors.import.source.kimi.description':
    'Config, keybindings, MCP servers, skills, AGENTS.md, sessions, and input history from ~/.kimi-code (deterministic).',

  // ── /import confirm picker ──
  'selectors.import.confirm.title': 'Review the import plan',
  'selectors.import.confirm.tomlNote':
    'Note: writing config.toml re-serializes it — values are kept, but comments/formatting are normalized.',
  'selectors.import.confirm.snapshotNote':
    'The plan above is a snapshot — do not edit the target files in another session before confirming.',
  'selectors.import.confirm.apply.label': 'Apply import',
  'selectors.import.confirm.apply.description':
    'Import the items listed above. Existing entries are kept; conflicts are skipped.',
  'selectors.import.confirm.applyRename.label': 'Apply, renaming conflicting skills',
  'selectors.import.confirm.applyRename.description':
    'Also import {count} conflicting skill(s) under a -kimi suffixed name.',
  'selectors.import.confirm.cancel.label': 'Cancel',
  'selectors.import.confirm.cancel.description': 'Do not import anything.',

  // ── /import credentials opt-in ──
  'selectors.import.credentials.title': 'Also copy OAuth credentials?',
  'selectors.import.credentials.notice':
    'Credential files contain OAuth access and refresh tokens. Copying them signs this installation in with the same account. Only do this on a machine you trust.',
  'selectors.import.credentials.no.label': 'No (recommended)',
  'selectors.import.credentials.no.description': 'Keep credentials untouched; log in separately if needed.',
  'selectors.import.credentials.yes.label': 'Yes, copy credentials',
  'selectors.import.credentials.yes.description':
    'Copy token files that do not already exist here. Existing files are never overwritten.',
  'selectors.import.credentials.skipped': 'Credentials left untouched.',
  'selectors.import.credentials.done': 'Copied {count} credential file(s).',
  'selectors.import.credentials.none': 'No credential files were copied.',
} as const;

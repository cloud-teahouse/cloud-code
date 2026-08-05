/**
 * Slash-command descriptions (registry) + command execution feedback.
 * See common.ts for contribution rules.
 *
 * The registry stores the `commands.<name>.description` *keys* in
 * `BUILTIN_SLASH_COMMANDS`; consumers resolve them through
 * `resolveDescription()` so plugin/skill commands (plain text) pass through.
 */

export const commands = {
  // ── Builtin command descriptions (registry.ts) ──
  'commands.yolo.description':
    'Toggle YOLO mode: auto-approve tool actions, but the agent may still ask questions.',
  'commands.auto.description':
    'Toggle Auto mode: fully autonomous, agent decides everything without asking.',
  'commands.permission.description': 'Select permission mode',
  'commands.settings.description': 'Open TUI settings',
  'commands.plan.description': 'Toggle plan mode',
  'commands.swarm.description': 'Toggle swarm mode or run one task in swarm mode',
  'commands.coordinator.description': 'Toggle Coordinator Mode: orchestrate background workers',
  'commands.model.description': 'Switch LLM model',
  'commands.effort.description': 'Switch thinking effort',
  'commands.fast.description': 'Toggle fast inference (ChatGPT Codex models, higher plan usage)',
  'commands.provider.description': 'Manage AI providers (add / delete / refresh)',
  'commands.btw.description': 'Ask a forked side agent a question',
  'commands.help.description': 'Show available commands and shortcuts',
  'commands.new.description': 'Start a fresh session in the current workspace',
  'commands.sessions.description': 'Browse and resume sessions',
  'commands.tasks.description': 'Browse background tasks',
  'commands.mcp.description': 'Show MCP server status',
  'commands.sandbox.description': 'Show or toggle the OS sandbox for shell commands (on|off|status)',
  'commands.sandbox.usage': 'Usage: /sandbox [on|off|status]',
  'commands.sandbox.enabled': 'Sandbox enabled (auto) — live for this session and persisted to config.toml',
  'commands.sandbox.disabled': 'Sandbox disabled — live for this session and persisted to config.toml',
  'commands.sandbox.toggleFailed': 'Failed to toggle the sandbox: {error}',
  'commands.sandbox.persistFailed': 'Sandbox applied to this session, but persisting failed: {error}',
  'commands.plugins.description': 'Manage plugins',
  'commands.add-dir.description': 'Add or list an additional workspace directory',
  'commands.experiments.description': 'Manage experimental features',
  'commands.reload.description':
    'Reload session and apply config.toml settings plus tui.toml UI preferences',
  'commands.reload-tui.description': 'Reload only tui.toml UI preferences',
  'commands.compact.description': 'Compact the conversation context',
  'commands.goal.description': 'Start or manage an autonomous goal',
  'commands.init.description': 'Analyze the codebase and generate AGENTS.md',
  'commands.fork.description': 'Fork the current session',
  'commands.title.description': 'Set or show session title',
  'commands.usage.description': 'Alias for /status — open the Usage tab',
  'commands.status.description': 'Status dashboard: account, model, plan usage, activity stats',
  'commands.feedback.description': 'Send feedback to make Cloud Code CLI better',
  'commands.undo.description': 'Withdraw the last prompt from the transcript',
  'commands.rewind.description': 'Roll back files and/or conversation to a previous prompt',
  'commands.editor.description': 'Set the external editor for Ctrl-G',
  'commands.vim.description': 'Toggle vim modal editing (NORMAL/INSERT) in the prompt editor',
  'commands.theme.description': 'Set the terminal UI theme',
  'commands.language.description': 'Set the UI language',
  'commands.outputStyle.description': 'Set the output style (tone of the assistant prompt)',
  'commands.logout.description': 'Log out of a configured provider',
  'commands.login.description': 'Select a platform and authenticate',
  'commands.export-md.description': 'Export current session as a Markdown file',
  'commands.export-debug-zip.description': 'Export current session as a debug ZIP archive',
  'commands.copy.description': 'Copy the last assistant message to the clipboard',
  'commands.exit.description': 'Exit the application',
  'commands.version.description': 'Show version information',
  'commands.update.description': 'Check for updates and self-update binary installs',

  // ── Argument-completion descriptions (registry.ts) ──
  'commands.goal.arg.status': 'Show the current goal',
  'commands.goal.arg.pause': 'Pause the active goal',
  'commands.goal.arg.resume': 'Resume a paused goal',
  'commands.goal.arg.cancel': 'Cancel and remove the current goal',
  'commands.goal.arg.replace': 'Replace the current goal with a new objective',
  'commands.goal.arg.next': 'Queue an upcoming goal',
  'commands.goal.arg.nextManage': 'Manage upcoming goals',
  'commands.swarm.arg.on': 'Turn swarm mode on',
  'commands.swarm.arg.off': 'Turn swarm mode off',
  'commands.coordinator.arg.on': 'Turn Coordinator Mode on',
  'commands.coordinator.arg.off': 'Turn Coordinator Mode off',
  'commands.add-dir.arg.list': 'Show configured additional workspace directories',
  'commands.update.arg.check': 'Check for a new release',
  'commands.update.arg.apply': 'Download and install a release (binary installs)',

  // ── argumentHint metavars (registry.ts; literal keywords stay untranslated) ──
  'commands.swarm.argumentHint': '[on|off] | <task>',
  'commands.model.argumentHint': '[add|<alias>]',
  'commands.add-dir.argumentHint': '[list] | <path>',
  'commands.compact.argumentHint': '<instruction>',
  'commands.goal.argumentHint': '[status|pause|resume|cancel|replace|next] | <objective>',
  'commands.title.argumentHint': '<title>',
  'commands.outputStyle.argumentHint': '[name]',
  'commands.update.argumentHint': '[check|apply] [<version>]',

  // ── Dispatch / resolve feedback ──
  'commands.dispatch.invalid': 'Invalid slash command: /{name}',
  'commands.dispatch.unknown': 'Unknown slash command: /{name}',
  'commands.dispatch.busyStreaming': 'Cannot /{name} while streaming — press Esc or Ctrl-C first.',
  'commands.dispatch.busyCompacting':
    'Cannot /{name} while compacting — wait for compaction to finish first.',
  'commands.version.status': 'Cloud Code CLI v{version}',

  // ── /update ──
  'commands.update.checking': 'Checking for updates…',
  'commands.update.checkFailed': 'Failed to check for updates: {error}',
  'commands.update.noReleases': 'No releases published yet.',
  'commands.update.unknownVersion':
    'Latest release is v{version}, but the current version is not semver — cannot compare.',
  'commands.update.upToDate': 'Cloud Code CLI is up to date (v{version}).',
  'commands.update.available': 'New version available: v{version} (published {date})',
  'commands.update.availableHint': 'Run /update apply to install it (binary installs only).',
  'commands.update.unknownArg':
    'Unknown /update argument: {arg}. Usage: /update [check|apply] [<version>]',
  'commands.update.pinnedNotFound': 'No release found for tag {tag}.',
  'commands.update.sourceGuidance.title':
    'v{version} is available, but this is not a binary install',
  'commands.update.sourceGuidance.detail':
    'Update via your package manager (e.g. npm install -g @cloud-teahouse/cloudcode-cli@latest) or pull the latest source and rebuild.',
  'commands.update.unsupportedPlatform': 'No prebuilt binary for {platform}/{arch}.',
  'commands.update.downloading': 'Downloading v{version}…',
  'commands.update.applied': 'Updated to v{version}',
  'commands.update.appliedDetail':
    'Restart Cloud Code CLI to use the new version. Previous binary backed up at: {backup}',
  'commands.update.applyFailed': 'Update failed: {error}',
  'commands.update.restoreHint': 'Restore the previous binary with: mv {backup} {binary}',

  // ── /update channels ──
  'commands.update.devUnsupported.title': 'dev builds do not support automatic updates',
  'commands.update.devUnsupported.detail':
    'dev builds are internal CI artifacts — rebuild from source or download the latest CI artifact to update.',
  'commands.update.betaNoBuilds': 'No beta builds published yet.',
  'commands.update.betaUnknownBuild':
    'Latest beta build is {version}, but this build does not record its commit — cannot compare.',
  'commands.update.betaUpToDate': 'Cloud Code CLI is up to date (beta build {version}).',
  'commands.update.betaAvailable': 'New beta build available: {version} (published {date})',
  'commands.update.betaDownloading': 'Downloading beta build {version}…',
  'commands.update.betaApplied': 'Updated to beta build {version}',
  'commands.update.betaSourceGuidance.title':
    'beta build {version} is available, but this is not a binary install',
  'commands.update.betaSourceGuidance.detail':
    'Update via your package manager (e.g. npm install -g @cloud-teahouse/cloudcode-cli@beta) or download the newest beta build.',

  // ── /plan ──
  'commands.plan.cleared': 'Plan cleared',
  'commands.plan.unknownSubcommand': 'Unknown plan subcommand: {subcommand}',
  'commands.plan.on': 'Plan mode: ON',
  'commands.plan.off': 'Plan mode: OFF',
  'commands.plan.willBeCreated': 'Plan will be created here: {path}',
  'commands.plan.failed': 'Failed to set plan mode: {error}',

  // ── /yolo & /auto ──
  'commands.yolo.alreadyOn': 'YOLO mode is already on',
  'commands.yolo.alreadyOff': 'YOLO mode is already off',
  'commands.yolo.on': 'YOLO mode: ON',
  'commands.yolo.off': 'YOLO mode: OFF',
  'commands.yolo.onDetail': 'Tool actions auto-approved; the agent may still ask you questions.',
  'commands.autoMode.alreadyOn': 'Auto mode is already on',
  'commands.autoMode.alreadyOff': 'Auto mode is already off',
  'commands.autoMode.on': 'Auto mode: ON',
  'commands.autoMode.off': 'Auto mode: OFF',
  'commands.autoMode.onDetail': 'All actions auto-approved; the agent will not ask you questions.',

  // ── /editor ──
  'commands.editor.unchanged': 'Editor unchanged: {value}',
  'commands.editor.saveFailed': 'Failed to save editor: {error}',
  'commands.editor.setTo': 'Editor set to "{value}".',
  'commands.editor.setAutoDetect': 'Editor set to auto-detect ($VISUAL / $EDITOR).',

  // ── /vim ──
  'commands.vim.on': 'Vim mode: ON',
  'commands.vim.off': 'Vim mode: OFF',
  'commands.vim.onDetail':
    'Esc enters NORMAL mode; session-only — set editor.vim_mode in tui.toml to persist.',

  // ── /theme ──
  'commands.theme.unknown': 'Unknown theme: {theme}',
  'commands.theme.unchanged': 'Theme unchanged: "{theme}".',
  'commands.theme.loadFailed': 'Theme "{theme}" could not be loaded.',
  'commands.theme.saveFailed': 'Failed to save theme: {error}',
  'commands.theme.setTo': 'Theme set to "{theme}".',
  'commands.theme.setToAuto': 'Theme set to "{theme}" (tracking terminal; current: {resolved}).',

  // ── /language ──
  'commands.language.set': 'Language set to {name}.',
  'commands.language.unchanged': 'Language unchanged: {name}.',
  'commands.language.saveFailed': 'Failed to save language: {error}',
  'commands.language.invalid': 'Unknown language: {value}. Available: auto, en, zh-CN',

  // ── /output-style ──
  'commands.outputStyle.set': 'Output style set to "{name}".',
  'commands.outputStyle.unchanged': 'Output style unchanged: "{name}".',
  'commands.outputStyle.unknown': 'Unknown output style: {name}. Run /output-style to list available styles.',
  'commands.outputStyle.saveFailed': 'Failed to set output style: {error}',

  // ── /model & /effort ──
  'commands.model.unknownAlias': 'Unknown model alias: {alias}',
  'commands.model.noneConfigured': 'No models configured',
  'commands.model.noneConfiguredDetail':
    'Run /login to sign in to Kimi, /provider to add another provider, or /model add to configure a custom model.',
  'commands.model.add.failed': 'Add model failed: {error}',
  'commands.model.add.providerTitle': 'Select a provider for the new model',
  'commands.model.add.newProviderOption': '[ New provider… ]',
  'commands.model.add.modelIdTitle': 'Model id',
  'commands.model.add.modelIdSubtitle':
    'The model name sent to the provider (e.g. claude-opus-4-7, gpt-5.5).',
  'commands.model.add.modelIdEmpty': 'Model id cannot be empty.',
  'commands.model.add.aliasTaken': 'Model alias "{alias}" already exists.',
  'commands.model.add.displayNameTitle': 'Display name (optional)',
  'commands.model.add.displayNameSubtitle':
    'Shown in the model picker. Leave empty to use the model id.',
  'commands.model.add.contextTitle': 'Context window (tokens)',
  'commands.model.add.contextSubtitle':
    'Total token window of the model. Default for {type}: {default}. Leave empty to keep it.',
  'commands.model.add.contextInvalid': 'Enter a positive integer (tokens).',
  'commands.model.add.effortsTitle': 'Supported thinking efforts',
  'commands.model.add.customEffortsTitle':
    'Custom effort names, comma-separated (optional, e.g. deep, turbo)',
  'commands.model.add.customEffortsOption': '+ Custom effort names…',
  'commands.model.add.customEffortsInvalid':
    'Lowercase letters, digits, - and _ only, comma-separated',
  'commands.model.add.effortNoneDesc': 'Thinking can be turned off (wire value "none").',
  'commands.model.add.capsTitle': 'Model capabilities',
  'commands.model.add.cap.tool_use': 'Tool use',
  'commands.model.add.cap.image_in': 'Vision (image input)',
  'commands.model.add.cap.video_in': 'Video input',
  'commands.model.add.cap.audio_in': 'Audio input',
  'commands.model.add.cap.dynamically_loaded_tools': 'Dynamically loaded tools',
  'commands.model.add.added': 'Model "{alias}" added — pick it in the selector to switch.',
  'commands.model.add.saveFailed': 'Failed to save model: {error}',
  'commands.model.edit.gone': 'Model "{alias}" no longer exists.',
  'commands.model.edit.guard':
    'Model "{alias}" is built-in or managed — only custom models can be edited.',
  'commands.model.edit.unchanged': 'Model "{alias}" unchanged.',
  'commands.model.edit.updated': 'Model "{alias}" updated.',
  'commands.model.edit.contextSubtitle': 'Current: {current} tokens.',
  'commands.model.manage.guard':
    'Model "{alias}" is built-in or managed — only custom models can be edited or deleted.',
  'commands.model.manage.deleted': 'Model "{alias}" deleted.',
  'commands.model.manage.deleteFailed': 'Failed to delete model "{alias}": {error}',
  'commands.model.manage.activeReverted': 'Current model was removed — switched to {name}.',
  'commands.model.manage.subagentCleared':
    'Deleted model was the subagent default — subagents now follow the main model.',
  'commands.model.manage.noneLeft': 'No models remain configured — add one with /model add.',
  'commands.model.switchWhileStreaming':
    'Cannot switch models while streaming — press Esc or Ctrl-C first.',
  'commands.model.switchFailed': 'Failed to switch model: {error}',
  'commands.model.persistFailed': 'Switched to {name}, but failed to save default: {error}',
  'commands.model.switched': 'Switched to {name} with thinking {effort}.',
  'commands.model.switchedSession': 'Switched to {name} with thinking {effort} for this session only.',
  'commands.model.thinkingSet': 'Thinking set to {effort}.',
  'commands.model.thinkingSetSession': 'Thinking set to {effort} for this session only.',
  'commands.model.savedDefault': 'Saved {name} with thinking {effort} as default.',
  'commands.model.alreadyUsing': 'Already using {name} with thinking {effort}.',
  'commands.model.subagentSet': 'Subagent model set to {name} with thinking {effort}.',
  'commands.model.subagentCleared': 'Subagent model cleared — subagents follow the main model.',
  'commands.model.subagentFailed': 'Failed to save subagent model: {error}',
  'commands.model.refreshSkipped': 'Skipped refreshing models: {error}',
  'commands.model.refreshProviderSkipped': 'Skipped refreshing {provider}: {reason}',
  'commands.switch.cacheWarning':
    'Note: Switching models invalidates the existing prompt cache. Use /new to avoid extra token costs.',
  'commands.effort.noModel': 'No model selected. Run /model to select one first.',
  'commands.effort.unsupported': 'Unsupported thinking effort "{effort}" for {alias}. Available: {available}',
  'commands.effort.unlisted':
    'Thinking effort "{effort}" is not listed for {alias} (known: {known}). Sending "{effort}" unchanged; the configured provider will validate it.',
  'commands.effort.noneDeclared': 'none declared',

  // ── /fast ──
  'commands.fast.on': 'Fast mode: ON',
  'commands.fast.off': 'Fast mode: OFF',
  'commands.fast.unsupported':
    '/fast is unavailable for the current model: it needs an OpenAI Responses endpoint that declares the priority service tier — the official ChatGPT Codex backend, or a provider with serviceTiers: ["priority"] in config.toml.',
  'commands.fast.failed': 'Failed to toggle fast mode: {error}',
  'commands.fast.persistFailed': 'Failed to persist fast mode: {error}',

  // ── /permission ──
  'commands.permission.unchanged': 'Permission mode unchanged: {mode}.',
  'commands.permission.failed': 'Failed to set permission mode: {error}',
  'commands.permission.mode': 'Permission mode: {mode}',

  // ── /experiments ──
  'commands.experiments.loadFailed': 'Failed to load experimental features: {error}',
  'commands.experiments.noChanges': 'No experimental feature changes to apply.',
  'commands.experiments.updated': 'Experimental features updated.',
  'commands.experiments.updatedReloaded': 'Experimental features updated. Session reloaded.',
  'commands.experiments.failed': 'Failed to update experimental features: {error}',

  // ── automatic updates ──
  'commands.upgrade.alreadyEnabled': 'Automatic updates already enabled.',
  'commands.upgrade.alreadyDisabled': 'Automatic updates already disabled.',
  'commands.upgrade.enabled': 'Automatic updates enabled.',
  'commands.upgrade.disabled': 'Automatic updates disabled.',
  'commands.upgrade.saveFailed': 'Failed to save automatic update setting: {error}',

  // ── fullscreen mode ──
  'commands.fullscreen.alreadyEnabled': 'Fullscreen mode already enabled.',
  'commands.fullscreen.alreadyDisabled': 'Fullscreen mode already disabled (inline mode).',
  'commands.fullscreen.enabled': 'Fullscreen mode enabled (alternate screen).',
  'commands.fullscreen.disabled':
    'Fullscreen mode disabled — classic inline mode; mouse reporting is off and terminal scrollback is native.',
  'commands.fullscreen.saveFailed': 'Failed to save fullscreen setting: {error}',

  // ── /goal ──
  'commands.goal.objectiveRequired': 'Provide a goal objective, e.g. `/goal Ship feature X`.',
  'commands.goal.objectiveTooLong':
    'Goal objective is too long (max {max} characters). Reference long details by file path.',
  'commands.goal.nextObjectiveRequired':
    'Provide an upcoming goal objective, e.g. `/goal next Ship feature X`, or use `/goal next manage`.',
  'commands.goal.startNextNow': 'No active goal. Starting this goal now.',
  'commands.goal.inspectFailed': 'Failed to inspect current goal: {error}',
  'commands.goal.queueLoadFailed': 'Failed to load upcoming goals: {error}',
  'commands.goal.queueUpdateFailed': 'Failed to update upcoming goals: {error}',
  'commands.goal.queueItemGone': 'Queued goal no longer exists.',
  'commands.goal.queueItemUpdateFailed': 'Failed to update upcoming goal: {error}',
  'commands.goal.notStarted': 'Goal not started.',
  'commands.goal.alreadyActive':
    'A goal is already active. Use `/goal replace <objective>` to replace it, or `/goal status` to inspect it.',
  'commands.goal.noneToPause': 'No goal to pause.',
  'commands.goal.paused': 'Goal paused. Use `/goal resume` to continue.',
  'commands.goal.noneToResume': 'No goal to resume.',
  'commands.goal.noneToCancel': 'No goal to cancel.',
  'commands.goal.cancelled': 'Goal cancelled.',
  'commands.goal.noneSet': 'No goal set. Start one with `/goal <objective>`.',

  // ── /undo (the promptCount plurals are shared with /rewind) ──
  'commands.undo.busyStreaming': 'Cannot undo while streaming — press Esc or Ctrl-C first.',
  'commands.undo.usage': 'Usage: /undo [count], where count is a positive integer.',
  'commands.undo.nothing': 'Nothing to undo.',
  'commands.undo.nothingAfterCompaction': 'Nothing to undo after the last compaction.',
  'commands.undo.failed': 'Failed to undo: {error}',
  'commands.undo.limit':
    'Cannot undo {requested}; only {max} can be undone in the active context{reason}.',
  'commands.undo.limitReasonCompaction': ' after the last compaction',
  'commands.undo.promptCount.one': '{count} prompt',
  'commands.undo.promptCount.other': '{count} prompts',
  'commands.undo.unknownSkill': 'Skill: unknown',
  'commands.undo.userMessage': 'User message',
  'commands.undo.userMessageImages.one': 'User message ({count} image)',
  'commands.undo.userMessageImages.other': 'User message ({count} images)',

  // ── /rewind ──
  'commands.rewind.busyStreaming': 'Cannot rewind while streaming — press Esc or Ctrl-C first.',
  'commands.rewind.usage':
    'Usage: /rewind [count] [code|conversation|both], where count is a positive integer.',
  'commands.rewind.nothing': 'Nothing to rewind.',
  'commands.rewind.nothingAfterCompaction': 'Nothing to rewind after the last compaction.',
  'commands.rewind.selectorTitle': 'Select messages to rewind to',
  'commands.rewind.success':
    'Rewound {files} to before {prompts} ago (the pre-rewind state is kept in the session log).',
  'commands.rewind.limit': 'Cannot rewind {requested}; only {rewindable} have file snapshots.',
  'commands.rewind.filesFailed': 'Failed to rewind files: {error}',
  'commands.rewind.fileCount.one': '{count} file',
  'commands.rewind.fileCount.other': '{count} files',

  // ── /title & /fork ──
  'commands.title.current': 'Session title: {title}',
  'commands.title.notSet': 'Session title: (not set) — id: {id}',
  'commands.title.failed': 'Failed to set title: {error}',
  'commands.title.set': 'Session title set to: {title}',
  'commands.fork.titlePrefix': 'Fork: {title}',
  'commands.fork.failed': 'Failed to fork session: {error}',
  'commands.fork.success': 'Session forked ({id}). To return to the original session: {command}',
  'commands.fork.switchFailed': 'Failed to switch to forked session: {error}',

  // ── /export-md, /export-debug-zip & /init ──
  'commands.exportMd.exporting': 'Exporting session as Markdown…',
  'commands.exportMd.empty': 'No messages to export.',
  'commands.exportMd.exported': 'Exported {count} messages',
  'commands.export.failed': 'Failed to export session: {error}',
  'commands.exportDebugZip.exporting': 'Exporting session…',
  'commands.exportDebugZip.complete': 'Export complete',
  'commands.init.failed': 'Init failed: {error}',

  // ── /add-dir ──
  'commands.add-dir.none': 'No additional directories configured.',
  'commands.add-dir.listHeader': 'Additional directories:',
  'commands.add-dir.title': 'Add directory to workspace: {input}',
  'commands.add-dir.hint': '↑↓ navigate · Enter confirm · Esc cancel',
  'commands.add-dir.session': 'Yes, for this session',
  'commands.add-dir.remember': 'Yes, and remember this directory',
  'commands.add-dir.no': 'No',
  'commands.add-dir.notAdded': 'Did not add {path} as a working directory.',
  'commands.add-dir.addedPersist':
    'Added workspace directory:\n  {path}\n  Saved to:\n  {configPath}',
  'commands.add-dir.addedSession': 'Added workspace directory:\n  {path}\n  For this session only',

  // ── /copy ──
  'commands.copy.empty': 'No assistant message to copy.',
  'commands.copy.copied': 'Copied to clipboard ({count} characters).',
  'commands.copy.copiedUnverified':
    'Copied via terminal escape sequence (unverified, {count} characters).',
  'commands.copy.failed': 'Failed to copy to clipboard: {error}',

  // ── /btw ──
  'commands.btw.failed': 'Failed to start /btw: {error}',

  // ── /reload & /reload-tui ──
  'commands.reload.tuiDone': 'TUI config reloaded.',
  'commands.reload.sessionDone': 'Session reloaded.',
  'commands.reload.noSession': 'Runtime and TUI config reloaded; no active session.',

  // ── /provider ──
  'commands.provider.addFailed': 'Add provider failed: {error}',
  'commands.provider.removeFailed': 'Remove provider failed: {error}',
  'commands.provider.deleteFailed': 'Failed to delete provider {id}: {error}',
  'commands.provider.addTitle': 'Add provider',
  'commands.provider.knownOption': 'Known third-party provider',
  'commands.provider.customOption': 'Custom registry (api.json)',
  'commands.provider.fetchingCatalog': 'Fetching catalog from {url}',
  'commands.provider.catalogLoaded': 'Catalog loaded.',
  'commands.provider.catalogLoadedBuiltIn': 'Catalog loaded from built-in snapshot (models.dev unreachable).',
  'commands.secondaryModel.description': 'Configure the secondary model for subagents',
  'commands.secondaryModel.argumentHint': '[model-alias]',
  'commands.secondaryModel.title': ' Select a secondary model (subagents)',
  'commands.secondaryModel.saveFailed': 'Failed to save secondary model: {error}',
  'commands.secondaryModel.applyFailed':
    'Saved {name} as the secondary model, but failed to apply it to this session: {error}',
  'commands.secondaryModel.envOverride':
    'Saved {name} as the secondary model, but {vars} overrides it at runtime — subagents bind {effective} until the env var is unset.',
  'commands.secondaryModel.saved': 'Secondary model set to {name} with thinking {effort}.',
  'commands.secondaryModel.savedNextSessions':
    'Secondary model set to {name} with thinking {effort}; applies to new sessions.',
  'commands.provider.catalogAborted': 'Aborted.',
  'commands.provider.catalogLoadFailed': 'Failed to load catalog.',
  'commands.provider.catalogFetchFailed': 'Failed to fetch catalog{hint}: {error}',
  'commands.provider.catalogHttpHint': ' (HTTP {status})',
  'commands.provider.catalogEmpty': 'Catalog has no providers with supported wire types.',
  'commands.provider.selectProvider': 'Select a provider',
  'commands.provider.noUsableModels': 'Provider "{id}" has no usable models in this catalog.',
  'commands.provider.unsupportedWire': 'Provider "{id}" has unsupported wire type.',
  'commands.provider.added': 'Provider added: {name}',
  'commands.provider.unknownExplicitType':
    'Provider "{id}" declares protocol "{type}" in the catalog, which this client version does not support.',
  'commands.provider.proprietarySdk':
    'Provider "{id}" uses a proprietary SDK this client cannot speak (e.g. Amazon Bedrock or Cohere); it cannot be imported from the catalog.',
  'commands.provider.baseUrlPlaceholder':
    'Base URL contains an env placeholder or is empty. Enter the resolved URL instead.',
  'commands.provider.protocolGuessed':
    'Protocol guessed as "openai" for {id} — edit "type" in config.toml if requests fail.',
  'commands.provider.setDefaultFailed': 'Set default model failed: {error}',
  'commands.provider.defaultSet': 'Default model set to {alias} with thinking {effort}.',
  'commands.provider.importFailed': 'Failed to import registry: {error}',
  'commands.provider.applyFailed': 'Failed to apply registry: {error}',
  'commands.provider.registryEmpty': 'Registry contained no providers.',
  'commands.provider.imported.one': 'Imported {count} provider from registry.',
  'commands.provider.imported.other': 'Imported {count} providers from registry.',
  'commands.provider.manualOption': 'Custom endpoint (API type, base URL, key)',
  'commands.provider.custom.typeTitle': 'Select API type',
  'commands.provider.custom.type.kimi.label': 'Kimi',
  'commands.provider.custom.type.kimi.description':
    'Kimi / Moonshot-compatible endpoint (type: kimi)',
  'commands.provider.custom.type.anthropic.label': 'Anthropic',
  'commands.provider.custom.type.anthropic.description':
    'Anthropic Messages API — Claude-compatible (type: anthropic)',
  'commands.provider.custom.type.openai.label': 'OpenAI (legacy)',
  'commands.provider.custom.type.openai.description':
    'OpenAI Chat Completions API (type: openai)',
  'commands.provider.custom.type.openai_responses.label': 'OpenAI Responses',
  'commands.provider.custom.type.openai_responses.description':
    'OpenAI Responses API (type: openai_responses)',
  'commands.provider.custom.baseUrlTitle': 'Base URL ({type})',
  'commands.provider.custom.baseUrlSubtitle': 'The endpoint root, e.g. {example}.',
  'commands.provider.custom.baseUrlSubtitleOptional':
    'The endpoint root, e.g. {example}. Leave empty for the official default.',
  'commands.provider.custom.baseUrlInvalid': 'Enter a valid URL starting with http:// or https://.',
  'commands.provider.custom.apiKeyTitle': 'API key ({type})',
  'commands.provider.custom.apiKeySubtitle':
    'Stored in config.toml. Fallback: the {env} environment variable.',
  'commands.provider.custom.apiKeyEditSubtitle':
    'Leave empty to keep the current key. Fallback: the {env} environment variable.',
  'commands.provider.custom.idTitle': 'Provider id',
  'commands.provider.custom.idSubtitle':
    'Unique id for this provider; model aliases are prefixed with it: {id}/my-model.',
  'commands.provider.custom.idInvalid':
    'Use lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.',
  'commands.provider.custom.idTaken': 'Provider "{id}" already exists.',
  'commands.provider.custom.idReserved':
    '"{id}" is reserved for a built-in service — pick another name.',
  'commands.provider.custom.verifyTitle': 'Test the connection before saving?',
  'commands.provider.custom.verifyYes': 'Test connection',
  'commands.provider.custom.verifyNo': 'Skip',
  'commands.provider.custom.verifying': 'Probing {url}…',
  'commands.provider.custom.verifyOk': 'Connection OK.',
  'commands.provider.custom.verifyOkCount': 'Connection OK — {count} models listed.',
  'commands.provider.custom.verifyFailedSpinner': 'Connection check failed.',
  'commands.provider.custom.verifyFailed':
    'Connection check failed: {error}. Saving anyway — you can fix it later in config.toml.',
  'commands.provider.custom.verifyFailedUnknown': 'unknown error',
  'commands.provider.custom.added': 'Provider "{id}" added.',
  'commands.provider.custom.saveFailed': 'Failed to save provider: {error}',
  'commands.provider.custom.addModelNowTitle': 'Provider "{id}" added. Add a model now?',
  'commands.provider.custom.addModelNowYes': 'Add a model',
  'commands.provider.custom.addModelNowNo': 'Done',
  'commands.provider.edit.gone': 'Provider "{id}" no longer exists.',
  'commands.provider.edit.guard':
    'Provider "{id}" is built-in or managed — only custom providers can be edited.',
  'commands.provider.addModel.guard':
    'Provider "{id}" is built-in or managed — only custom providers take models this way.',
  'commands.provider.deleted.one': 'Deleted provider: {id}.',
  'commands.provider.deleted.other': 'Deleted {count} providers.',
  'commands.provider.edit.unsupportedType':
    'Provider "{id}" has API type "{type}", which the edit wizard does not support.',
  'commands.provider.edit.unchanged': 'Provider "{id}" unchanged.',
  'commands.provider.edit.updated': 'Provider "{id}" updated.',

  // ── /login & /logout ──
  'commands.login.loggedIn': 'Logged in.',
  'commands.login.cancelled': 'Login cancelled.',
  'commands.login.failedSpinner': 'Login failed.',
  'commands.login.refreshFailed':
    'Authentication successful, but failed to refresh config: {error}',
  'commands.login.alreadyLoggedIn': 'Already logged in. Model configuration refreshed.',
  'commands.login.failed': 'Login failed: {error}',
  'commands.login.verifyKeyFailed': 'Failed to verify API key: {error}',
  'commands.login.cloudCodeKeyHint':
    'Hint: If your API key was obtained from Cloud Code CLI, please select "Cloud Code CLI" instead.',
  'commands.login.noModels': 'No models available for this platform.',
  'commands.login.setupComplete': 'Setup complete: {platform} · {model}',
  'commands.login.savedTo': 'saved to',
  'commands.login.apiKeyDefaultSubtitle': 'Your key will be saved to ~/.cloud-code/config.toml',
  'commands.login.chatgptCodexNotice': 'Sign in to ChatGPT — open this URL in your browser:',
  'commands.logout.nothing': 'Nothing to logout.',
  'commands.logout.oauthDescription': 'OAuth login',
  'commands.logout.done': 'Logged out from {label}.',
  'commands.logout.selectProvider': 'Select a provider to log out',

  // ── /feedback attachment picker ──
  'commands.feedback.attachmentTitle': 'Share diagnostic info to help us investigate?',
  'commands.feedback.attachNone.label': 'No attachment',
  'commands.feedback.attachNone.description': 'Text feedback only',
  'commands.feedback.attachLogs.label': 'Logs only',
  'commands.feedback.attachLogs.description':
    'Upload wire events and diagnostic logs from this session',
  'commands.feedback.attachCodebase.label': 'Logs + codebase',
  'commands.feedback.attachCodebase.description':
    'Include your codebase for deeper diagnosis. Sensitive files are automatically excluded — e.g. .env, config files, secret keys. We use attachments only for diagnosis and never share them.',

  // ── /mcp ──
  'commands.mcp.loadFailed': 'Failed to load MCP servers: {error}',

  // ── /sandbox ──
  'commands.sandbox.loadFailed': 'Failed to load sandbox status: {error}',

  // ── /import ──
  'commands.import.description': 'Import data from Claude Code, Codex, or Kimi Code',
  'commands.import.arg.claude': 'Import Claude Code instructions, skills, and MCP settings',
  'commands.import.arg.codex': 'Import Codex instructions, skills, and MCP settings',
  'commands.import.arg.kimi': 'Import Kimi Code config, sessions, history, and more',
  'commands.import.unknownSource': 'Unknown import source: {source} (expected claude, codex, or kimi)',
  'commands.import.kimi.sourceMissing': 'Kimi Code data not found at {path}',
  'commands.import.kimi.scanFailed': 'Failed to scan Kimi Code data: {error}',
  'commands.import.kimi.nothingToImport': 'Nothing new to import — everything found is already present.',
  'commands.import.kimi.nothingButCredentials':
    'Nothing else to import — only credentials are available. Credentials are never copied unless you opt in next.',
  'commands.import.kimi.cancelled': 'Import cancelled.',
  'commands.import.kimi.applying': 'Importing…',
  'commands.import.kimi.done.title': 'Import from Kimi Code finished',
  'commands.import.kimi.done.reloadHint':
    'Run /reload (or start a new session) to pick up imported config, skills, and sessions.',
  'commands.import.kimi.done.skippedSummary':
    '{count} planned item(s) left untouched, as previewed (conflicts/duplicates/incompatible).',
  'commands.import.kimi.note.homedirNotRewritten':
    'Note: session {sessionId} has {count} agent path(s) outside its session dir and was not rewritten — it may have been moved before, and resuming it could still reference old paths.',
  'commands.import.kimi.errors': '{count} item(s) failed to import:',
  'commands.import.kimi.applyFailed': 'Import failed: {error}',
  'commands.import.kimi.countSeparator': ' · ',
  'commands.import.kimi.count.none': 'No items were imported.',
  'commands.import.kimi.count.config': '{count} config keys',
  'commands.import.kimi.count.keybindings': '{count} keybindings',
  'commands.import.kimi.count.mcp': '{count} MCP servers',
  'commands.import.kimi.count.instructions': '{count} instruction block(s)',
  'commands.import.kimi.count.skills': '{count} skills',
  'commands.import.kimi.count.sessions': '{count} sessions',
  'commands.import.kimi.count.inputHistory': '{count} history entries',
  'commands.import.kimi.count.credentials': '{count} credential files',
  'commands.import.reason.conflict': 'already exists, kept yours',
  'commands.import.reason.duplicate': 'already imported',
  'commands.import.reason.incompatible': 'incompatible format',
  'commands.import.reason.invalid': 'invalid or unreadable',
  'commands.import.reason.empty': 'empty',
  'commands.import.summary.config': 'Config: {imported} keys to import, {kept} existing kept',
  'commands.import.summary.keybindings': 'Keybindings: {imported} to import, {kept} existing kept',
  'commands.import.summary.mcp': 'MCP servers: {imported} to import, {kept} existing kept',
  'commands.import.summary.configBlocked': 'Config: blocked, target file unreadable ({path})',
  'commands.import.summary.keybindingsBlocked':
    'Keybindings: blocked, target file unreadable ({path})',
  'commands.import.summary.mcpBlocked': 'MCP: blocked, target file unreadable ({path})',
  'commands.import.summary.instructions': 'Instructions: append 1 AGENTS.md block',
  'commands.import.summary.instructionsSkip': 'Instructions: skipped ({reason})',
  'commands.import.summary.skills': 'Skills: {imported} to import, {skipped} skipped',
  'commands.import.summary.sessions': 'Sessions: {imported} to import, {skipped} skipped',
  'commands.import.summary.history': 'Input history: {imported} new entries in {files} files',
  'commands.import.summary.credentials':
    'Credentials: {count} available — NOT imported unless you opt in afterwards',
  'commands.import.summary.blocker': 'Blocked: {blocker}',
  'commands.import.detail.title': 'Kimi Code import plan',
  'commands.import.detail.source': 'Source: {path}',
  'commands.import.detail.target': 'Target: {path}',
  'commands.import.detail.config': 'Config → {path}',
  'commands.import.detail.keybindings': 'Keybindings → {path}',
  'commands.import.detail.mcp': 'MCP servers → {path}',
  'commands.import.detail.instructions': 'Instructions → {path}',
  'commands.import.detail.skills': 'Skills',
  'commands.import.detail.sessions': 'Sessions',
  'commands.import.detail.history': 'Input history (new entries)',
  'commands.import.detail.credentials': 'Credentials (opt-in)',
  'commands.import.detail.renameHint': 'can be imported as {name}',
  'commands.import.detail.credentialsOptIn': 'imported only if you opt in',
} as const;

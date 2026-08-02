/** See common.ts for contribution rules. */

export const plugins = {
  // ── /plugins panel tabs ──
  'plugins.tab.installed': 'Installed',
  'plugins.tab.official': 'Official',
  'plugins.tab.thirdParty': 'Third-party',
  'plugins.tab.custom': 'Custom',

  // ── /plugins panel chrome ──
  'plugins.panel.title': ' Plugins',
  'plugins.panel.hint.installed':
    ' Tab switch · Space toggle · Alt+D remove · Alt+M MCP · {enter}{altDetails} · Alt+R reload · {search}',
  'plugins.panel.hint.enterUpdate': 'Enter update',
  'plugins.panel.hint.enterDetails': 'Enter details',
  'plugins.panel.hint.altDetails': 'Alt+I details',
  'plugins.panel.hint.marketplace': ' Tab switch · ↑↓ navigate · Enter open/install · {search}',
  'plugins.panel.hint.custom': ' Tab switch · Enter install · Esc cancel',

  // ── Installed tab ──
  'plugins.installed.empty': '  No plugins installed.',
  'plugins.installed.count': ' {count} installed',

  // ── Marketplace tabs ──
  'plugins.marketplace.loading': '  Loading marketplace…',
  'plugins.marketplace.unavailable': '  Marketplace unavailable: {message}',
  'plugins.marketplace.unavailableHint': '  Use the Custom tab to install from a URL.',
  'plugins.marketplace.empty': '  No plugins found.',
  'plugins.marketplace.count': ' {installed} installed · {available} available',
  'plugins.marketplace.source': ' Source: {source}',
  'plugins.marketplace.mergedSource': '{source} · {count} custom',
  'plugins.marketplace.status.update': 'update {local} → {latest}',
  'plugins.marketplace.status.installed': 'installed',
  'plugins.marketplace.status.installedVersion': 'installed · v{version}',
  'plugins.marketplace.status.install': 'install',
  'plugins.marketplace.status.installVersion': 'install v{version}',
  'plugins.marketplace.status.openInBrowser': 'open in browser',

  // ── Custom tab / installing ──
  'plugins.custom.prompt': ' Install from a GitHub URL (or zip URL / local path):',
  'plugins.installing': '  Installing {label} from marketplace…',

  // ── Pinned Web Bridge entry ──
  'plugins.webbridge.description':
    'Control your real browser from Cloud Code CLI — navigate, click, type, and screenshot',

  // ── MCP server selector ──
  'plugins.mcp.title': ' MCP servers · {name}',
  'plugins.mcp.hint': ' ↑↓ navigate · Enter/Space enable/disable · Esc cancel',
  'plugins.mcp.section': 'MCP servers ({enabled}/{total} enabled)',
  'plugins.mcp.empty': '  No MCP servers declared.',
  'plugins.mcp.actions': 'Actions',
  'plugins.mcp.back.label': 'Back to installed plugins',
  'plugins.mcp.back.description': 'Return to the local plugin manager.',
  'plugins.mcp.action.enable': 'Enter/Space enable',
  'plugins.mcp.action.disable': 'Enter/Space disable',

  // ── Shared confirm hint ──
  'plugins.confirm.hint': '↑↓ navigate · Enter/Space select · ←/Esc cancel',

  // ── Remove confirmation ──
  'plugins.remove.title': 'Remove {name} ({id})?',
  'plugins.remove.cancel.label': 'Cancel',
  'plugins.remove.cancel.description': 'Keep this plugin installed.',
  'plugins.remove.remove.label': 'Remove plugin',
  'plugins.remove.remove.description':
    'Remove only the install record; plugin files are left in place.',

  // ── Third-party install trust confirmation ──
  'plugins.trust.title': 'Install third-party plugin {label}?',
  'plugins.trust.notice':
    '⚠️ This is a third-party plugin that Kimi has not reviewed. It can bundle MCP servers, hooks, slash commands, skills, or files that run code and access your workspace. Install it only if you trust the source.',
  'plugins.trust.exit.label': 'Exit',
  'plugins.trust.exit.description': 'Cancel the installation.',
  'plugins.trust.trust.label': 'Trust and install',
  'plugins.trust.trust.description': 'Install this third-party plugin anyway.',

  // ── Row status / tier labels / overview fragments ──
  'plugins.status.enabled': 'enabled',
  'plugins.status.disabled': 'disabled',
  'plugins.tier.official': 'Official plugin',
  'plugins.tier.curated': 'Curated plugin',
  'plugins.tier.other': 'Plugin',
  'plugins.overview.skills.one': '{count} skill',
  'plugins.overview.skills.other': '{count} skills',
  'plugins.overview.state': 'state {state}',
  'plugins.overview.diagnostics': 'diagnostics available',

  // ── /plugins command feedback ──
  'plugins.command.usageInstall': 'Usage: /plugins install <local-path-or-zip-url>',
  'plugins.command.installCancelled': 'Install cancelled.',
  'plugins.command.installCancelledLabel': 'Install cancelled: {label}.',
  'plugins.command.installingFrom': 'Installing plugin from {source}…',
  'plugins.command.installFinished': 'Install finished — see details below.',
  'plugins.command.installFailedSpinner': 'Install failed: {error}',
  'plugins.command.usageMcp': 'Usage: /plugins mcp enable|disable <id> <server>',
  'plugins.command.mcpEnabled':
    'Enabled MCP server {server} for {id}. Run /reload or /new to apply.',
  'plugins.command.mcpDisabled':
    'Disabled MCP server {server} for {id}. Run /reload or /new to apply.',
  'plugins.command.usageRemove': 'Usage: /plugins remove <id>',
  'plugins.command.removeCancelled': 'Remove cancelled: {id}.',
  'plugins.command.unknownAction':
    'Unknown /plugins action: {action}. Run /plugins to choose interactively.',
  'plugins.command.failed': '/plugins {action} failed: {error}',
  'plugins.command.actionFailed': '/plugins failed: {error}',
  'plugins.command.loadFailed': 'Failed to load plugins: {error}',
  'plugins.command.loadMcpFailed': 'Failed to load plugin MCP servers: {error}',
  'plugins.command.mcpFailed': '/plugins mcp failed: {error}',
  'plugins.command.installingOrUpdating': 'Installing or updating {label} from marketplace...',
  'plugins.command.installFailed': 'Failed to install {label}: {error}',
  'plugins.command.mcpDisabledHint':
    ' Some MCP servers are disabled; re-enable with /plugins mcp enable {id} <server>.',
  'plugins.command.enabled': 'Enabled {id}. Run /reload or /new to apply.{mcpHint}',
  'plugins.command.disabled': 'Disabled {id}. Run /reload or /new to apply.{mcpHint}',
  'plugins.command.inlineMcpDisabled': ' · MCP servers disabled',
  'plugins.command.inlineReloadHint': 'run /reload or /new to apply',
  'plugins.command.openingUrl': 'Opening the {label} page in your browser…',
  'plugins.command.openUrlFallback': 'If it did not open, visit {url}',
  'plugins.command.removed': 'Removed {id}.',
  'plugins.command.reloadHint': 'Run /new or /reload to apply plugin changes.',
  'plugins.command.quotaNote': 'Note: This plugin consumes your quota.',
  'plugins.command.listTitle': ' Plugins ({count}) ',
  'plugins.command.declaresMcp.one':
    ' Declares {count} MCP server; enabled by default and configurable from /plugins.',
  'plugins.command.declaresMcp.other':
    ' Declares {count} MCP servers; enabled by default and configurable from /plugins.',
  'plugins.command.installed': 'Installed {name}{version} {source}',
  'plugins.command.migrated': 'Migrated {name}: {previousSource} → {source}{version}',
  'plugins.command.updated': 'Updated {name}{version} {source}',
  'plugins.command.sourceFrom': 'from {label}',
  'plugins.command.reloadSummary': 'Reload: +{added} -{removed}',
  'plugins.command.reloadErrors': ' ({count} errors)',

  // ── /plugins enable|disable scope + marketplace registry ──
  'plugins.command.usageEnableScope':
    'Usage: /plugins {action} <id> [--user|--project]',
  'plugins.command.enabledProject':
    'Enabled {id} for this project. Run /reload or /new to apply.{mcpHint}',
  'plugins.command.disabledProject':
    'Disabled {id} for this project. Run /reload or /new to apply.{mcpHint}',
  'plugins.command.usageMarketplaceAdd':
    'Usage: /plugins marketplace add [<name> <source>] — run without arguments for the guided flow',
  'plugins.command.usageMarketplaceRemove': 'Usage: /plugins marketplace remove <name>',
  'plugins.command.usageMarketplaceRefresh': 'Usage: /plugins marketplace refresh [name]',
  'plugins.command.marketplaceAddCancelled': 'Marketplace add cancelled.',
  'plugins.command.marketplaceValidating': 'Validating marketplace manifest: {source}…',
  'plugins.command.marketplaceValidated': 'Marketplace manifest validated.',
  'plugins.command.marketplaceValidateFailed': 'Marketplace validation failed: {error}',
  'plugins.command.marketplaceAdded': 'Marketplace "{name}" added ({count} plugins): {source}',
  'plugins.command.marketplaceRemoved': 'Marketplace "{name}" removed.',
  'plugins.command.marketplaceRemoveCancelled': 'Marketplace remove cancelled: {name}.',
  'plugins.command.marketplaceNotRegistered': 'Marketplace "{name}" is not registered.',
  'plugins.command.marketplaceGitNeedsRegistration':
    'Git marketplaces must be registered before browsing: /plugins marketplace add <name> <source>',
  'plugins.command.marketplacesSkipped': 'Skipped unavailable marketplaces: {names}',
  'plugins.command.marketplacePluginCount': '{count} plugins',
  'plugins.command.marketplaceUnavailable': 'unavailable',
  'plugins.command.marketplaceRefreshing': 'Refreshing marketplace "{name}"…',
  'plugins.command.marketplaceRefreshed': 'Marketplace "{name}" refreshed: {count} plugins.',
  'plugins.command.marketplaceRefreshFailed': 'Marketplace "{name}" refresh failed: {error}',
  'plugins.command.marketplaceEntryNotFound':
    'Plugin "{id}" not found in marketplace "{marketplace}". Available: {available}',
  'plugins.command.installNotFound':
    'Plugin "{id}" was not found in any registered marketplace. Pass a path, zip URL, or GitHub repo to install from a source instead.',
  'plugins.command.installPickMarketplace': 'Install "{id}" from which marketplace?',
  'plugins.command.marketplaceListTitle': ' Plugin marketplaces ({count}) ',
  'plugins.command.marketplaceDefault': 'default',

  // ── /plugins marketplace add wizard ──
  'plugins.marketplaceAdd.typeTitle': 'Add marketplace — choose the source type',
  'plugins.marketplaceAdd.type.github.label': 'GitHub repository',
  'plugins.marketplaceAdd.type.github.description': 'owner/repo shorthand or a GitHub repo URL.',
  'plugins.marketplaceAdd.type.git.label': 'Git URL',
  'plugins.marketplaceAdd.type.git.description': 'Any git remote (https://….git or git@host:…).',
  'plugins.marketplaceAdd.type.url.label': 'Manifest URL',
  'plugins.marketplaceAdd.type.url.description': 'Direct https:// URL to a marketplace.json file.',
  'plugins.marketplaceAdd.type.local.label': 'Local path',
  'plugins.marketplaceAdd.type.local.description':
    'A marketplace.json file or a directory containing one.',
  'plugins.marketplaceAdd.sourceTitle': 'Marketplace source ({type})',
  'plugins.marketplaceAdd.sourceSubtitle.github': 'e.g. owner/repo or https://github.com/owner/repo',
  'plugins.marketplaceAdd.sourceSubtitle.git': 'e.g. https://example.com/repo.git or git@example.com:repo.git',
  'plugins.marketplaceAdd.sourceSubtitle.url': 'e.g. https://example.com/marketplace.json',
  'plugins.marketplaceAdd.sourceSubtitle.local': 'e.g. ./my-marketplace or ~/marketplaces/acme',
  'plugins.marketplaceAdd.sourceKindMismatch': 'That source does not look like a {type} source.',
  'plugins.marketplaceAdd.nameTitle': 'Marketplace name',
  'plugins.marketplaceAdd.nameSubtitle': 'kebab-case; used in /plugins marketplace <name>.',
  'plugins.marketplaceAdd.nameInvalid':
    'Lowercase letters, digits, "-" and "_" only, starting with a letter or digit; "official" and "builtin" are reserved.',
  'plugins.marketplaceAdd.nameTaken': 'Marketplace "{name}" already exists.',

  // ── Marketplace trust + remove confirmations ──
  'plugins.marketplaceTrust.title': 'Add third-party marketplace {label}?',
  'plugins.marketplaceTrust.notice':
    '⚠️ This marketplace is not reviewed by Kimi. Plugins installed from it can bundle MCP servers, hooks, slash commands, skills, or files that run code and access your workspace. Add it only if you trust the source.',
  'plugins.marketplaceTrust.exit.label': 'Exit',
  'plugins.marketplaceTrust.exit.description': 'Cancel without adding the marketplace.',
  'plugins.marketplaceTrust.trust.label': 'Trust and add',
  'plugins.marketplaceTrust.trust.description': 'Fetch the manifest and register this marketplace.',
  'plugins.marketplaceRemove.title': 'Remove marketplace "{name}"?',
  'plugins.marketplaceRemove.affected':
    'Installed from this marketplace: {plugins}. They stay installed.',
  'plugins.marketplaceRemove.affectedNone': 'No installed plugins came from this marketplace.',
  'plugins.marketplaceRemove.affectedUnknown':
    'Could not load the catalog to check; any plugins installed from it stay installed.',
  'plugins.marketplaceRemove.cancel.label': 'Cancel',
  'plugins.marketplaceRemove.cancel.description': 'Keep this marketplace registered.',
  'plugins.marketplaceRemove.remove.label': 'Remove marketplace',
  'plugins.marketplaceRemove.remove.description':
    'Remove the registration and cached catalog; installed plugins stay.',
} as const;

import type { plugins as enDomain } from '../en/plugins';

/** 贡献规范见 common.ts。 */

export const plugins: Record<keyof typeof enDomain, string> = {
  // ── /plugins 面板标签页 ──
  'plugins.tab.installed': '已安装',
  'plugins.tab.official': '官方',
  'plugins.tab.thirdParty': '第三方',
  'plugins.tab.custom': '自定义',

  // ── /plugins 面板框架 ──
  'plugins.panel.title': ' 插件',
  'plugins.panel.hint.installed':
    ' Tab 切换 · Space 切换 · Alt+D 移除 · Alt+M MCP · {enter}{altDetails} · Alt+R 重载 · {search}',
  'plugins.panel.hint.enterUpdate': 'Enter 更新',
  'plugins.panel.hint.enterDetails': 'Enter 详情',
  'plugins.panel.hint.altDetails': 'Alt+I 详情',
  'plugins.panel.hint.marketplace': ' Tab 切换 · ↑↓ 导航 · Enter 打开/安装 · {search}',
  'plugins.panel.hint.custom': ' Tab 切换 · Enter 安装 · Esc 取消',

  // ── 已安装标签页 ──
  'plugins.installed.empty': '  未安装任何插件。',
  'plugins.installed.count': ' {count} 个已安装',

  // ── 插件市场标签页 ──
  'plugins.marketplace.loading': '  正在加载插件市场…',
  'plugins.marketplace.unavailable': '  插件市场不可用：{message}',
  'plugins.marketplace.unavailableHint': '  请使用自定义标签页从 URL 安装。',
  'plugins.marketplace.empty': '  未找到插件。',
  'plugins.marketplace.count': ' {installed} 个已安装 · {available} 个可用',
  'plugins.marketplace.source': ' 来源：{source}',
  'plugins.marketplace.mergedSource': '{source} · {count} 个自定义市场',
  'plugins.marketplace.status.update': '更新 {local} → {latest}',
  'plugins.marketplace.status.installed': '已安装',
  'plugins.marketplace.status.installedVersion': '已安装 · v{version}',
  'plugins.marketplace.status.install': '安装',
  'plugins.marketplace.status.installVersion': '安装 v{version}',
  'plugins.marketplace.status.openInBrowser': '在浏览器中打开',

  // ── 自定义标签页 / 安装中 ──
  'plugins.custom.prompt': ' 从 GitHub URL（或 zip URL / 本地路径）安装：',
  'plugins.installing': '  正在从插件市场安装 {label}…',

  // ── 置顶 Web Bridge 条目 ──
  'plugins.webbridge.description':
    '从 Cloud Code CLI 控制你的真实浏览器——导航、点击、输入并截图',

  // ── MCP 服务器选择器 ──
  'plugins.mcp.title': ' MCP 服务器 · {name}',
  'plugins.mcp.hint': ' ↑↓ 导航 · Enter/Space 启用/禁用 · Esc 取消',
  'plugins.mcp.section': 'MCP 服务器（{enabled}/{total} 已启用）',
  'plugins.mcp.empty': '  未声明 MCP 服务器。',
  'plugins.mcp.actions': '操作',
  'plugins.mcp.back.label': '返回已安装插件',
  'plugins.mcp.back.description': '返回本地插件管理器。',
  'plugins.mcp.action.enable': 'Enter/Space 启用',
  'plugins.mcp.action.disable': 'Enter/Space 禁用',

  // ── 共享确认提示 ──
  'plugins.confirm.hint': '↑↓ 导航 · Enter/Space 选择 · ←/Esc 取消',

  // ── 移除确认 ──
  'plugins.remove.title': '移除 {name}（{id}）？',
  'plugins.remove.cancel.label': '取消',
  'plugins.remove.cancel.description': '保留此插件，不做更改。',
  'plugins.remove.remove.label': '移除插件',
  'plugins.remove.remove.description': '仅移除安装记录；插件文件保留在原处。',

  // ── 第三方插件安装信任确认 ──
  'plugins.trust.title': '安装第三方插件 {label}？',
  'plugins.trust.notice':
    '⚠️ 此第三方插件未经 Kimi 审核。它可能捆绑 MCP 服务器、钩子、斜杠命令、技能或可运行代码并访问你工作区的文件。仅在信任来源时才安装。',
  'plugins.trust.exit.label': '退出',
  'plugins.trust.exit.description': '取消安装。',
  'plugins.trust.trust.label': '信任并安装',
  'plugins.trust.trust.description': '仍然安装此第三方插件。',

  // ── 行状态 / 层级标签 / 概览片段 ──
  'plugins.status.enabled': '已启用',
  'plugins.status.disabled': '已禁用',
  'plugins.tier.official': '官方插件',
  'plugins.tier.curated': '精选插件',
  'plugins.tier.other': '插件',
  'plugins.overview.skills.one': '{count} 个技能',
  'plugins.overview.skills.other': '{count} 个技能',
  'plugins.overview.state': '状态 {state}',
  'plugins.overview.diagnostics': '有可用的诊断信息',

  // ── /plugins 命令反馈 ──
  'plugins.command.usageInstall': '用法：/plugins install <本地路径或 zip URL>',
  'plugins.command.installCancelled': '已取消安装。',
  'plugins.command.installCancelledLabel': '已取消安装：{label}。',
  'plugins.command.installingFrom': '正在从 {source} 安装插件…',
  'plugins.command.installFinished': '安装完成 — 详见下文。',
  'plugins.command.installFailedSpinner': '安装失败：{error}',
  'plugins.command.usageMcp': '用法：/plugins mcp enable|disable <id> <server>',
  'plugins.command.mcpEnabled': '已为 {id} 启用 MCP 服务器 {server}。运行 /reload 或 /new 生效。',
  'plugins.command.mcpDisabled': '已为 {id} 禁用 MCP 服务器 {server}。运行 /reload 或 /new 生效。',
  'plugins.command.usageRemove': '用法：/plugins remove <id>',
  'plugins.command.removeCancelled': '已取消移除：{id}。',
  'plugins.command.unknownAction': '未知的 /plugins 操作：{action}。运行 /plugins 交互选择。',
  'plugins.command.failed': '/plugins {action} 失败：{error}',
  'plugins.command.actionFailed': '/plugins 失败：{error}',
  'plugins.command.loadFailed': '加载插件失败：{error}',
  'plugins.command.loadMcpFailed': '加载插件 MCP 服务器失败：{error}',
  'plugins.command.mcpFailed': '/plugins mcp 失败：{error}',
  'plugins.command.installingOrUpdating': '正在从插件市场安装或更新 {label}…',
  'plugins.command.installFailed': '安装 {label} 失败：{error}',
  'plugins.command.mcpDisabledHint':
    ' 部分 MCP 服务器已禁用；用 /plugins mcp enable {id} <server> 重新启用。',
  'plugins.command.enabled': '已启用 {id}。运行 /reload 或 /new 生效。{mcpHint}',
  'plugins.command.disabled': '已禁用 {id}。运行 /reload 或 /new 生效。{mcpHint}',
  'plugins.command.inlineMcpDisabled': ' · MCP 服务器已禁用',
  'plugins.command.inlineReloadHint': '运行 /reload 或 /new 生效',
  'plugins.command.openingUrl': '正在浏览器中打开 {label} 页面…',
  'plugins.command.openUrlFallback': '若未打开，请访问 {url}',
  'plugins.command.removed': '已移除 {id}。',
  'plugins.command.reloadHint': '运行 /new 或 /reload 使插件变更生效。',
  'plugins.command.quotaNote': '注意：此插件会消耗您的额度。',
  'plugins.command.listTitle': ' 插件（{count}）',
  'plugins.command.declaresMcp.one': ' 声明 {count} 个 MCP 服务器；默认启用，可在 /plugins 中配置。',
  'plugins.command.declaresMcp.other': ' 声明 {count} 个 MCP 服务器；默认启用，可在 /plugins 中配置。',
  'plugins.command.installed': '已安装 {name}{version}，{source}',
  'plugins.command.migrated': '已迁移 {name}：{previousSource} → {source}{version}',
  'plugins.command.updated': '已更新 {name}{version}，{source}',
  'plugins.command.sourceFrom': '来自 {label}',
  'plugins.command.reloadSummary': '重载：+{added} -{removed}',
  'plugins.command.reloadErrors': '（{count} 个错误）',

  // ── /plugins enable|disable 作用域 + 市场注册表 ──
  'plugins.command.usageEnableScope': '用法：/plugins {action} <id> [--user|--project]',
  'plugins.command.enabledProject': '已为本项目启用 {id}。运行 /reload 或 /new 生效。{mcpHint}',
  'plugins.command.disabledProject': '已为本项目禁用 {id}。运行 /reload 或 /new 生效。{mcpHint}',
  'plugins.command.usageMarketplaceAdd':
    '用法：/plugins marketplace add [<名称> <来源>] — 不带参数运行可进入向导',
  'plugins.command.usageMarketplaceRemove': '用法：/plugins marketplace remove <名称>',
  'plugins.command.usageMarketplaceRefresh': '用法：/plugins marketplace refresh [名称]',
  'plugins.command.marketplaceAddCancelled': '已取消添加市场。',
  'plugins.command.marketplaceValidating': '正在验证市场清单：{source}…',
  'plugins.command.marketplaceValidated': '市场清单验证通过。',
  'plugins.command.marketplaceValidateFailed': '市场验证失败：{error}',
  'plugins.command.marketplaceAdded': '已添加市场 "{name}"（{count} 个插件）：{source}',
  'plugins.command.marketplaceRemoved': '已移除市场 "{name}"。',
  'plugins.command.marketplaceRemoveCancelled': '已取消移除市场：{name}。',
  'plugins.command.marketplaceNotRegistered': '市场 "{name}" 未注册。',
  'plugins.command.marketplaceGitNeedsRegistration':
    'Git 市场需先注册才能浏览：/plugins marketplace add <名称> <来源>',
  'plugins.command.marketplacesSkipped': '已跳过不可用的市场：{names}',
  'plugins.command.marketplacePluginCount': '{count} 个插件',
  'plugins.command.marketplaceUnavailable': '不可用',
  'plugins.command.marketplaceRefreshing': '正在刷新市场 "{name}"…',
  'plugins.command.marketplaceRefreshed': '已刷新市场 "{name}"：{count} 个插件。',
  'plugins.command.marketplaceRefreshFailed': '刷新市场 "{name}" 失败：{error}',
  'plugins.command.marketplaceEntryNotFound':
    '在市场 "{marketplace}" 中未找到插件 "{id}"。可用：{available}',
  'plugins.command.installNotFound':
    '未在任何已注册的市场中找到插件 "{id}"。如需从来源安装，请传入路径、zip URL 或 GitHub 仓库。',
  'plugins.command.installPickMarketplace': '从哪个市场安装 "{id}"？',
  'plugins.command.marketplaceListTitle': ' 插件市场（{count}）',
  'plugins.command.marketplaceDefault': '默认',

  // ── /plugins marketplace add 向导 ──
  'plugins.marketplaceAdd.typeTitle': '添加市场 — 选择来源类型',
  'plugins.marketplaceAdd.type.github.label': 'GitHub 仓库',
  'plugins.marketplaceAdd.type.github.description': 'owner/repo 简写或 GitHub 仓库 URL。',
  'plugins.marketplaceAdd.type.git.label': 'Git URL',
  'plugins.marketplaceAdd.type.git.description': '任意 git 远程地址（https://….git 或 git@host:…）。',
  'plugins.marketplaceAdd.type.url.label': '清单 URL',
  'plugins.marketplaceAdd.type.url.description': '指向 marketplace.json 文件的 https:// 直链。',
  'plugins.marketplaceAdd.type.local.label': '本地路径',
  'plugins.marketplaceAdd.type.local.description': 'marketplace.json 文件或包含它的目录。',
  'plugins.marketplaceAdd.sourceTitle': '市场来源（{type}）',
  'plugins.marketplaceAdd.sourceSubtitle.github': '例如 owner/repo 或 https://github.com/owner/repo',
  'plugins.marketplaceAdd.sourceSubtitle.git':
    '例如 https://example.com/repo.git 或 git@example.com:repo.git',
  'plugins.marketplaceAdd.sourceSubtitle.url': '例如 https://example.com/marketplace.json',
  'plugins.marketplaceAdd.sourceSubtitle.local': '例如 ./my-marketplace 或 ~/marketplaces/acme',
  'plugins.marketplaceAdd.sourceKindMismatch': '该来源看起来不是 {type} 类型。',
  'plugins.marketplaceAdd.nameTitle': '市场名称',
  'plugins.marketplaceAdd.nameSubtitle': 'kebab-case；用于 /plugins marketplace <名称>。',
  'plugins.marketplaceAdd.nameInvalid':
    '仅限小写字母、数字、"-" 和 "_"，且以字母或数字开头；"official" 和 "builtin" 为保留名。',
  'plugins.marketplaceAdd.nameTaken': '市场 "{name}" 已存在。',

  // ── 市场信任与移除确认 ──
  'plugins.marketplaceTrust.title': '添加第三方市场 {label}？',
  'plugins.marketplaceTrust.notice':
    '⚠️ 此市场未经 Kimi 审核。从中安装的插件可能捆绑 MCP 服务器、钩子、斜杠命令、技能或可运行代码并访问你工作区的文件。仅在信任来源时才添加。',
  'plugins.marketplaceTrust.exit.label': '退出',
  'plugins.marketplaceTrust.exit.description': '取消，不添加该市场。',
  'plugins.marketplaceTrust.trust.label': '信任并添加',
  'plugins.marketplaceTrust.trust.description': '获取清单并注册该市场。',
  'plugins.marketplaceRemove.title': '移除市场 "{name}"？',
  'plugins.marketplaceRemove.affected': '从此市场安装的插件：{plugins}。它们将保持安装状态。',
  'plugins.marketplaceRemove.affectedNone': '没有插件从此市场安装。',
  'plugins.marketplaceRemove.affectedUnknown': '无法加载目录以检查；从此市场安装的插件将保持安装状态。',
  'plugins.marketplaceRemove.cancel.label': '取消',
  'plugins.marketplaceRemove.cancel.description': '保留该市场的注册。',
  'plugins.marketplaceRemove.remove.label': '移除市场',
  'plugins.marketplaceRemove.remove.description': '移除注册与缓存的目录；已安装的插件保留。',
};

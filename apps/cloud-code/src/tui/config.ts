/**
 * Client-owned preferences.
 *
 * Agent/runtime settings live in core's `config.toml`; this file owns
 * Cloud Code client preferences such as terminal UI and update behavior.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

import { getDataDir } from '#/utils/paths';

import { enMessages, t } from './i18n';

/**
 * English text of the `status.tuiConfig.invalid` message, kept exported for
 * callers/tests that need a locale-independent reference. The user-facing
 * error message is localized via `t()` at throw time.
 */
export const INVALID_TUI_CONFIG_MESSAGE: string = enMessages['status.tuiConfig.invalid'];

export const TuiThemeSchema = z.string();

export const TuiLanguageSchema = z.enum(['auto', 'en', 'zh-CN']);

export const NotificationConditionSchema = z.enum(['unfocused', 'always']);

export const NotificationsConfigSchema = z.object({
  enabled: z.boolean(),
  condition: NotificationConditionSchema,
});

export const UpgradePreferencesSchema = z.object({
  autoInstall: z.boolean(),
});

export const STATUS_LINE_ITEMS = ['mode', 'goal', 'model', 'tasks', 'cwd', 'git', 'tips'] as const;
export type StatusLineItem = (typeof STATUS_LINE_ITEMS)[number];

export const StatusLineFileConfigSchema = z.object({
  items: z.array(z.string()).optional(),
  command: z.string().optional(),
});

export const StatusLineConfigSchema = z.object({
  /** Ordered built-in slots for footer line 1; null means the default layout. */
  items: z.array(z.enum(STATUS_LINE_ITEMS)).nullable(),
  /** User command whose first stdout line replaces footer line 1; null disables. */
  command: z.string().nullable(),
});
export type StatusLineConfig = z.infer<typeof StatusLineConfigSchema>;

export const DEFAULT_STATUS_LINE_CONFIG: StatusLineConfig = {
  items: null,
  command: null,
};

export const TuiConfigFileSchema = z.object({
  theme: TuiThemeSchema.optional(),
  // `.catch('auto')`: an unrecognised language degrades that single key to
  // the default instead of failing the whole file parse.
  language: TuiLanguageSchema.catch('auto').optional(),
  disable_paste_burst: z.boolean().optional(),
  fullscreen: z.boolean().optional(),
  editor: z
    .object({
      command: z.string().optional(),
      vim_mode: z.boolean().optional(),
    })
    .optional(),
  notifications: z
    .object({
      enabled: z.boolean().optional(),
      notification_condition: NotificationConditionSchema.optional(),
    })
    .optional(),
  upgrade: z
    .object({
      auto_install: z.boolean().optional(),
    })
    .optional(),
  status_line: StatusLineFileConfigSchema.optional(),
});

export const TuiConfigSchema = z.object({
  theme: TuiThemeSchema,
  language: TuiLanguageSchema,
  disablePasteBurst: z.boolean(),
  fullscreen: z.boolean(),
  editorCommand: z.string().nullable(),
  vimMode: z.boolean(),
  notifications: NotificationsConfigSchema,
  upgrade: UpgradePreferencesSchema,
  /** Present in every normalized config; optional only so hand-built test
   * fixtures from before this field existed still typecheck. */
  statusLine: StatusLineConfigSchema.optional(),
});

export type TuiConfigFileShape = z.infer<typeof TuiConfigFileSchema>;
export type TuiConfig = z.infer<typeof TuiConfigSchema>;
export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;
export type UpgradePreferences = z.infer<typeof UpgradePreferencesSchema>;

export const DEFAULT_NOTIFICATIONS_CONFIG: NotificationsConfig = {
  enabled: true,
  condition: 'unfocused',
};

export const DEFAULT_UPGRADE_PREFERENCES: UpgradePreferences = {
  // Off by default: replacing the installed binary in the background is an
  // action the user must opt into (/config, or upgrade.auto_install = true).
  autoInstall: false,
};

export const DEFAULT_TUI_CONFIG: TuiConfig = TuiConfigSchema.parse({
  theme: 'auto',
  language: 'auto',
  disablePasteBurst: false,
  fullscreen: true,
  editorCommand: null,
  vimMode: false,
  notifications: DEFAULT_NOTIFICATIONS_CONFIG,
  upgrade: DEFAULT_UPGRADE_PREFERENCES,
  statusLine: DEFAULT_STATUS_LINE_CONFIG,
});

/**
 * Thrown by `loadTuiConfig` when the on-disk TOML cannot be parsed.
 * Carries `fallback` so the caller can recover without re-running the
 * I/O, and a localized `message` (== `INVALID_TUI_CONFIG_MESSAGE` under
 * the default English locale) as a user-facing notice.
 */
export class TuiConfigParseError extends Error {
  override readonly name = 'TuiConfigParseError';
  readonly fallback: TuiConfig;
  constructor(fallback: TuiConfig) {
    super(t('status.tuiConfig.invalid'));
    this.fallback = fallback;
  }
}

export function getTuiConfigPath(): string {
  return join(getDataDir(), 'tui.toml');
}

export async function loadTuiConfig(
  filePath: string = getTuiConfigPath(),
  warn?: (message: string) => void,
): Promise<TuiConfig> {
  if (!existsSync(filePath)) {
    await saveTuiConfig(DEFAULT_TUI_CONFIG, filePath);
    return DEFAULT_TUI_CONFIG;
  }

  try {
    const text = await readFile(filePath, 'utf-8');
    return parseTuiConfig(text, warn);
  } catch {
    throw new TuiConfigParseError(DEFAULT_TUI_CONFIG);
  }
}

export function parseTuiConfig(
  tomlText: string,
  warn?: (message: string) => void,
): TuiConfig {
  if (tomlText.trim().length === 0) {
    return DEFAULT_TUI_CONFIG;
  }
  const raw = parseToml(tomlText) as Record<string, unknown>;
  const parsed = TuiConfigFileSchema.parse(raw);
  return normalizeTuiConfig(parsed, warn);
}

export async function saveTuiConfig(
  config: TuiConfig,
  filePath: string = getTuiConfigPath(),
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, renderTuiConfig(config), 'utf-8');
}

export function normalizeTuiConfig(
  config: TuiConfigFileShape,
  warn: (message: string) => void = (message) => {
    // oxlint-disable-next-line no-console
    console.warn(message);
  },
): TuiConfig {
  const command = config.editor?.command?.trim();
  const statusLineCommand = config.status_line?.command?.trim();
  const knownItems = new Set<string>(STATUS_LINE_ITEMS);
  const statusLineItems =
    config.status_line?.items
      ?.filter((item) => {
        const known = knownItems.has(item);
        if (!known) {
          warn(`[tui.toml] ignoring unknown status_line item: ${item}`);
        }
        return known;
      })
      .map((item) => item as StatusLineItem) ?? null;
  return TuiConfigSchema.parse({
    theme: config.theme ?? DEFAULT_TUI_CONFIG.theme,
    language: config.language ?? DEFAULT_TUI_CONFIG.language,
    disablePasteBurst: config.disable_paste_burst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
    fullscreen: config.fullscreen ?? DEFAULT_TUI_CONFIG.fullscreen,
    editorCommand: command === undefined || command.length === 0 ? null : command,
    vimMode: config.editor?.vim_mode ?? DEFAULT_TUI_CONFIG.vimMode,
    notifications: {
      enabled: config.notifications?.enabled ?? DEFAULT_NOTIFICATIONS_CONFIG.enabled,
      condition:
        config.notifications?.notification_condition ?? DEFAULT_NOTIFICATIONS_CONFIG.condition,
    },
    upgrade: {
      autoInstall: config.upgrade?.auto_install ?? DEFAULT_UPGRADE_PREFERENCES.autoInstall,
    },
    statusLine: {
      items: statusLineItems,
      command:
        statusLineCommand === undefined || statusLineCommand.length === 0
          ? null
          : statusLineCommand,
    },
  });
}

export function renderTuiConfig(config: TuiConfig): string {
  // An active status_line must round-trip: any preference save rewrites the
  // whole file, so the section is emitted live when set and left as a
  // commented-out guide when unset.
  const statusItems = config.statusLine?.items;
  const statusCommand = config.statusLine?.command;
  const statusLines: string[] = [];
  if (statusItems !== null && statusItems !== undefined) {
    statusLines.push(`items = ${JSON.stringify(statusItems)}`);
  }
  if (statusCommand) {
    statusLines.push(`command = "${escapeTomlBasicString(statusCommand)}"`);
  }
  const statusSection =
    statusLines.length > 0
      ? `[status_line]\n${statusLines.join('\n')}\n`
      : `# [status_line]
# Pick and order the built-in footer slots: ${STATUS_LINE_ITEMS.join(', ')}
# items = ${JSON.stringify([...STATUS_LINE_ITEMS])}
# Or render your own: a command whose first stdout line replaces footer line 1.
# It receives a JSON snapshot (model, cwd, git, usage, mode) on stdin.
# command = "~/.cloud-code/statusline.sh"
`;
  return `# ~/.cloud-code/tui.toml
# Client preferences for Cloud Code CLI.
# Agent/runtime settings stay in ~/.cloud-code/config.toml.

theme = "${escapeTomlBasicString(config.theme)}" # "auto" | "dark" | "light" | custom theme name
language = "${config.language}" # "auto" | "en" | "zh-CN"
disable_paste_burst = ${String(config.disablePasteBurst)} # true disables non-bracketed paste-burst fallback
fullscreen = ${String(config.fullscreen)} # true = alternate-screen TUI with pinned input/status; false = classic inline scrollback

[editor]
command = "${escapeTomlBasicString(config.editorCommand ?? '')}" # Empty uses $VISUAL / $EDITOR
vim_mode = ${String(config.vimMode)} # true enables vim modal editing (NORMAL/INSERT) in the prompt editor

[notifications]
enabled = ${String(config.notifications.enabled)} # true | false
notification_condition = "${config.notifications.condition}" # "unfocused" | "always"

[upgrade]
auto_install = ${String(config.upgrade.autoInstall)} # true | false

${statusSection}`;
}

function escapeTomlBasicString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\b', '\\b')
    .replaceAll('\t', '\\t')
    .replaceAll('\n', '\\n')
    .replaceAll('\f', '\\f')
    .replaceAll('\r', '\\r');
}

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'pathe';

import type { AutocompleteItem } from '@cloud-code/pi-tui';

import { completeLeadingArg, type ArgCompletionSpec } from './complete-args';
import type { CloudCodeSlashCommand, SlashCommandAvailability } from './types';

/**
 * Builtin command `description` fields (and argument-completion
 * descriptions) hold i18n *keys* (`commands.<name>.description`), not
 * display text — the constants are module-level but the locale is a runtime
 * singleton. Consumers resolve them through `resolveDescription()`
 * (setupAutocomplete, showHelpPanel, argument completion); plugin/skill
 * commands carry plain text, which passes through unchanged.
 */

/** Subcommands offered when autocompleting `/goal <…>`. */
const GOAL_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'status', description: 'commands.goal.arg.status' },
  { value: 'pause', description: 'commands.goal.arg.pause' },
  { value: 'resume', description: 'commands.goal.arg.resume' },
  { value: 'cancel', description: 'commands.goal.arg.cancel' },
  { value: 'replace', description: 'commands.goal.arg.replace' },
  { value: 'next', description: 'commands.goal.arg.next' },
];

const GOAL_NEXT_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'manage', description: 'commands.goal.arg.nextManage' },
];

const SWARM_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'on', description: 'commands.swarm.arg.on' },
  { value: 'off', description: 'commands.swarm.arg.off' },
];

const COORDINATOR_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'on', description: 'commands.coordinator.arg.on' },
  { value: 'off', description: 'commands.coordinator.arg.off' },
];

const IMPORT_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'claude', description: 'commands.import.arg.claude' },
  { value: 'codex', description: 'commands.import.arg.codex' },
  { value: 'kimi', description: 'commands.import.arg.kimi' },
];

const ADD_DIR_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'list', description: 'commands.add-dir.arg.list' },
];

const UPDATE_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'check', description: 'commands.update.arg.check' },
  { value: 'apply', description: 'commands.update.arg.apply' },
];

/** Argument autocompletion for the `/goal` command (subcommands). */
export function goalArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const nextMatch = argumentPrefix.match(/^next\s+(\S*)$/i);
  if (nextMatch !== null) {
    return (
      completeLeadingArg(GOAL_NEXT_ARG_COMPLETIONS, nextMatch[1] ?? '')?.map((item) => ({
        ...item,
        value: `next ${item.value}`,
      })) ?? null
    );
  }
  return completeLeadingArg(GOAL_ARG_COMPLETIONS, argumentPrefix);
}

/** Argument autocompletion for the `/swarm` command (subcommands). */
export function swarmArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return completeLeadingArg(SWARM_ARG_COMPLETIONS, argumentPrefix);
}

/** Argument autocompletion for the `/coordinator` command (subcommands). */
export function coordinatorArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return completeLeadingArg(COORDINATOR_ARG_COMPLETIONS, argumentPrefix);
}

/** Argument autocompletion for the `/import` command (import sources). */
export function importArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return completeLeadingArg(IMPORT_ARG_COMPLETIONS, argumentPrefix);
}

/** Argument autocompletion for the `/add-dir` command. */
export function addDirArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  if (isPathLikeAddDirArgument(argumentPrefix)) {
    return completeAddDirPath(argumentPrefix);
  }
  return completeLeadingArg(ADD_DIR_ARG_COMPLETIONS, argumentPrefix);
}

/** Argument autocompletion for the `/update` command (subcommands). */
export function updateArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return completeLeadingArg(UPDATE_ARG_COMPLETIONS, argumentPrefix);
}

function isPathLikeAddDirArgument(argumentPrefix: string): boolean {
  return argumentPrefix === '.' || argumentPrefix === '..' || argumentPrefix.startsWith('./') || argumentPrefix.startsWith('../') || argumentPrefix.startsWith('/') || argumentPrefix.startsWith('~');
}

function completeAddDirPath(argumentPrefix: string): AutocompleteItem[] | null {
  const normalizedPrefix = argumentPrefix === '~' ? '~/' : argumentPrefix;
  const expandedPrefix = expandHomePrefix(normalizedPrefix);
  const parentInput = getDirectoryCompletionParentInput(normalizedPrefix, expandedPrefix);
  const partialName = normalizedPrefix.endsWith('/') ? '' : basename(expandedPrefix);
  const parentDir = resolveDirectoryCompletionParent(parentInput);
  let entries;
  try {
    entries = readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const items: AutocompleteItem[] = [];
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..' || entry.name.startsWith('.')) continue;
    if (partialName.length > 0 && !entry.name.toLowerCase().startsWith(partialName.toLowerCase())) continue;
    const absolutePath = join(parentDir, entry.name);
    if (!isDirectoryPath(absolutePath, entry.isDirectory(), entry.isSymbolicLink())) continue;
    const value = formatDirectoryCompletionValue(normalizedPrefix, parentInput, entry.name);
    items.push({
      value,
      label: `${entry.name}/`,
      description: absolutePath,
    });
  }

  return items.length > 0 ? items : null;
}

function expandHomePrefix(argumentPrefix: string): string {
  if (argumentPrefix === '~') return homedir();
  if (argumentPrefix.startsWith('~/')) return join(homedir(), argumentPrefix.slice(2));
  return argumentPrefix;
}

function getDirectoryCompletionParentInput(argumentPrefix: string, expandedPrefix: string): string {
  if (argumentPrefix === '/') return '/';
  if (argumentPrefix === '~/') return homedir();
  if (argumentPrefix.endsWith('/')) return expandedPrefix.slice(0, -1);
  return dirname(expandedPrefix);
}

function resolveDirectoryCompletionParent(parentInput: string): string {
  if (parentInput === '~') return homedir();
  if (parentInput.startsWith('~/')) return join(homedir(), parentInput.slice(2));
  return resolve(parentInput);
}

function isDirectoryPath(path: string, isDirectory: boolean, isSymlink: boolean): boolean {
  if (isDirectory) return true;
  if (!isSymlink) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function formatDirectoryCompletionValue(argumentPrefix: string, parentInput: string, entryName: string): string {
  if (argumentPrefix.startsWith('~/')) {
    const home = homedir();
    const homeRelative = relative(home, parentInput);
    return `~${homeRelative.length > 0 ? `/${homeRelative}` : ''}/${entryName}/`;
  }
  if (argumentPrefix.startsWith('/')) {
    return `${join(parentInput, entryName)}/`;
  }
  return `${join(parentInput, entryName)}/`;
}

export const BUILTIN_SLASH_COMMANDS = [
  {
    name: 'yolo',
    aliases: ['yes'],
    description: 'commands.yolo.description',
    priority: 101,
    availability: 'always',
  },
  {
    name: 'auto',
    aliases: [],
    description: 'commands.auto.description',
    priority: 99,
    availability: 'always',
  },
  {
    name: 'permission',
    aliases: [],
    description: 'commands.permission.description',
    priority: 100,
    availability: 'always',
  },
  {
    name: 'settings',
    aliases: ['config'],
    description: 'commands.settings.description',
    priority: 100,
    availability: 'always',
  },
  {
    name: 'plan',
    aliases: [],
    description: 'commands.plan.description',
    priority: 100,
    availability: (args) => (args.trim().toLowerCase() === 'clear' ? 'idle-only' : 'always'),
  },
  {
    name: 'swarm',
    aliases: [],
    description: 'commands.swarm.description',
    priority: 100,
    argumentHint: 'commands.swarm.argumentHint',
    completeArgs: swarmArgumentCompletions,
    availability: 'idle-only',
  },
  {
    name: 'coordinator',
    aliases: [],
    description: 'commands.coordinator.description',
    priority: 100,
    argumentHint: '[on|off]',
    completeArgs: coordinatorArgumentCompletions,
    availability: 'idle-only',
  },
  {
    name: 'model',
    aliases: [],
    description: 'commands.model.description',
    priority: 100,
    argumentHint: 'commands.model.argumentHint',
    availability: 'always',
  },
  {
    name: 'secondary_model',
    aliases: [],
    description: 'commands.secondaryModel.description',
    priority: 90,
    availability: 'always',
    argumentHint: 'commands.secondaryModel.argumentHint',
  },
  {
    name: 'effort',
    aliases: ['thinking'],
    description: 'commands.effort.description',
    priority: 95,
    availability: 'always',
  },
  {
    name: 'fast',
    aliases: [],
    description: 'commands.fast.description',
    priority: 95,
    availability: 'always',
  },
  {
    name: 'provider',
    aliases: ['providers'],
    description: 'commands.provider.description',
    priority: 95,
    availability: 'always',
  },
  {
    name: 'btw',
    aliases: [],
    description: 'commands.btw.description',
    priority: 90,
    availability: 'always',
  },
  {
    name: 'help',
    aliases: ['h', '?'],
    description: 'commands.help.description',
    priority: 80,
    availability: 'always',
  },
  {
    name: 'new',
    aliases: ['clear'],
    description: 'commands.new.description',
    priority: 80,
  },
  {
    name: 'sessions',
    aliases: ['resume'],
    description: 'commands.sessions.description',
    priority: 80,
  },
  {
    name: 'tasks',
    aliases: ['task'],
    description: 'commands.tasks.description',
    priority: 80,
    availability: 'always',
  },
  {
    name: 'workflows',
    aliases: ['wf'],
    description: 'workflows.command.description',
    priority: 80,
    availability: 'always',
  },
  {
    name: 'teams',
    aliases: ['team'],
    description: 'teams.command.description',
    priority: 80,
    availability: 'always',
  },
  {
    name: 'mcp',
    aliases: [],
    description: 'commands.mcp.description',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'sandbox',
    aliases: [],
    description: 'commands.sandbox.description',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'plugins',
    aliases: [],
    description: 'commands.plugins.description',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'import',
    // Legacy skill entry point; the builtin shadows the same-named skill,
    // which stays reachable as `/skill:import-from-cc-codex`.
    aliases: ['import-from-cc-codex'],
    description: 'commands.import.description',
    priority: 60,
    availability: 'idle-only',
    argumentHint: '[claude|codex|kimi]',
    completeArgs: importArgumentCompletions,
  },
  {
    name: 'add-dir',
    aliases: [],
    description: 'commands.add-dir.description',
    priority: 60,
    availability: 'idle-only',
    argumentHint: 'commands.add-dir.argumentHint',
    completeArgs: addDirArgumentCompletions,
  },
  {
    name: 'experiments',
    aliases: ['experimental'],
    description: 'commands.experiments.description',
    priority: 60,
    availability: 'idle-only',
  },
  {
    name: 'reload',
    aliases: [],
    description: 'commands.reload.description',
    priority: 60,
    availability: 'idle-only',
  },
  {
    name: 'reload-tui',
    aliases: [],
    description: 'commands.reload-tui.description',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'compact',
    aliases: [],
    description: 'commands.compact.description',
    priority: 80,
    argumentHint: 'commands.compact.argumentHint',
  },
  {
    name: 'goal',
    aliases: [],
    description: 'commands.goal.description',
    priority: 80,
    argumentHint: 'commands.goal.argumentHint',
    completeArgs: goalArgumentCompletions,
    // status / pause / cancel are always available; creation, replacement, and
    // resume start (or restart) a turn and so are idle-only.
    availability: (args) => {
      const trimmed = args.trim();
      if (trimmed === 'next' || trimmed.startsWith('next ')) return 'always';
      return trimmed === '' || trimmed === 'status' || trimmed === 'pause' || trimmed === 'cancel'
        ? 'always'
        : 'idle-only';
    },
  },
  {
    name: 'init',
    aliases: [],
    description: 'commands.init.description',
  },
  {
    name: 'fork',
    aliases: [],
    description: 'commands.fork.description',
    priority: 80,
  },
  {
    name: 'title',
    aliases: ['rename'],
    description: 'commands.title.description',
    priority: 60,
    argumentHint: 'commands.title.argumentHint',
    availability: 'always',
  },
  {
    name: 'usage',
    aliases: [],
    description: 'commands.usage.description',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'status',
    aliases: [],
    description: 'commands.status.description',
    priority: 60,
    availability: 'always',
    argumentHint: '[status|usage|stats]',
  },
  {
    name: 'feedback',
    aliases: [],
    description: 'commands.feedback.description',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'undo',
    aliases: [],
    description: 'commands.undo.description',
    priority: 80,
    availability: 'idle-only',
  },
  {
    name: 'rewind',
    aliases: [],
    description: 'commands.rewind.description',
    priority: 80,
    availability: 'idle-only',
  },
  {
    name: 'editor',
    aliases: [],
    description: 'commands.editor.description',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'vim',
    aliases: [],
    description: 'commands.vim.description',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'theme',
    aliases: [],
    description: 'commands.theme.description',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'language',
    aliases: ['lang'],
    description: 'commands.language.description',
    priority: 60,
    availability: 'always',
    argumentHint: '[en|zh-CN|auto]',
  },
  {
    name: 'output-style',
    aliases: ['style'],
    description: 'commands.outputStyle.description',
    priority: 60,
    availability: 'always',
    argumentHint: 'commands.outputStyle.argumentHint',
  },
  {
    name: 'logout',
    aliases: ['disconnect'],
    description: 'commands.logout.description',
    priority: 40,
  },
  {
    name: 'login',
    aliases: [],
    description: 'commands.login.description',
    priority: 40,
  },
  {
    name: 'export-md',
    aliases: ['export'],
    description: 'commands.export-md.description',
    priority: 40,
  },
  {
    name: 'export-debug-zip',
    aliases: [],
    description: 'commands.export-debug-zip.description',
    priority: 40,
  },
  {
    name: 'copy',
    aliases: [],
    description: 'commands.copy.description',
    priority: 40,
  },
  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'commands.exit.description',
    priority: 20,
  },
  {
    name: 'version',
    aliases: [],
    description: 'commands.version.description',
    priority: 20,
    availability: 'always',
  },
  {
    // Binary-channel update check/apply; deliberately no 'upgrade' alias —
    // that name belongs to the npm-channel `cloud-code upgrade` CLI subcommand.
    name: 'update',
    aliases: [],
    description: 'commands.update.description',
    priority: 60,
    availability: 'always',
    argumentHint: 'commands.update.argumentHint',
    completeArgs: updateArgumentCompletions,
  },
] as const satisfies readonly CloudCodeSlashCommand[];

export type BuiltinSlashCommand = (typeof BUILTIN_SLASH_COMMANDS)[number];
export type BuiltinSlashCommandName = BuiltinSlashCommand['name'];

export function findBuiltInSlashCommand(commandName: string): BuiltinSlashCommand | undefined {
  const commands = BUILTIN_SLASH_COMMANDS as readonly CloudCodeSlashCommand<BuiltinSlashCommandName>[];
  return commands.find(
    (command) => command.name === commandName || command.aliases.includes(commandName),
  ) as BuiltinSlashCommand | undefined;
}

export function resolveSlashCommandAvailability(
  command: CloudCodeSlashCommand,
  args: string,
): SlashCommandAvailability {
  const availability = command.availability ?? 'idle-only';
  return typeof availability === 'function' ? availability(args) : availability;
}

export function sortSlashCommands(commands: readonly CloudCodeSlashCommand[]): CloudCodeSlashCommand[] {
  return [...commands].toSorted(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name),
  );
}

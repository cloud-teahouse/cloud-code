/**
 * Output styles (Claude Code parity): a user-selectable, pluggable
 * REPLACEMENT for the "style surface" of the system prompt. A style is a
 * markdown file whose body supplies new content for one or two replaceable
 * prompt sections; the selection applies at prompt assembly
 * (`SystemPromptAssembly.assemble`), replacing section content — never
 * appending.
 *
 * The replaceable boundary is deliberately narrow. Only the two sections that
 * govern how the agent talks about its work are style-replaceable:
 * - `communicating-with-user` — tone, verbosity, reply format;
 * - `delivering-work` — task-completion and reporting discipline.
 * Everything else is protected: `identity`, `prompt-and-tool-use`,
 * `guidelines-coding` (which carries the security policy), `context-management`,
 * every runtime-derived section, and `ultimate-reminders` can never be
 * rewritten by a style, no matter what a style file contains. A style file
 * therefore cannot weaken permissions, security rules, or tool discipline.
 *
 * File format (compatible with Claude Code's `.claude/output-styles/*.md`):
 * frontmatter `name` / `description`; `keep-coding-instructions` is accepted
 * and ignored — the boundary above already preserves every coding instruction,
 * so the flag has no meaning here. The body replaces
 * `communicating-with-user`; a line exactly `# Delivering work` splits off the
 * remainder as the `delivering-work` replacement, and a leading
 * `# Communicating with the user` heading line is dropped. Any other heading
 * is ordinary body text.
 *
 * Sources, in rising precedence (later sources win a name collision, matching
 * CC's built-in < plugin < user < project order):
 * - builtin: `default/output-styles/*.md` bundled with the binary, plus the
 *   reserved `default` style (no replacement — the stock prompt);
 * - plugin: `outputStyles/` directories of enabled plugins;
 * - user: `<brandHome>/output-styles/*.md` (CLOUD_CODE_HOME-aware);
 * - project: `<workspace>/.cloud-code/output-styles/*.md`.
 * The name `default` is reserved: style files may not redefine it.
 * Builtin order is picker order: the loader keeps first-seen order, so new
 * builtins append at the end of `BUILTIN_OUTPUT_STYLES` (after `explanatory`).
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'pathe';

import { parseFrontmatter } from '../skill/parser';

import conciseMd from './default/output-styles/concise.md?raw';
import explanatoryMd from './default/output-styles/explanatory.md?raw';
import reviewerMd from './default/output-styles/reviewer.md?raw';
import debuggerMd from './default/output-styles/debugger.md?raw';
import teacherMd from './default/output-styles/teacher.md?raw';

export const DEFAULT_OUTPUT_STYLE_NAME = 'default';

export type OutputStyleSource = 'builtin' | 'plugin' | 'user' | 'project';

/** Section ids a style may replace — see the module header for the boundary. */
export const REPLACEABLE_SECTION_IDS = ['communicating-with-user', 'delivering-work'] as const;
export type ReplaceableSectionId = (typeof REPLACEABLE_SECTION_IDS)[number];

const REPLACEABLE_SECTION_ID_SET: ReadonlySet<string> = new Set(REPLACEABLE_SECTION_IDS);

/** The heading lines that steer a style body into its target sections. */
const SECTION_HEADING_LINES: Readonly<Record<string, ReplaceableSectionId>> = {
  '# Communicating with the user': 'communicating-with-user',
  '# Delivering work': 'delivering-work',
};

export function isReplaceableSectionId(id: string): id is ReplaceableSectionId {
  return REPLACEABLE_SECTION_ID_SET.has(id);
}

export interface OutputStyleDefinition {
  readonly name: string;
  readonly description: string;
  readonly source: OutputStyleSource;
  /** Owning plugin id when `source === 'plugin'`. */
  readonly plugin?: string;
  /** Replacement bodies keyed by target section; only replaceable ids appear. */
  readonly replacements: Readonly<Partial<Record<ReplaceableSectionId, string>>>;
}

/** Host-facing view of a style, listed by `Session.listOutputStyles`. */
export interface OutputStyleSummary {
  readonly name: string;
  readonly description: string;
  readonly source: OutputStyleSource;
}

export function summarizeOutputStyle(style: OutputStyleDefinition): OutputStyleSummary {
  return { name: style.name, description: style.description, source: style.source };
}

export interface ParseOutputStyleOptions {
  /** Used when the frontmatter has no `name`; typically the file basename. */
  readonly fallbackName: string;
  readonly source: OutputStyleSource;
  readonly plugin?: string;
}

/**
 * Parse one style file. Returns undefined when the file defines nothing
 * usable (blank body). Throws `FrontmatterError` on malformed frontmatter;
 * callers loading whole dirs demote that to a warning and skip the file.
 */
export function parseOutputStyleText(
  text: string,
  options: ParseOutputStyleOptions,
): OutputStyleDefinition | undefined {
  const { data, body } = parseFrontmatter(text);
  const metadata =
    typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const rawName = metadata['name'];
  const name =
    typeof rawName === 'string' && rawName.trim().length > 0
      ? rawName.trim()
      : options.fallbackName;
  const rawDescription = metadata['description'];
  const description = typeof rawDescription === 'string' ? rawDescription.trim() : '';

  const chunks: Partial<Record<ReplaceableSectionId, string[]>> = {};
  let target: ReplaceableSectionId = 'communicating-with-user';
  for (const line of body.split('\n')) {
    const headingTarget = SECTION_HEADING_LINES[line.trimEnd()];
    if (headingTarget !== undefined) {
      // The `delivering-work` heading redirects the remainder; the leading
      // `communicating-with-user` heading is decorative and simply dropped.
      target = headingTarget;
      continue;
    }
    (chunks[target] ??= []).push(line);
  }

  const replacements: Partial<Record<ReplaceableSectionId, string>> = {};
  for (const id of REPLACEABLE_SECTION_IDS) {
    const chunk = chunks[id]?.join('\n').trim();
    if (chunk !== undefined && chunk.length > 0) {
      replacements[id] = chunk;
    }
  }
  if (Object.keys(replacements).length === 0) return undefined;
  return {
    name,
    description,
    source: options.source,
    ...(options.plugin !== undefined ? { plugin: options.plugin } : {}),
    replacements,
  };
}

/**
 * The bundled styles, parsed from the same markdown format users write.
 * `default` is not a definition: it means "no replacement" and is handled by
 * {@link resolveOutputStyle} returning undefined.
 */
export const BUILTIN_OUTPUT_STYLES: readonly OutputStyleDefinition[] = [
  { source: conciseMd, fallbackName: 'concise' },
  { source: explanatoryMd, fallbackName: 'explanatory' },
  { source: reviewerMd, fallbackName: 'reviewer' },
  { source: debuggerMd, fallbackName: 'debugger' },
  { source: teacherMd, fallbackName: 'teacher' },
].map(
  ({ source, fallbackName }) =>
    // Bundled files are author-controlled; an unparseable one must fail loudly.
    parseOutputStyleText(source, { fallbackName, source: 'builtin' })!,
);

/**
 * Resolve the active style by name. `undefined`, blank, `default`, and
 * unknown names all resolve to undefined — the stock prompt, no replacement.
 */
export function resolveOutputStyle(
  styles: readonly OutputStyleDefinition[],
  name: string | undefined,
): OutputStyleDefinition | undefined {
  const normalized = normalizeOutputStyleName(name);
  if (normalized === undefined) return undefined;
  return styles.find((style) => style.name === normalized);
}

/**
 * The canonical form of a configured style name: blank and `default` both
 * mean "no style" and normalize to undefined; anything else is trimmed.
 */
export function normalizeOutputStyleName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const trimmed = name.trim();
  return trimmed.length === 0 || trimmed === DEFAULT_OUTPUT_STYLE_NAME ? undefined : trimmed;
}

export interface PluginOutputStyleDirInput {
  /** Owning plugin id, recorded on every style the dir contributes. */
  readonly pluginId: string;
  /** Absolute path of the plugin's output-styles directory. */
  readonly path: string;
}

export interface LoadOutputStylesOptions {
  /** User-level dir (`<brandHome>/output-styles`, CLOUD_CODE_HOME-aware). */
  readonly userDir?: string | undefined;
  /** Project-level dir (`<workspace>/.cloud-code/output-styles`). */
  readonly projectDir?: string | undefined;
  /** Plugin-provided style dirs (`PluginManager.pluginOutputStyleDirs()`). */
  readonly pluginDirs?: readonly PluginOutputStyleDirInput[];
  /** Per-file problems are demoted to warnings so one bad file never blocks. */
  readonly onWarning?: ((message: string) => void) | undefined;
}

/**
 * Discover all styles visible to a session: builtins plus every dir source,
 * later sources overriding earlier ones by style name. The returned list
 * keeps first-seen order (an override replaces content, not position).
 */
export async function loadOutputStyles(
  options: LoadOutputStylesOptions,
): Promise<readonly OutputStyleDefinition[]> {
  const byName = new Map<string, OutputStyleDefinition>();
  for (const style of BUILTIN_OUTPUT_STYLES) {
    byName.set(style.name, style);
  }

  const warn = (message: string) => options.onWarning?.(message);
  const loadDir = async (
    dir: string,
    source: Exclude<OutputStyleSource, 'builtin'>,
    pluginId?: string,
  ): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return; // A missing dir is the common case, not a warning.
    }
    for (const entry of entries.toSorted((a, b) => a.localeCompare(b))) {
      if (!entry.endsWith('.md')) continue;
      const filePath = join(dir, entry);
      let style: OutputStyleDefinition | undefined;
      try {
        const text = await readFile(filePath, 'utf8');
        style = parseOutputStyleText(text, {
          fallbackName: entry.slice(0, -'.md'.length),
          source,
          ...(pluginId !== undefined ? { plugin: pluginId } : {}),
        });
      } catch (error) {
        warn(`Skipping output style ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (style === undefined) {
        warn(`Skipping output style ${filePath}: no replacement content`);
        continue;
      }
      if (style.name === DEFAULT_OUTPUT_STYLE_NAME) {
        warn(`Skipping output style ${filePath}: "${DEFAULT_OUTPUT_STYLE_NAME}" is reserved`);
        continue;
      }
      byName.set(style.name, style);
    }
  };

  for (const dir of options.pluginDirs ?? []) {
    await loadDir(dir.path, 'plugin', dir.pluginId);
  }
  if (options.userDir !== undefined) await loadDir(options.userDir, 'user');
  if (options.projectDir !== undefined) await loadDir(options.projectDir, 'project');
  return [...byName.values()];
}

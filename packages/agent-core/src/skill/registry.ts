import path from 'pathe';

import ignore from 'ignore';

import { expandSkillParameters, skillArgumentNames } from './parser';
import { discoverSkills, type DiscoverSkillsOptions } from './scanner';
import type { SkillDefinition, SkillRoot, SkillSource, SkippedSkill } from './types';
import { isInlineSkillType, normalizeSkillName } from './types';
import type { SkillRegistry as AgentSkillRegistry } from '../agent/skill/types';
import { escapeXmlAttr } from '../utils/xml-escape';

const LISTING_DESC_MAX = 250;

export class SkillNotFoundError extends Error {
  readonly skillName: string;

  constructor(skillName: string) {
    super(`Skill "${skillName}" is not registered`);
    this.name = 'SkillNotFoundError';
    this.skillName = skillName;
  }
}

export interface SkillRegistryOptions {
  readonly discover?: typeof discoverSkills;
  readonly onWarning?: (message: string, cause?: unknown) => void;
  readonly sessionId?: string;
}

export class SessionSkillRegistry implements AgentSkillRegistry {
  private readonly byName = new Map<string, SkillDefinition>();
  private readonly byPluginAndName = new Map<string, SkillDefinition>();
  /**
   * Conditional (`paths` frontmatter) skills not yet activated: kept out of
   * every listing and lookup so the model cannot see or invoke them.
   */
  private readonly pendingConditional = new Map<string, SkillDefinition>();
  /**
   * Conditional skills activated by touched paths this session. Lookup goes
   * through here (the model may invoke them), but they deliberately stay out
   * of `byName` so `listSkills()`/`getModelSkillListing()` — and therefore the
   * system-prompt prefix — do not change mid-session. Activation is announced
   * at the message-stream tail instead (see agent/injection/skill-activation).
   */
  private readonly activatedConditional = new Map<string, SkillDefinition>();
  private readonly roots: string[] = [];
  private readonly skipped: SkippedSkill[] = [];
  private readonly discoverImpl: typeof discoverSkills;
  private readonly onWarning: (message: string, cause?: unknown) => void;
  readonly sessionId?: string;

  constructor(options: SkillRegistryOptions = {}) {
    this.discoverImpl = options.discover ?? discoverSkills;
    this.onWarning = options.onWarning ?? (() => {});
    this.sessionId = options.sessionId;
  }

  async loadRoots(roots: readonly SkillRoot[]): Promise<void> {
    for (const root of roots) {
      if (!this.roots.includes(root.path)) this.roots.push(root.path);
    }

    const skills = await this.discoverImpl({
      roots,
      onWarning: this.onWarning,
      onSkippedByPolicy: (skill) => this.skipped.push(skill),
      onDiscoveredSkill: (skill) => {
        this.indexPluginSkill(skill);
      },
    } satisfies DiscoverSkillsOptions);

    for (const skill of skills) {
      this.index(skill);
    }
  }

  registerBuiltinSkill(skill: SkillDefinition): void {
    this.register(skill.source === 'builtin' ? skill : { ...skill, source: 'builtin' });
  }

  register(skill: SkillDefinition, options: { readonly replace?: boolean } = {}): void {
    const key = normalizeSkillName(skill.name);
    if (this.isConditional(skill)) {
      if (options.replace === true || !this.pendingConditional.has(key)) {
        this.pendingConditional.set(key, skill);
      }
      return;
    }
    if (options.replace === true || !this.byName.has(key)) {
      this.byName.set(key, skill);
    }
    this.indexPluginSkill(skill, options);
  }

  private index(skill: SkillDefinition): void {
    const key = normalizeSkillName(skill.name);
    if (this.isConditional(skill)) {
      this.pendingConditional.set(key, skill);
      return;
    }
    this.byName.set(key, skill);
  }

  /**
   * A skill is conditional when it declares `paths` frontmatter on an inline
   * type. `paths` on a non-inline type (flow/reference) is inert — the skill
   * loads normally and a warning tells the author the gate does not apply.
   */
  private isConditional(skill: SkillDefinition): boolean {
    const paths = skill.metadata.paths;
    if (paths === undefined || paths.length === 0) return false;
    if (!isInlineSkillType(skill.metadata.type)) {
      this.onWarning(
        `Skill "${skill.name}" declares "paths" but type "${skill.metadata.type ?? ''}" is not inline; the paths gate is ignored.`,
      );
      return false;
    }
    return true;
  }

  getSkill(name: string): SkillDefinition | undefined {
    const key = normalizeSkillName(name);
    return this.byName.get(key) ?? this.activatedConditional.get(key);
  }

  getPluginSkill(pluginId: string, name: string): SkillDefinition | undefined {
    return this.byPluginAndName.get(pluginSkillKey(pluginId, name));
  }

  hasPendingConditionalSkills(): boolean {
    return this.pendingConditional.size > 0;
  }

  listActivatedConditionalSkills(): readonly SkillDefinition[] {
    return [...this.activatedConditional.values()].toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /**
   * Activate pending conditional skills whose `paths` patterns match any of
   * the touched file paths. Matching is gitignore-style (the `ignore`
   * package), paths are matched relative to `cwd`; absolute paths outside
   * `cwd` can never match, mirroring Claude Code's
   * `activateConditionalSkillsForPaths`. Returns the newly activated skills,
   * sorted by name for byte-stable announcements.
   */
  activateSkillsForPaths(
    paths: readonly string[],
    cwd: string,
  ): readonly SkillDefinition[] {
    if (this.pendingConditional.size === 0 || paths.length === 0) return [];
    const activated: SkillDefinition[] = [];
    for (const [key, skill] of this.pendingConditional) {
      const patterns = skill.metadata.paths;
      if (patterns === undefined || patterns.length === 0) continue;
      let matcher: ReturnType<typeof ignore>;
      try {
        matcher = ignore().add([...patterns]);
      } catch (error) {
        this.onWarning(`Skill "${skill.name}" has invalid "paths" patterns; skipping it`, error);
        continue;
      }
      for (const touched of paths) {
        const relativePath = path.isAbsolute(touched) ? path.relative(cwd, touched) : touched;
        // ignore() throws on empty strings, paths escaping the base (../),
        // and absolute leftovers; files outside cwd cannot match cwd-relative
        // patterns anyway.
        if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
          continue;
        }
        if (matcher.ignores(relativePath)) {
          this.pendingConditional.delete(key);
          this.activatedConditional.set(key, skill);
          this.indexPluginSkill(skill);
          activated.push(skill);
          break;
        }
      }
    }
    return activated.toSorted((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Re-activate one pending conditional skill by name without a path match.
   * Used on resume: the rebuilt registry starts every conditional skill as
   * pending, while the replayed history still carries earlier activation
   * announcements — the ledger in the history wins (same philosophy as the
   * loadable-tools announcements) so the model never sees an announcement for
   * a skill the registry would refuse to invoke.
   */
  activatePendingConditionalSkill(name: string): SkillDefinition | undefined {
    const key = normalizeSkillName(name);
    const skill = this.pendingConditional.get(key);
    if (skill === undefined) return undefined;
    this.pendingConditional.delete(key);
    this.activatedConditional.set(key, skill);
    this.indexPluginSkill(skill);
    return skill;
  }

  private indexPluginSkill(
    skill: SkillDefinition,
    options: { readonly replace?: boolean } = {},
  ): void {
    if (skill.plugin === undefined) return;
    const key = pluginSkillKey(skill.plugin.id, skill.name);
    if (options.replace === true || !this.byPluginAndName.has(key)) {
      this.byPluginAndName.set(key, skill);
    }
  }

  renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string {
    const argumentNames = skillArgumentNames(skill.metadata);
    const content = expandSkillParameters(skill.content, rawArgs, {
      skillDir: skill.dir,
      sessionId: this.sessionId,
      argumentNames,
    });
    const plugin = skill.plugin;
    if (plugin === undefined) return content;
    const instructions = plugin.instructions;
    if (instructions === undefined || instructions.trim().length === 0) return content;
    return (
      `<kimi-plugin-instructions plugin="${escapeXmlAttr(plugin.id)}">\n` +
      `${instructions}\n` +
      `</kimi-plugin-instructions>\n\n${content}`
    );
  }

  listSkills(): readonly SkillDefinition[] {
    return [...this.byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  listInvocableSkills(): readonly SkillDefinition[] {
    return this.listSkills().filter(
      (skill) =>
        skill.metadata.disableModelInvocation !== true && isInlineSkillType(skill.metadata.type),
    );
  }

  getSkillRoots(): readonly string[] {
    return [...this.roots];
  }

  getSkippedByPolicy(): readonly SkippedSkill[] {
    return [...this.skipped];
  }

  getCloudCodeSkillsDescription(): string {
    const rendered = renderGroupedSkills(this.listSkills(), formatFullSkill);
    return rendered.length === 0 ? 'No skills' : rendered;
  }

  getModelSkillListing(): string {
    const lines = ['DISREGARD any earlier skill listings. Current available skills:'];
    const listing = renderGroupedSkills(
      this.listInvocableSkills().filter((skill) => skill.metadata.isSubSkill !== true),
      formatModelSkill,
    );
    if (listing.length > 0) {
      lines.push(listing);
    }
    return lines.length === 1 ? '' : lines.join('\n');
  }
}

function pluginSkillKey(pluginId: string, skillName: string): string {
  return `${pluginId}\0${normalizeSkillName(skillName)}`;
}

const SOURCE_GROUPS: ReadonlyArray<{ readonly source: SkillSource; readonly label: string }> = [
  { source: 'project', label: 'Project' },
  { source: 'user', label: 'User' },
  { source: 'extra', label: 'Extra' },
  { source: 'builtin', label: 'Built-in' },
];

function renderGroupedSkills(
  skills: readonly SkillDefinition[],
  format: (skill: SkillDefinition) => readonly string[],
): string {
  const lines: string[] = [];
  for (const group of SOURCE_GROUPS) {
    const groupSkills = skills.filter((skill) => skill.source === group.source);
    if (groupSkills.length === 0) continue;
    lines.push(`### ${group.label}`);
    for (const skill of groupSkills) {
      lines.push(...format(skill));
    }
  }
  return lines.join('\n');
}

function formatFullSkill(skill: SkillDefinition): readonly string[] {
  return [`- ${skill.name}`, `  - Path: ${skill.path}`, `  - Description: ${skill.description}`];
}

function formatModelSkill(skill: SkillDefinition): readonly string[] {
  const lines = [`- ${skill.name}: ${truncate(skill.description, LISTING_DESC_MAX)}`];
  if (typeof skill.metadata.whenToUse === 'string' && skill.metadata.whenToUse.length > 0) {
    lines.push(`  When to use: ${skill.metadata.whenToUse}`);
  }
  lines.push(`  Path: ${skill.path}`);
  return lines;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  // Reserve one code unit for the trailing ellipsis and walk whole grapheme
  // clusters so we never split a surrogate pair or combining sequence.
  let length = 0;
  let result = '';
  for (const { segment } of graphemeSegmenter.segment(value)) {
    if (length + segment.length > max - 1) break;
    result += segment;
    length += segment.length;
  }
  return `${result}…`;
}

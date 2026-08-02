/**
 * SkillActivationInjector — announces `paths`-gated skill activations in
 * context and keeps the announcement ledger self-healing.
 *
 * Mirrors the ToolsDiffInjector contract (see tools-diff.ts), adapted for the
 * one-way nature of skill activation:
 *   - Announcements are `<skills_activated>` system reminders with a
 *     `system_trigger` origin, appended at the message-stream tail. Undo
 *     removes them; the next boundary diff re-announces whatever is still
 *     active. The system prompt (prefix) never changes mid-session — the
 *     activated skills stay out of `getModelSkillListing()` by construction.
 *   - Immediate + boundary cadence: activation is announced right after the
 *     tool result that triggered it (the model can use the skill in its very
 *     next step), and `inject()` runs at turn boundaries / post-compaction to
 *     heal undo, compaction, cross-agent activation (a subagent's touch
 *     activates session-wide), and resume.
 *   - Resume heal runs in the other direction too: a rebuilt registry starts
 *     every conditional skill as pending, while the replayed history carries
 *     the earlier announcements. The history is the ledger, so announced-but-
 *     pending skills are silently re-activated at the boundary — never an
 *     announcement for a skill the registry would refuse to invoke.
 */

import type { Agent } from '..';
import type { ContextMessage } from '../context/types';
import type { SkillDefinition } from '../../skill';
import { renderReminder } from './reminder';

/** Origin name of the skill-activation announcements (undo removes them). */
export const SKILL_ACTIVATION_TRIGGER = 'skill_activation';

const SKILLS_ACTIVATED_BLOCK = /<skills_activated>\n?([\s\S]*?)\n?<\/skills_activated>/g;

/** File-argument tool names whose `path` argument counts as a touch. */
const PATH_ARG_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit']);

/** Shell tool whose command text is scanned for path-like tokens. */
const BASH_TOOL_NAME = 'Bash';

/**
 * Render one activation announcement. The tag block carries bare skill names
 * only (so `foldAnnouncedActivatedSkillNames` can anchor on it without
 * tripping over prose); the description list and guidance live outside it.
 */
export function renderSkillActivationAnnouncement(
  skills: readonly SkillDefinition[],
): string {
  const names = skills.map((skill) => skill.name);
  const descriptions = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
  // Standard tier: a state announcement plus usage guidance — no trust
  // boundary (no IMPORTANT prefix), no opt-out (not a gentle suggestion), no
  // behavioral prohibition to close on.
  return renderReminder({
    authority: 'standard',
    body: [
      `<skills_activated>\n${names.join('\n')}\n</skills_activated>`,
      'These skills just became available because you touched files matching their `paths` activation patterns:\n' +
        descriptions.join('\n'),
      'Invoke one with the Skill tool using its exact name. ' +
        'They were deliberately absent from the skill listing at the top of this prompt; ' +
        'later <skills_activated> blocks may add more.',
    ].join('\n\n'),
  });
}

/**
 * Fold every skill-activation announcement in `history` into the announced
 * name set. There is no removal counterpart — activation is one-way — so this
 * is a plain union, anchored on the announcement origin like the
 * loadable-tools fold.
 */
export function foldAnnouncedActivatedSkillNames(
  history: readonly ContextMessage[],
): Set<string> {
  const announced = new Set<string>();
  for (const message of history) {
    if (message.origin?.kind !== 'system_trigger') continue;
    if (message.origin.name !== SKILL_ACTIVATION_TRIGGER) continue;
    const text = message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
    SKILLS_ACTIVATED_BLOCK.lastIndex = 0;
    for (const match of text.matchAll(SKILLS_ACTIVATED_BLOCK)) {
      const body = match[1] ?? '';
      for (const line of body.split('\n')) {
        const name = line.trim();
        if (name.length > 0) announced.add(name);
      }
    }
  }
  return announced;
}

/**
 * Extract the file paths a tool call touched, as activation candidates.
 * Write/Edit carry an explicit `path` argument; for Bash we scan the command
 * text for path-like tokens (contains a slash, or looks like a file name with
 * an extension), discarding flags, assignments, and URLs. Extraction is
 * deliberately permissive — a false positive only activates a skill early; a
 * false negative means a skill never wakes up.
 */
export function extractTouchedPaths(toolName: string, args: unknown): string[] {
  if (args === null || typeof args !== 'object') return [];
  if (PATH_ARG_TOOLS.has(toolName)) {
    const path = (args as Record<string, unknown>)['path'];
    return typeof path === 'string' && path.length > 0 ? [path] : [];
  }
  if (toolName === BASH_TOOL_NAME) {
    const command = (args as Record<string, unknown>)['command'];
    if (typeof command !== 'string' || command.length === 0) return [];
    return extractBashCommandPaths(command);
  }
  return [];
}

function extractBashCommandPaths(command: string): string[] {
  const out = new Set<string>();
  for (const raw of command.split(/[\s"'`$(){};|&<>]+/)) {
    let token = raw;
    if (token.length < 2) continue;
    if (token.startsWith('-')) continue;
    // Env assignments and --opt=value flags are not paths.
    if (token.includes('=')) continue;
    // URLs (https://…, git@host:… stays — scp-style has no //).
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token)) continue;
    token = token.replace(/^\.\//, '').replace(/[,:;]+$/, '');
    if (token.length < 2) continue;
    const looksLikePath =
      token.includes('/') || /^[\w.@+-]+\.[A-Za-z0-9]{1,10}$/.test(token);
    if (looksLikePath) out.add(token);
  }
  return [...out];
}

export class SkillActivationInjector {
  constructor(protected readonly agent: Agent) {}

  /**
   * Immediate path, called from the tool-result finalization: extract touched
   * paths, activate matching conditional skills in the (session-shared)
   * registry, and announce the newly activated set at the tail. Cheap no-op
   * when no conditional skills are pending or nothing new activated.
   */
  activateForToolResult(toolName: string, args: unknown): void {
    const registry = this.agent.skills?.registry;
    if (registry === undefined) return;
    if (!registry.hasPendingConditionalSkills()) return;
    const paths = extractTouchedPaths(toolName, args);
    if (paths.length === 0) return;
    const activated = registry.activateSkillsForPaths(paths, this.agent.config.cwd);
    if (activated.length === 0) return;
    this.announce(activated);
  }

  /**
   * Boundary catch-up (turn start, post-compaction). Two heal directions:
   * announced-but-pending skills re-activate silently (resume), and
   * active-but-unannounced skills get a fresh announcement (undo, compaction,
   * activation by a sibling agent). Most boundaries do nothing.
   */
  inject(): void {
    const registry = this.agent.skills?.registry;
    if (registry === undefined) return;
    const announced = foldAnnouncedActivatedSkillNames(this.agent.context.history);
    for (const name of announced) {
      registry.activatePendingConditionalSkill(name);
    }
    const missing = registry
      .listActivatedConditionalSkills()
      .filter((skill) => !announced.has(skill.name));
    if (missing.length === 0) return;
    this.announce(missing);
  }

  private announce(skills: readonly SkillDefinition[]): void {
    this.agent.context.appendSystemReminder(renderSkillActivationAnnouncement(skills), {
      kind: 'system_trigger',
      name: SKILL_ACTIVATION_TRIGGER,
    });
  }
}

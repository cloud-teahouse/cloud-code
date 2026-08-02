/**
 * Stateful owner of the sectioned system prompt: wraps the pure
 * assembler in `system-prompt-sections.ts` with the runtime concerns —
 *
 * - Append bus: session-level features attach extra instructions
 *   (`setAddendum`) that ALWAYS land at the prompt tail, no matter which
 *   profile produced the base — Claude Code's `appendSystemPrompt` addendum
 *   pattern. Bus sections are `append:<id>`-namespaced so an addendum id can
 *   never collide with a template section id, and they are exempt from the
 *   nothing-cacheable-after-uncached rule (the bus owns the tail by
 *   definition). Addenda are session-owned: like the profile itself, the
 *   caller re-applies them after resume (the persisted `config.update`
 *   carries the joined prompt; the bus does not persist on its own).
 *
 *   Override contract (mirrors Claude's override branch, which returns the
 *   override WITHOUT append): a `config.update({ systemPrompt })` direct set
 *   replaces the assembled prompt wholesale, and the bus does not compose
 *   with it. Bus operations while an override is live only register
 *   membership (`setAddendum`/`clearAddendum`); the Agent wrapper re-assembles
 *   and pushes to config only when the assembled prompt IS the live one
 *   (heuristic: `snapshot().prompt === config.systemPrompt`), otherwise the
 *   registration re-applies on the next profile render. `clearAddendum` on an
 *   unknown id is a true no-op — it must never trigger a re-assembly that
 *   would silently revert a live override.
 * - Output styles: `assemble` accepts an optional `OutputStyleDefinition`
 *   (`profile/output-style.ts`) and REPLACES the style-surface sections with
 *   its content before the bus is hung — Claude Code's outputStyle semantics
 *   (replace, never append). Replaced sections keep their id, heading line,
 *   cache class, and position; they are marked with the style's name so
 *   per-section hash attribution can say why they moved.
 * - Static-drift discipline: a `static` section whose hash moves between two
 *   same-profile assemblies means an undeclared volatile input slipped into
 *   template-fixed text. That is exactly what `DANGEROUS_uncachedSystemSection`
 *   exists to force into the open, so it is surfaced as an explicit warning.
 * - Drift attribution: recent assemblies are kept by whole-prompt hash, so
 *   when `LlmRequestRecorder` reports a `system` prefix drift it can name the
 *   sections that moved (`attributeDrift`) instead of just the dimension.
 * - Diagnostics: with cache diagnostics enabled (`debug.cacheDiagnostics` /
 *   `CLOUD_CODE_DEBUG_CACHE`, same gate as the recorder), every distinct
 *   assembly logs a per-section token/hash listing — the `/context`-style
 *   accounting of which sections cost what, and which prefix is stable.
 *
 * Byte-stability contract: with an empty bus the joined prompt is the profile
 * renderer's output byte-for-byte (`segmentProfileSystemPrompt` is lossless),
 * so `systemPromptNow` latching, resume restore, fork hand-off, and the
 * existing prompt-content tests are unaffected.
 */

import { createHash } from 'node:crypto';

import type { Logger } from '../logging';
import { isReplaceableSectionId, type OutputStyleDefinition } from './output-style';
import {
  assembleSystemPrompt,
  changedSectionIds,
  segmentProfileSystemPrompt,
  systemSection,
  type AssembledSystemPrompt,
  type SystemPromptSection,
} from './system-prompt-sections';

/** One append-bus entry: `id` is the caller's handle for replace/clear. */
export interface SystemPromptAddendum {
  readonly id: string;
  readonly content: string;
}

export interface SystemPromptAssemblyOptions {
  readonly log: Logger;
  /** Gate for the per-section diagnostics dump (cache diagnostics switch). */
  readonly isDiagnosticsEnabled?: () => boolean;
}

interface TrackedAssembly {
  readonly profileName: string;
  /** Profile-rendered sections before the append bus — the re-assembly input. */
  readonly baseSections: readonly SystemPromptSection[];
  readonly assembled: AssembledSystemPrompt;
}

/**
 * Assemblies remembered for drift attribution. A prompt only changes on
 * explicit refreshes (post-compaction, `/language`, MCP instructions, bus
 * changes), so a handful of entries covers every realistic session; the cap
 * keeps a pathological refresh loop from growing the map without bound.
 */
const MAX_REMEMBERED_ASSEMBLIES = 8;

/** Whole-prompt hash — sha256 hex, matching the recorder's `fingerprint()`. */
function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

export class SystemPromptAssembly {
  private readonly log: Logger;
  private readonly isDiagnosticsEnabled: (() => boolean) | undefined;
  private current: TrackedAssembly | undefined;
  private readonly byHash = new Map<string, AssembledSystemPrompt>();
  private readonly addenda: SystemPromptAddendum[] = [];

  constructor(options: SystemPromptAssemblyOptions) {
    this.log = options.log;
    this.isDiagnosticsEnabled = options.isDiagnosticsEnabled;
  }

  /** The most recent distinct assembly, for diagnostics snapshots. */
  snapshot(): AssembledSystemPrompt | undefined {
    return this.current?.assembled;
  }

  get addendaCount(): number {
    return this.addenda.length;
  }

  /**
   * Assemble a freshly rendered profile prompt: segment it, apply the active
   * output style's section replacements (when one is selected), hang the
   * append bus at the tail, validate, and track the result. Returns the
   * assembly whose `prompt` is what `config.systemPrompt` must become. A
   * render that reproduces the current prompt byte-for-byte returns the
   * existing assembly (no drift event, no diagnostics re-dump).
   */
  assemble(
    profileName: string,
    renderedPrompt: string,
    style?: OutputStyleDefinition,
  ): AssembledSystemPrompt {
    return this.assembleFromSections(
      profileName,
      applyOutputStyle(segmentProfileSystemPrompt(renderedPrompt), style),
    );
  }

  /**
   * Add or replace an append-bus addendum (same `id` replaces in place,
   * preserving bus order). Registration only — the caller decides whether the
   * change takes effect immediately via {@link reassemble} (Agent does so
   * while the assembled prompt is the live one) or on the next
   * {@link assemble} (while an override prompt is live, or before the first
   * profile render).
   */
  setAddendum(addendum: SystemPromptAddendum): void {
    const existing = this.addenda.findIndex((entry) => entry.id === addendum.id);
    if (existing === -1) {
      this.addenda.push(addendum);
    } else {
      this.addenda[existing] = addendum;
    }
  }

  /**
   * Remove an addendum by id. Returns false when the id is unknown — a true
   * no-op, so the caller never re-assembles (and never overwrites a live
   * override prompt) for a bus change that did not happen.
   */
  clearAddendum(id: string): boolean {
    const existing = this.addenda.findIndex((entry) => entry.id === id);
    if (existing === -1) return false;
    this.addenda.splice(existing, 1);
    return true;
  }

  /**
   * Re-assemble from the current profile base with the bus as registered.
   * Returns undefined when no profile render has been assembled yet. Only
   * call this when the assembly is the live prompt — see the override
   * contract in the module header.
   */
  reassemble(): AssembledSystemPrompt | undefined {
    if (this.current === undefined) return undefined;
    return this.assembleFromSections(this.current.profileName, this.current.baseSections);
  }

  /**
   * Section-level refinement of a `system` prefix drift: the ids of the
   * sections that differ between the two whole-prompt hashes, or undefined
   * when either side is not a known assembly (e.g. an override prompt set
   * directly through `config.update`). Empty array when the hashes match.
   */
  attributeDrift(
    previousPromptHash: string,
    currentPromptHash: string,
  ): readonly string[] | undefined {
    if (previousPromptHash === currentPromptHash) return [];
    const previous = this.byHash.get(previousPromptHash);
    const current = this.byHash.get(currentPromptHash);
    if (previous === undefined || current === undefined) return undefined;
    return changedSectionIds(previous, current);
  }

  private assembleFromSections(
    profileName: string,
    baseSections: readonly SystemPromptSection[],
  ): AssembledSystemPrompt {
    const busSections = this.addenda
      .filter((addendum) => addendum.content.trim().length > 0)
      .map((addendum) =>
        systemSection({
          id: `append:${addendum.id}`,
          content: addendum.content,
          cache: 'dynamic',
          origin: 'append',
        }),
      );
    const assembled = assembleSystemPrompt([...baseSections, ...busSections]);

    if (assembled.prompt === this.current?.assembled.prompt) {
      // Byte-identical refresh (the common post-compaction case): keep the
      // existing assembly so no drift is attributed and nothing re-dumps.
      return this.current.assembled;
    }

    if (this.current !== undefined && this.current.profileName === profileName) {
      this.warnOnStaticDrift(this.current.assembled, assembled, profileName);
    }
    this.current = { profileName, baseSections, assembled };
    this.remember(assembled);
    this.dumpDiagnostics(profileName, assembled);
    return assembled;
  }

  /**
   * The uncached-declaration enforcement's runtime half: a `static` section
   * that moved between same-profile assemblies carries an undeclared volatile
   * input. Named loudly so the offender gets reclassified `dynamic` — or
   * explicitly declared via `DANGEROUS_uncachedSystemSection`.
   */
  private warnOnStaticDrift(
    previous: AssembledSystemPrompt,
    next: AssembledSystemPrompt,
    profileName: string,
  ): void {
    const previousById = new Map(previous.sections.map((section) => [section.id, section]));
    const drifted = next.sections
      .filter((section) => {
        if (section.cache !== 'static') return false;
        const before = previousById.get(section.id);
        if (before === undefined || before.hash === section.hash) return false;
        // An output-style boundary crossing is a declared replacement, not an
        // undeclared volatile input: the style marker on either side says so.
        if (section.style !== undefined || before.style !== undefined) return false;
        return true;
      })
      .map((section) => section.id);
    if (drifted.length === 0) return;
    this.log.warn('system prompt static sections drifted between assemblies', {
      profileName,
      sections: drifted.join(','),
      hint: 'a volatile input is hiding in template-fixed text; reclassify the section dynamic or declare it with DANGEROUS_uncachedSystemSection',
    });
  }

  private remember(assembled: AssembledSystemPrompt): void {
    const hash = hashPrompt(assembled.prompt);
    if (this.byHash.has(hash)) return;
    if (this.byHash.size >= MAX_REMEMBERED_ASSEMBLIES) {
      const oldest = this.byHash.keys().next();
      if (!oldest.done) this.byHash.delete(oldest.value);
    }
    this.byHash.set(hash, assembled);
  }

  /**
   * Per-section token accounting: id, cache class, origin, estimated tokens,
   * and hash prefix, plus the dynamic boundary and the stable-prefix total —
   * the section-level view the whole-prompt `systemPromptHash` cannot give.
   */
  private dumpDiagnostics(profileName: string, assembled: AssembledSystemPrompt): void {
    if (this.isDiagnosticsEnabled?.() !== true) return;
    const boundarySection =
      assembled.dynamicBoundaryIndex < assembled.sections.length
        ? assembled.sections[assembled.dynamicBoundaryIndex]!.id
        : null;
    let totalTokens = 0;
    const sections = assembled.sections.map((section) => {
      totalTokens += section.tokens;
      return {
        id: section.id,
        cache: section.cache,
        origin: section.origin,
        tokens: section.tokens,
        hash: section.hash.slice(0, 12),
        ...(section.style !== undefined ? { style: section.style } : {}),
      };
    });
    this.log.info('llm system prompt sections', {
      profileName,
      sectionCount: assembled.sections.length,
      dynamicBoundary: boundarySection,
      staticPrefixTokens: assembled.staticPrefixTokens,
      totalTokens,
      sections,
    });
  }
}

/**
 * Output-style section replacement (Claude Code semantics: replace, never
 * append). Only the replaceable style surface (`profile/output-style.ts`) may
 * be rewritten — anything else a style claims is ignored here as well as at
 * parse time. A replaced section keeps its registered heading line, id, cache
 * class, and position; the style supplies the body below the heading, and the
 * section is marked with the style's name for hash attribution. The result is
 * byte-shaped exactly like an unreplaced section (heading, blank line, body,
 * trailing blank line) so joins stay lossless.
 *
 * The communicating-with-user replacement additionally ends with an
 * `Output style: <name>` line: the model cannot see its own configuration, so
 * naming the active style inside the replaced body lets it self-report and
 * follow the style. The marker rides the replacement branch only — the stock
 * prompt (no style) keeps a zero byte delta and no other section carries it.
 */
function applyOutputStyle(
  sections: readonly SystemPromptSection[],
  style: OutputStyleDefinition | undefined,
): readonly SystemPromptSection[] {
  if (style === undefined) return sections;
  return sections.map((section) => {
    if (!isReplaceableSectionId(section.id)) return section;
    const body = style.replacements[section.id];
    if (body === undefined) return section;
    const heading = section.content.split('\n', 1)[0]!;
    const content =
      section.id === 'communicating-with-user'
        ? `${body}\n\nOutput style: ${style.name}`
        : body;
    return { ...section, content: `${heading}\n\n${content}\n\n`, style: style.name };
  });
}

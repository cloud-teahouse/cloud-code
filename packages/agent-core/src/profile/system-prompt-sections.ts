/**
 * System prompt sections: the system prompt is assembled from an
 * ordered list of named sections instead of being treated as one opaque
 * string. Each section declares its cache class; the assembler validates the
 * declaration, joins the sections into the final prompt string, and computes
 * per-section hashes/token estimates for diagnostics and drift attribution.
 *
 * Wire reality (why this is an internal convention, not a provider feature):
 * kosong's `ChatProvider.generate()` takes a single `systemPrompt: string` on
 * every provider — Anthropic wraps it into one system text block with one
 * `cache_control` breakpoint (`kosong/src/providers/anthropic.ts`),
 * Kimi/OpenAI-legacy send one `system` message, OpenAI Responses uses the
 * single `instructions` string, Gemini a single `systemInstruction`. No
 * provider exposes per-section cache breakpoints through kosong, so sections
 * exist for assembly discipline and observability only: the joined bytes are
 * exactly what the profile renderer already produced (resume/fork
 * byte-stability is preserved), while ids, cache classes, and hashes give the
 * prefix-shape diagnostics a section-level attribution when the whole-prompt
 * hash drifts.
 *
 * Cache classes:
 * - `static`: template-fixed text, stable for the agent's lifetime. A static
 *   section whose hash moves between same-profile assemblies means an
 *   undeclared volatile input slipped in — the assembly surfaces that as an
 *   explicit warning (see `SystemPromptAssembly`).
 * - `dynamic`: derived from runtime context (env, latched timestamp, skill
 *   listing, MCP instructions, ...). Stable between explicit refreshes; a
 *   refresh may legitimately move it, and the drift is attributed by id.
 * - `uncached` (`DANGEROUS_uncachedSystemSection`): content that may change on
 *   ANY assembly without an explicit refresh. Like Claude Code's
 *   `DANGEROUS_uncachedSystemPromptSection`, the volatility must be declared
 *   with a reason, and uncached sections form the tail: a cacheable
 *   classification after a known prefix-breaker is a lie, so the assembler
 *   rejects it (append-bus sections excepted — the bus owns the tail).
 *
 * Override-priority mapping (Claude's `buildEffectiveSystemPrompt` matrix —
 * override > coordinator > agent > custom > default, append at the tail of
 * every non-override branch — onto Cloud Code's profile system):
 * - `default`/`custom`/`agent`: all are resolved profiles here; the
 *   custom-extends-agent inheritance lives in `profile/resolve.ts`, and the
 *   active profile is picked by `Agent.useProfile`. Profile-rendered sections
 *   carry the `profile`/`default`/`context` origins below; there is no
 *   separate `agent` origin because the profile system already collapses the
 *   three tiers into one renderer.
 * - `override`: a `config.update({ systemPrompt })` direct set replaces the
 *   assembled prompt wholesale (records restore uses it); it bypasses section
 *   assembly by design, exactly like Claude's override branch — and, exactly
 *   like Claude's override branch, the append bus does NOT compose with it:
 *   bus operations while an override is live only register membership and
 *   re-apply on the next profile render (see `SystemPromptAssembly`).
 * - `coordinator`: reserved — a future coordinator mode renders through the
 *   same assembly path; its extra instructions ride the append bus.
 * - `append`: the append bus (`SystemPromptAssembly.setAddendum`) always owns
 *   the tail of the assembled prompt.
 */

import { createHash } from 'node:crypto';

import { estimateTokens } from '../utils/tokens';

export type SystemPromptCacheClass = 'static' | 'dynamic' | 'uncached';

export type SystemPromptSectionOrigin = 'default' | 'profile' | 'context' | 'append';

export interface SystemPromptSection {
  readonly id: string;
  readonly content: string;
  readonly cache: SystemPromptCacheClass;
  readonly origin: SystemPromptSectionOrigin;
  /**
   * Mandatory on `uncached` sections (enforced by {@link assembleSystemPrompt}
   * — a literal `{ cache: 'uncached' }` without one is rejected, so the only
   * way to produce a valid uncached section is {@link DANGEROUS_uncachedSystemSection}):
   * the explanation of why per-assembly recomputation is necessary.
   */
  readonly uncachedReason?: string;
  /**
   * Name of the output style that supplied this section's content. Set only
   * on sections an output style replaced (see `profile/output-style.ts` for
   * the narrow replaceable boundary): per-section hash attribution uses it to
   * say *why* an otherwise-static section's hash moved.
   */
  readonly style?: string;
}

/** Create a cacheable (static or dynamic) system prompt section. */
export function systemSection(input: {
  readonly id: string;
  readonly content: string;
  readonly cache: 'static' | 'dynamic';
  readonly origin: SystemPromptSectionOrigin;
}): SystemPromptSection {
  return input;
}

/**
 * Create a volatile system prompt section that is recomputed on every
 * assembly. This WILL break the prompt-cache prefix when the value changes.
 * The reason is mandatory so the cache break is always a deliberate,
 * documented decision; a missing reason is a build-time error.
 */
export function DANGEROUS_uncachedSystemSection(
  id: string,
  content: string,
  origin: SystemPromptSectionOrigin,
  reason: string,
): SystemPromptSection {
  if (reason.trim().length === 0) {
    throw new Error(
      `DANGEROUS_uncachedSystemSection("${id}") requires a reason explaining why the cache break is necessary`,
    );
  }
  return { id, content, cache: 'uncached', origin, uncachedReason: reason };
}

export interface ResolvedSystemPromptSection extends SystemPromptSection {
  /** sha256 of `content`; the whole-prompt hash drift refines into these. */
  readonly hash: string;
  /** Character-heuristic token estimate (same estimator as compaction). */
  readonly tokens: number;
}

export interface AssembledSystemPrompt {
  /** The joined prompt bytes — identical to the pre-section render. */
  readonly prompt: string;
  readonly sections: readonly ResolvedSystemPromptSection[];
  /**
   * Index of the first non-static section (`sections.length` when all
   * static). This is the logical boundary between the cacheable trunk and the
   * runtime-derived tail — the role Claude Code's
   * `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker plays in its section array. It is
   * not rendered into the prompt (the wire sends one joined string); the
   * boundary exists for diagnostics (`staticPrefixTokens`) and for reading
   * drift attribution.
   */
  readonly dynamicBoundaryIndex: number;
  /** Token estimate of the leading run of static sections (the stable prefix). */
  readonly staticPrefixTokens: number;
}

/**
 * Join sections into the final prompt and resolve hashes/token estimates.
 *
 * Validation:
 * - ids must be unique (a duplicated id would make drift attribution lie);
 * - an uncached section must carry a non-empty reason — the invariant
 *   `DANGEROUS_uncachedSystemSection` establishes at build time, re-enforced
 *   here so a hand-written `{ cache: 'uncached' }` literal cannot bypass it;
 * - once an uncached section appears, every later non-append section must be
 *   uncached too — a `static`/`dynamic` classification after a known
 *   prefix-breaker claims cacheability the position can never have. Append-bus
 *   sections are exempt: the bus always owns the tail and its sections are
 *   content-fixed, so their cache class describes the content, not the
 *   cacheability of their position.
 *
 * Joining is byte-exact: profile sections carry their original bytes
 * (segmentation is lossless); before each append-origin section the preceding
 * trailing newlines are normalized to exactly one blank line so the addendum
 * tail has a deterministic separator.
 */
export function assembleSystemPrompt(
  sections: readonly SystemPromptSection[],
): AssembledSystemPrompt {
  const seen = new Set<string>();
  let uncachedSeen = false;
  for (const section of sections) {
    if (seen.has(section.id)) {
      throw new Error(`Duplicate system prompt section id: "${section.id}"`);
    }
    seen.add(section.id);
    if (section.cache === 'uncached') {
      if (section.uncachedReason === undefined || section.uncachedReason.trim().length === 0) {
        throw new Error(
          `System prompt section "${section.id}" is uncached but gives no reason; ` +
            `build it with DANGEROUS_uncachedSystemSection so the cache break is a documented decision.`,
        );
      }
      uncachedSeen = true;
    } else if (uncachedSeen && section.origin !== 'append') {
      throw new Error(
        `System prompt section "${section.id}" is classified cacheable but follows ` +
          `an uncached section; it can never be prompt-cached in that position. ` +
          `Declare it with DANGEROUS_uncachedSystemSection (with a reason) or move it before the uncached tail.`,
      );
    }
  }

  const resolved: ResolvedSystemPromptSection[] = sections.map((section) => ({
    ...section,
    hash: hashSectionContent(section.content),
    tokens: estimateTokens(section.content),
  }));

  let prompt = '';
  for (const section of sections) {
    if (section.origin === 'append' && prompt.length > 0) {
      prompt = `${prompt.replace(/\n+$/, '')}\n\n`;
    }
    prompt += section.content;
  }

  let dynamicBoundaryIndex = resolved.length;
  for (let i = 0; i < resolved.length; i++) {
    if (resolved[i]!.cache !== 'static') {
      dynamicBoundaryIndex = i;
      break;
    }
  }
  let staticPrefixTokens = 0;
  for (let i = 0; i < dynamicBoundaryIndex; i++) {
    staticPrefixTokens += resolved[i]!.tokens;
  }

  return { prompt, sections: resolved, dynamicBoundaryIndex, staticPrefixTokens };
}

/**
 * Ids of the sections whose content changed between two assemblies: hash
 * mismatch on a shared id, or an id present on only one side. Ids present in
 * the next assembly (changed or added) come first, in next-assembly order;
 * ids only in the previous assembly (removed) follow, in previous-assembly
 * order. Empty when the assemblies are section-identical.
 */
export function changedSectionIds(
  previous: AssembledSystemPrompt,
  next: AssembledSystemPrompt,
): string[] {
  const previousById = new Map(previous.sections.map((section) => [section.id, section]));
  const nextIds = new Set<string>();
  const changed: string[] = [];
  for (const section of next.sections) {
    nextIds.add(section.id);
    const before = previousById.get(section.id);
    if (before === undefined || before.hash !== section.hash) {
      changed.push(section.id);
    }
  }
  for (const section of previous.sections) {
    if (!nextIds.has(section.id)) {
      changed.push(section.id);
    }
  }
  return changed;
}

interface KnownSectionHeading {
  readonly heading: string;
  readonly id: string;
  readonly cache: 'static' | 'dynamic';
  readonly origin: SystemPromptSectionOrigin;
}

/**
 * Heading registry driving {@link segmentProfileSystemPrompt}. Covers every
 * top/sub heading of the bundled `profile/default/system.md` template; the
 * segmentation unit test pins the resulting id sequence so a template edit
 * that adds or renames a heading fails loudly until this registry is updated.
 *
 * Classification rule: `static`/`default` for template-fixed policy text,
 * `dynamic`/`context` for sections whose body comes from the render context
 * (language preference, OS/timestamp/cwd, git status, AGENTS.md, skills, MCP
 * instructions) — stable between explicit refreshes, attributed by id when a
 * refresh moves them.
 */
const KNOWN_SECTION_HEADINGS: readonly KnownSectionHeading[] = [
  { heading: '# Language', id: 'language', cache: 'dynamic', origin: 'context' },
  { heading: '# Prompt and Tool Use', id: 'prompt-and-tool-use', cache: 'static', origin: 'default' },
  {
    heading: '# Delegating to subagents',
    id: 'delegating-to-subagents',
    cache: 'static',
    origin: 'default',
  },
  {
    heading: '# Communicating with the user',
    id: 'communicating-with-user',
    cache: 'static',
    origin: 'default',
  },
  {
    heading: '# General Guidelines for Coding',
    id: 'guidelines-coding',
    cache: 'static',
    origin: 'default',
  },
  {
    heading: '# Delivering work',
    id: 'delivering-work',
    cache: 'static',
    origin: 'default',
  },
  {
    heading: '# General Guidelines for Research and Data Processing',
    id: 'guidelines-research',
    cache: 'static',
    origin: 'default',
  },
  { heading: '# Context Management', id: 'context-management', cache: 'static', origin: 'default' },
  // Heading-only chunk: everything under `# Working Environment` splits into
  // the `## …` sub-sections below, so what remains here is the fixed title.
  {
    heading: '# Working Environment',
    id: 'working-environment',
    cache: 'static',
    origin: 'default',
  },
  { heading: '## Operating System', id: 'env-os', cache: 'dynamic', origin: 'context' },
  { heading: '## Date and Time', id: 'env-now', cache: 'dynamic', origin: 'context' },
  { heading: '## Working Directory', id: 'env-cwd', cache: 'dynamic', origin: 'context' },
  { heading: '## Git Status', id: 'env-git-status', cache: 'dynamic', origin: 'context' },
  {
    heading: '## Additional Directories',
    id: 'env-additional-dirs',
    cache: 'dynamic',
    origin: 'context',
  },
  {
    heading: '# Project Information',
    id: 'project-information',
    cache: 'dynamic',
    origin: 'context',
  },
  { heading: '# Memory', id: 'memory', cache: 'dynamic', origin: 'context' },
  { heading: '# Skills', id: 'skills', cache: 'dynamic', origin: 'context' },
  {
    heading: '# MCP Server Instructions',
    id: 'mcp-instructions',
    cache: 'dynamic',
    origin: 'context',
  },
  { heading: '# Ultimate Reminders', id: 'ultimate-reminders', cache: 'static', origin: 'default' },
];

/**
 * Split a rendered profile system prompt into sections at the registered
 * headings, losslessly: concatenating the returned contents reproduces the
 * input byte-for-byte (chunks are offset slices of the input, so no newline
 * arithmetic can drift). The leading chunk (before the first known heading)
 * is the `identity` section — the intro plus the profile's ROLE_ADDITIONAL.
 *
 * Deliberate tolerances, so injected content (AGENTS.md, MCP bodies) cannot
 * corrupt the segmentation:
 * - only EXACT heading lines split (an unregistered `# Foo` folds into the
 *   enclosing section);
 * - headings must match in strictly increasing registry order (an injected
 *   `# Language` line inside the AGENTS.md body is out of order at that point
 *   and folds into `project-information` instead of splitting);
 * - a registered heading already consumed is ignored (injected content
 *   duplicating a real heading cannot create a duplicate id).
 * An in-order injected duplicate still splits early — indistinguishable from
 * the real heading without template-aware parsing — but the result stays
 * lossless, unique-id'd, and validated. A prompt with no known heading at all
 * (a fully custom profile template) degrades to a single conservative dynamic
 * `identity` section.
 */
export function segmentProfileSystemPrompt(prompt: string): SystemPromptSection[] {
  const knownByHeading = new Map(
    KNOWN_SECTION_HEADINGS.map((known, registryIndex) => [known.heading, { known, registryIndex }]),
  );
  const consumed = new Set<string>();

  // Split points: start offsets of lines that exactly equal a registered
  // heading (first in-order occurrence only).
  const splits: { readonly offset: number; readonly known: KnownSectionHeading }[] = [];
  let offset = 0;
  let lastRegistryIndex = -1;
  for (const line of prompt.split('\n')) {
    const match = knownByHeading.get(line.trimEnd());
    if (
      match !== undefined &&
      match.registryIndex > lastRegistryIndex &&
      !consumed.has(match.known.id) &&
      offset > 0
    ) {
      splits.push({ offset, known: match.known });
      consumed.add(match.known.id);
      lastRegistryIndex = match.registryIndex;
    }
    offset += line.length + 1;
  }

  if (splits.length === 0) {
    return prompt.length === 0
      ? []
      : [{ id: 'identity', content: prompt, cache: 'dynamic', origin: 'profile' }];
  }

  const boundaries = [...splits.map((split) => split.offset), prompt.length];
  const sections: SystemPromptSection[] = [
    { id: 'identity', content: prompt.slice(0, splits[0]!.offset), cache: 'static', origin: 'profile' },
  ];
  for (let i = 0; i < splits.length; i++) {
    const { known } = splits[i]!;
    sections.push({
      id: known.id,
      content: prompt.slice(boundaries[i], boundaries[i + 1]),
      cache: known.cache,
      origin: known.origin,
    });
  }
  return sections;
}

function hashSectionContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

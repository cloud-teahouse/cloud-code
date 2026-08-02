/**
 * select_tools — the load-by-name / load-by-search primitive of progressive
 * tool disclosure. Dynamic tool schemas stay out of the immutable top-level
 * `tools[]`; the model reads the `<tools_added>/<tools_removed>`
 * announcements, calls this tool with exact names or a search query, and the
 * full definitions are appended to the conversation as a `role: 'system'`
 * message carrying `tools` (the `messages[].tools` wire contract). Loaded
 * tools become executable the very next step: the loop re-reads the
 * executable tool table per step.
 *
 * Query forms (mirroring Claude Code's ToolSearch syntax):
 *   - `names: ["a", "b"]` or `query: "select:a,b"` — exact names;
 *   - `query: "notebook jupyter"` — keyword search over names+descriptions,
 *     best `maxResults` matches load;
 *   - `query: "+slack send"` — `+word` requires the word in the tool name,
 *     remaining bare words rank the candidates.
 *
 * Registered only when `agent.toolSelectEnabled` (capability × flag gate) and
 * deliberately NOT main-agent-only — subagents get the same disclosure.
 *
 * Concurrency: no `accesses` is declared, so the execution defaults to
 * `ToolAccesses.all()` and is serialized against every other tool in the same
 * batch. That is a design constraint, not an accident — two select_tools
 * calls settling concurrently could double-inject the same schema message.
 */

import { z } from 'zod';

import type { Agent } from '#/agent';
import { DYNAMIC_TOOL_SCHEMA_VARIANT } from '../../agent/context/dynamic-tools';
import type { BuiltinTool } from '../../agent/tool/types';
import type { ToolExecution } from '../../loop/types';
import { toInputJsonSchema } from '../support/input-schema';

export const SELECT_TOOLS_TOOL_NAME = 'select_tools';

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 20;

export const SelectToolsInputSchema = z
  .object({
    names: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        'Exact tool names to load, taken from the latest announced tool list.',
      ),
    query: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Search query for when you do not know the exact names. Forms: "select:a,b" loads exact names; bare words (e.g. "notebook jupyter") keyword-search tool names and descriptions and load the best matches; "+word" requires the word in the tool name (e.g. "+slack send").',
      ),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(MAX_RESULTS_CAP)
      .optional()
      .describe(
        `Cap on keyword-search matches to load (default ${String(DEFAULT_MAX_RESULTS)}). Ignored for exact names.`,
      ),
  })
  .strict();

export type SelectToolsInput = z.infer<typeof SelectToolsInputSchema>;

// The description sits inside the immutable top-level tools[] — it must stay
// byte-stable across the session. Anything that varies with the tool set
// (names, counts) belongs in the announcements, never here.
const DESCRIPTION =
  'Load one or more tools so you can call them. ' +
  'All available tool names are listed in the <tools_added>/<tools_removed> announcements ' +
  'in the system context — fold them in order to get the current list. ' +
  'Pass exact "names" when you know them; their full definitions become available immediately, ' +
  'so you can call them directly in your next tool call. ' +
  'When you only know what a tool does, pass a "query" instead: bare words keyword-search ' +
  'names and descriptions, "+word" requires the word in the tool name, and "select:a,b" ' +
  'is the exact-name form; the best matches load the same way.';

/** Parsed `query` string. */
export type SelectToolsQuery =
  | { readonly kind: 'select'; readonly names: readonly string[] }
  | { readonly kind: 'search'; readonly required: readonly string[]; readonly terms: readonly string[] };

/** One searchable tool: its qualified name plus the description text searched. */
export interface ToolSearchCandidate {
  readonly name: string;
  readonly description: string;
}

/**
 * Parse the `query` string. `select:` switches to the exact-name form;
 * otherwise tokens split on whitespace, `+word` becomes a required
 * (name-substring) term, and bare words become ranking terms. All terms are
 * lowercased — matching is case-insensitive throughout.
 */
export function parseSelectToolsQuery(query: string): SelectToolsQuery {
  const trimmed = query.trim();
  if (trimmed.startsWith('select:')) {
    const names = trimmed
      .slice('select:'.length)
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    return { kind: 'select', names };
  }
  const required: string[] = [];
  const terms: string[] = [];
  for (const token of trimmed.split(/\s+/)) {
    if (token.length === 0) continue;
    if (token.startsWith('+') && token.length > 1) {
      required.push(token.slice(1).toLowerCase());
    } else {
      terms.push(token.toLowerCase());
    }
  }
  return { kind: 'search', required, terms };
}

/**
 * Rank `candidates` for a search query. `+required` terms filter (the tool
 * name must contain every one); bare terms score — a name hit outranks a
 * description-only hit. Zero-score candidates drop out. Ties break on name so
 * the output is byte-stable for a stable pool.
 */
export function searchToolCandidates(
  candidates: readonly ToolSearchCandidate[],
  query: { readonly required: readonly string[]; readonly terms: readonly string[] },
  maxResults: number,
): readonly ToolSearchCandidate[] {
  const required = query.required.map((term) => term.toLowerCase());
  const terms = query.terms.map((term) => term.toLowerCase());
  const passing = candidates.filter((candidate) => {
    const name = candidate.name.toLowerCase();
    return required.every((term) => name.includes(term));
  });
  if (terms.length === 0) {
    return [...passing]
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .slice(0, maxResults);
  }
  const scored: Array<{ readonly candidate: ToolSearchCandidate; readonly score: number }> = [];
  for (const candidate of passing) {
    const name = candidate.name.toLowerCase();
    const description = candidate.description.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name.includes(term)) score += 2;
      else if (description.includes(term)) score += 1;
    }
    if (score > 0) scored.push({ candidate, score });
  }
  return scored
    .toSorted((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name))
    .slice(0, maxResults)
    .map((entry) => entry.candidate);
}

export class SelectToolsTool implements BuiltinTool<SelectToolsInput> {
  readonly name = SELECT_TOOLS_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SelectToolsInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: SelectToolsInput): ToolExecution {
    return {
      description: `Loading ${(args.names ?? []).join(', ') || (args.query ?? '')}`,
      approvalRule: this.name,
      execute: async () => {
        // The tool is registered unconditionally (the flag can flip at
        // runtime without a builtin refresh) but only offered while the
        // disclosure gate is open; guard the tiny window where the gate
        // closed between table build and execution.
        if (!this.agent.toolSelectEnabled) {
          return {
            output: 'select_tools is not available for the current model.',
            isError: true,
          };
        }
        const manager = this.agent.tools;
        const loadable = new Set(manager.loadableDynamicToolNames());
        const loaded = manager.loadedDynamicToolNames();

        // Resolve the query (if any) into exact names before bucketing, so
        // the per-name semantics below stay identical for every input form.
        const requested = new Set<string>(args.names ?? []);
        let searched: readonly ToolSearchCandidate[] | undefined;
        let queryNoMatch = false;
        if (args.query !== undefined) {
          const parsed = parseSelectToolsQuery(args.query);
          if (parsed.kind === 'select') {
            for (const name of parsed.names) requested.add(name);
          } else {
            // The search pool is every name the model could load or has
            // loaded; descriptions come from the live registry (never from
            // history), same source as the injected schemas.
            const pool = [...new Set([...loadable, ...loaded])]
              .map((name) => ({
                name,
                description: manager.getDynamicToolSchema(name)?.description ?? '',
              }))
              .toSorted((a, b) => a.name.localeCompare(b.name));
            searched = searchToolCandidates(
              pool,
              parsed,
              args.maxResults ?? DEFAULT_MAX_RESULTS,
            );
            queryNoMatch = searched.length === 0;
            for (const match of searched) requested.add(match.name);
          }
        }

        if (requested.size === 0) {
          const output = queryNoMatch
            ? `No tools matched the query "${args.query ?? ''}". Try different keywords, or pick exact names from the latest announced tools list.`
            : 'Nothing to load: pass "names" and/or "query".';
          return { output, isError: true };
        }

        // Mixed input settles per name: hits load, known-loaded report, and
        // unknowns error individually — never all-or-nothing, so the model
        // does not re-request the whole batch over one typo.
        const toLoad: string[] = [];
        const alreadyAvailable: string[] = [];
        const unknown: string[] = [];
        for (const name of requested) {
          if (loaded.has(name)) {
            alreadyAvailable.push(name);
          } else if (loadable.has(name)) {
            toLoad.push(name);
          } else {
            unknown.push(name);
          }
        }

        if (toLoad.length > 0) {
          // Schemas are read from the live registry at injection time and
          // sorted by name for byte-stable output. History is never used as a
          // schema source; an already-loaded name whose registry schema has
          // since changed is NOT re-injected (no runtime last-wins reliance) —
          // the stale copy lasts at most until the next compaction discards
          // the loaded set, after which a re-select injects the new schema.
          toLoad.sort((a, b) => a.localeCompare(b));
          const tools = toLoad
            .map((name) => manager.getDynamicToolSchema(name))
            .filter((tool): tool is NonNullable<typeof tool> => tool !== undefined);
          this.agent.context.appendMessage({
            role: 'system',
            content: [],
            toolCalls: [],
            tools,
            origin: { kind: 'injection', variant: DYNAMIC_TOOL_SCHEMA_VARIANT },
          });
          // The schema message may sit in the deferred queue until this tool
          // exchange closes; the pending mark keeps the ledger ahead of the
          // history inside that window so a same-step re-select is a no-op.
          manager.markDynamicToolsLoaded(toLoad);
        }

        const lines: string[] = [];
        if (searched !== undefined && searched.length > 0) {
          lines.push(
            `Matched: ${searched.map((match) => `${match.name} — ${match.description}`).join('; ')}`,
          );
        }
        if (toLoad.length > 0) lines.push(`Loaded: ${toLoad.join(', ')}`);
        if (alreadyAvailable.length > 0) {
          lines.push(`Already available: ${alreadyAvailable.join(', ')}`);
        }
        for (const name of unknown) {
          lines.push(`Unknown tool: ${name}. Pick from the latest announced tools list.`);
        }
        const isError =
          toLoad.length === 0 && alreadyAvailable.length === 0;
        return isError ? { output: lines.join('\n'), isError } : { output: lines.join('\n') };
      },
    };
  }
}

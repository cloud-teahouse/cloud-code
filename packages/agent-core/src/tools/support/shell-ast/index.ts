/**
 * Bash command analysis for permission matching.
 *
 * Parses a shell command string with tree-sitter and splits it into its
 * constituent simple commands (pipelines, `&&`/`||`/`;` chains, subshells,
 * and command substitutions — nested `command` nodes included). Each
 * segment yields a `subject` (its source text, redirect included) and a
 * session-approval rule built from the arity prefix (`Bash(git push *)`).
 *
 * Any failure — wasm init, parse error, or a tree with no `command` nodes
 * (`FOO=1`, comments) — degrades to pre-F2 whole-string matching:
 * `subjects = [command]` and a literal escaped approval rule.
 *
 * Results are cached in a small LRU. Only extracted plain data is cached;
 * tree-sitter `Tree` objects are deleted immediately after extraction so
 * web-tree-sitter's manual memory management never leaks.
 */

import type { Node } from 'web-tree-sitter';

import { escapeRuleSubjectLiteral, literalRulePattern } from '../rule-match';
import { prefix as arityPrefix } from './arity';
import { classifyGitSegment, type GitSegmentClass } from './git-classify';
import { ensureBashParser } from './parser';
import { commandNodes, parts, source } from './subcommands';
import { stripWrapperTokens } from './wrappers';

export { classifyGitSegment } from './git-classify';
export type { GitSegmentClass } from './git-classify';
export {
  BINARY_HIJACK_VARS,
  stripWrapperPrefixes,
  stripWrapperTokens,
} from './wrappers';
export type { StrippedCommand, StrippedTokens, WrapperStripMode } from './wrappers';

/** Plain per-segment data, aligned 1:1 with `BashCommandAnalysis.subjects`. */
export interface BashCommandSegment {
  /** Segment source text (same value as the matching `subjects` entry). */
  readonly subject: string;
  /** Command name plus word/string tokens, as read by `parts()`. */
  readonly tokens: readonly string[];
  /**
   * Git risk class of this segment; `undefined` for non-git commands.
   * Classified on the wrapper-stripped token view when stripping is enabled
   * (`sudo git push` classifies as `shared-remote`, not undefined);
   * a refused strip keeps the raw view, as does `stripWrappers: false`.
   */
  readonly gitClass: GitSegmentClass;
}

export interface BashCommandAnalysis {
  /** Per-segment source text (trimmed, redirects included), document order. */
  readonly subjects: readonly string[];
  /** One `Bash(<arity prefix> *)` rule per distinct segment prefix. */
  readonly approvalRules: readonly string[];
  /** True when parsing failed and the analysis is the whole-string fallback. */
  readonly degraded: boolean;
  /**
   * Per-segment tokens and git classification (additive data plane, design
   * doc §3.1). Produced alongside `subjects` in the same extraction pass;
   * in the degraded form it is a single token-less, unclassified segment.
   */
  readonly segments: readonly BashCommandSegment[];
}

export interface AnalyzeBashCommandOptions {
  /**
   * Peel safe wrappers (sudo/timeout/env/…) before computing arity-prefix
   * approval rules (design doc §3.2.A). Default true; the degraded
   * whole-string form never strips regardless of this flag.
   */
  readonly stripWrappers?: boolean | undefined;
}

const MAX_CACHE_ENTRIES = 500;
const analysisCache = new Map<string, BashCommandAnalysis>();

export async function analyzeBashCommand(
  command: string,
  options?: AnalyzeBashCommandOptions,
): Promise<BashCommandAnalysis> {
  const stripWrappers = options?.stripWrappers !== false;
  // The flag changes rule generation, so it is part of the cache key.
  const cacheKey = `${stripWrappers ? 'S' : 'R'}\n${command}`;
  const cached = analysisCache.get(cacheKey);
  if (cached !== undefined) {
    // Refresh LRU recency.
    analysisCache.delete(cacheKey);
    analysisCache.set(cacheKey, cached);
    return cached;
  }
  const analysis = await analyze(command, stripWrappers);
  analysisCache.set(cacheKey, analysis);
  if (analysisCache.size > MAX_CACHE_ENTRIES) {
    const oldest = analysisCache.keys().next();
    if (!oldest.done) analysisCache.delete(oldest.value);
  }
  return analysis;
}

/** Test hook: drop all cached analyses. */
export function clearBashAnalysisCacheForTests(): void {
  analysisCache.clear();
}

async function analyze(
  command: string,
  stripWrappers: boolean,
): Promise<BashCommandAnalysis> {
  let parser;
  try {
    parser = await ensureBashParser();
  } catch {
    return degradedAnalysis(command);
  }
  try {
    const tree = parser.parse(command);
    if (tree === null) throw new Error('tree-sitter parse returned null');
    try {
      const analysis = extractAnalysis(tree.rootNode, stripWrappers);
      if (analysis === undefined) {
        return degradedAnalysis(command);
      }
      return analysis;
    } finally {
      tree.delete();
    }
  } catch {
    return degradedAnalysis(command);
  }
}

function extractAnalysis(root: Node, stripWrappers: boolean): BashCommandAnalysis | undefined {
  const subjects: string[] = [];
  const approvalRules: string[] = [];
  const segments: BashCommandSegment[] = [];
  const seenRules = new Set<string>();
  for (const node of commandNodes(root)) {
    const subject = source(node);
    if (subject.length === 0) continue;
    // The segments data plane keeps the word/string-only token view.
    const tokens = parts(node).map((part) => part.text);
    subjects.push(subject);
    // Rule generation walks again with numbers and substitutions included
    // so wrapper argument validation sees every argv element (the
    // `timeout` DURATION, a `sudo -u $(whoami)` value). With stripping off
    // the word view is reused, keeping the legacy rule shapes byte-for-byte.
    const ruleTokens = stripWrappers
      ? parts(node, { includeNumbers: true, includeSubstitutions: true }).map((part) => part.text)
      : tokens;
    // Git classification runs on the same wrapper-stripped view the
    // rules are generated from, so a wrapped git command (`sudo git push`)
    // is classified by what actually runs instead of hiding behind the
    // wrapper name. A refused strip and `stripWrappers: false` both keep
    // the raw view (the legacy behavior).
    const gitClass = classifyGitSegment(
      stripWrappers ? stripWrapperTokens(ruleTokens).tokens : tokens,
    );
    segments.push({ subject, tokens, gitClass });
    const rule = segmentApprovalRule(ruleTokens, subject, stripWrappers);
    if (!seenRules.has(rule)) {
      seenRules.add(rule);
      approvalRules.push(rule);
    }
  }
  if (subjects.length === 0) return undefined;
  return { subjects, approvalRules, degraded: false, segments };
}

function segmentApprovalRule(
  tokens: readonly string[],
  subject: string,
  stripWrappers: boolean,
): string {
  // Design doc §3.2.A: peel safe wrappers before the arity prefix so
  // `sudo git push origin main` grants `Bash(git push *)`, not the
  // over-broad `Bash(sudo *)`. A refused strip falls back to raw tokens.
  const effectiveTokens = stripWrappers ? stripWrapperTokens(tokens).tokens : tokens;
  const prefixTokens = arityPrefix(effectiveTokens);
  if (prefixTokens.length === 0) return literalRulePattern('Bash', subject);
  return `Bash(${escapeRuleSubjectLiteral(prefixTokens.join(' '))} *)`;
}

/** Pre-F2 behavior: one subject (the whole command), one literal rule. */
function degradedAnalysis(command: string): BashCommandAnalysis {
  return {
    subjects: [command],
    approvalRules: [literalRulePattern('Bash', command)],
    degraded: true,
    // No tokens without a parse tree: the git classifier stays out of the
    // degraded path, which keeps its literal whole-string semantics.
    segments: [{ subject: command, tokens: [], gitClass: undefined }],
  };
}

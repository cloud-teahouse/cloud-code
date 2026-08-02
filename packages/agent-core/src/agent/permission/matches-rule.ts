import { cachedGlobIsMatch } from '../../utils/glob-cache';
import type { RunnableToolExecution } from '../../loop/types';
import type { PermissionRule } from './types';

/**
 * DSL parser for PermissionRule `pattern` strings.
 *
 * Grammar:
 *   pattern    := toolName ( "(" argPattern ")" )?
 *   toolName   := identifier characters (e.g. `Bash`, `mcp__github__*`)
 *   argPattern := any string interpreted only by a tool-provided matcher
 *
 * Examples:
 *   "Write"            -> { toolName: "Write" }
 *   "Read(/etc/**)"    -> { toolName: "Read", argPattern: "/etc/**" }
 *   "Bash(!rm *)"      -> { toolName: "Bash", argPattern: "!rm *" }
 *   "mcp__github__*"   -> { toolName: "mcp__github__*" }
 */
export interface ParsedPattern {
  readonly toolName: string;
  readonly argPattern?: string;
}

export interface PermissionRuleMatchExecution {
  readonly matchesRule?: RunnableToolExecution['matchesRule'];
  readonly ruleMatch?: RunnableToolExecution['ruleMatch'];
  readonly ruleToolName?: RunnableToolExecution['ruleToolName'];
}

export type PermissionRuleMatchStrategy = 'tool_name_only' | 'matches_rule';

/**
 * The tool-name a rule's namespace is matched against: the execution's
 * {@link RunnableToolExecution.ruleToolName} when the tool permissions its
 * calls under another tool's namespace (ExecSession → `'Bash'`), otherwise
 * the tool call's own name.
 */
function ruleNamespaceOf(execution: PermissionRuleMatchExecution, toolName: string): string {
  return execution.ruleToolName ?? toolName;
}

export interface PermissionRuleMatch {
  readonly rule: PermissionRule;
  readonly strategy: PermissionRuleMatchStrategy;
  readonly hasRuleArgs: boolean;
}

export interface PermissionRuleMatchInput {
  readonly rule: PermissionRule;
  readonly toolName: string;
  readonly execution: PermissionRuleMatchExecution;
}

/**
 * Parse a DSL pattern. Throws on malformed input (missing closing paren,
 * empty tool name). The parser is the single source of truth for DSL syntax.
 */
export function parsePattern(pattern: string): ParsedPattern {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    throw new Error('permission pattern: empty string');
  }

  const openIdx = trimmed.indexOf('(');
  if (openIdx === -1) {
    return { toolName: trimmed };
  }

  if (!trimmed.endsWith(')')) {
    throw new Error(`permission pattern: missing closing paren in "${pattern}"`);
  }

  const toolName = trimmed.slice(0, openIdx);
  const argPattern = trimmed.slice(openIdx + 1, -1);
  if (toolName.length === 0) {
    throw new Error(`permission pattern: empty tool name in "${pattern}"`);
  }
  // `Tool()` parses to no arg pattern so it stays tool-name-only — tools without
  // a `matchesRule` matcher (user/MCP/custom) would otherwise stop matching it.
  if (argPattern.length === 0) {
    return { toolName };
  }
  return { toolName, argPattern };
}

export function matchPermissionRule({
  rule,
  toolName,
  execution,
}: PermissionRuleMatchInput): PermissionRuleMatch | undefined {
  let parsed;
  try {
    parsed = parsePattern(rule.pattern);
  } catch {
    return undefined;
  }

  if (parsed.toolName !== '*' && !cachedGlobIsMatch(ruleNamespaceOf(execution, toolName), parsed.toolName)) {
    return undefined;
  }

  if (parsed.argPattern === undefined) {
    return { rule, strategy: 'tool_name_only', hasRuleArgs: false };
  }
  const argPattern = parsed.argPattern;

  const ruleMatch = execution.ruleMatch;
  if (ruleMatch !== undefined) {
    // Per-segment semantics: deny/ask fire when any subject matches (∃);
    // a single allow rule must cover every subject (∀). Allow rules are
    // usually unioned across a rule set instead — see collectCoveredSubjects.
    // `rule.decision` is passed through so wrappers-aware matchers can pick
    // the stripping strength (C3 P2: allow strips less than ask/deny).
    const matched =
      rule.decision === 'allow'
        ? ruleMatch.subjects.every((subject) =>
            ruleMatch.matches(argPattern, subject, rule.decision),
          )
        : ruleMatch.subjects.some((subject) =>
            ruleMatch.matches(argPattern, subject, rule.decision),
          );
    return matched ? { rule, strategy: 'matches_rule', hasRuleArgs: true } : undefined;
  }

  return execution.matchesRule?.(argPattern) === true
    ? { rule, strategy: 'matches_rule', hasRuleArgs: true }
    : undefined;
}

export interface CoveredSubjectsResult {
  /** True when the union of `rules` covers every subject of the execution. */
  readonly fullyCovered: boolean;
  /** First rule that matched anything, for decision-reason metadata. */
  readonly firstMatch?: PermissionRuleMatch | undefined;
}

/**
 * Set-cover helper for allow-∀ semantics over decomposable executions
 * (design doc §3.3): one approved compound command stores one rule per
 * segment, so approving the next similar call requires the *union* of
 * several allow rules to cover every subject.
 *
 * Returns `undefined` when the execution has no `ruleMatch` — callers fall
 * back to single-rule {@link matchPermissionRule} in that case.
 */
export function collectCoveredSubjects(input: {
  readonly rules: readonly PermissionRule[];
  readonly toolName: string;
  readonly execution: PermissionRuleMatchExecution;
}): CoveredSubjectsResult | undefined {
  const ruleMatch = input.execution.ruleMatch;
  if (ruleMatch === undefined) return undefined;

  const covered = new Set<number>();
  let firstMatch: PermissionRuleMatch | undefined;
  for (const rule of input.rules) {
    let parsed;
    try {
      parsed = parsePattern(rule.pattern);
    } catch {
      continue;
    }
    if (parsed.toolName !== '*' && !cachedGlobIsMatch(ruleNamespaceOf(input.execution, input.toolName), parsed.toolName)) {
      continue;
    }
    if (parsed.argPattern === undefined) {
      firstMatch ??= { rule, strategy: 'tool_name_only', hasRuleArgs: false };
      for (let i = 0; i < ruleMatch.subjects.length; i++) covered.add(i);
      continue;
    }
    const argPattern = parsed.argPattern;
    let hit = false;
    ruleMatch.subjects.forEach((subject, i) => {
      // Same decision passthrough as matchPermissionRule: union coverage
      // is an allow-side check, so matchers apply allow-strength stripping.
      if (ruleMatch.matches(argPattern, subject, rule.decision)) {
        covered.add(i);
        hit = true;
      }
    });
    if (hit) firstMatch ??= { rule, strategy: 'matches_rule', hasRuleArgs: true };
  }
  return {
    fullyCovered: ruleMatch.subjects.length > 0 && covered.size === ruleMatch.subjects.length,
    firstMatch,
  };
}

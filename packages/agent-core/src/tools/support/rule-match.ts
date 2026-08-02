import {
  pathGlobMatch,
  textGlobMatch,
  type PermissionPathMatchOptions,
} from './path-glob-match';
import { stripWrapperPrefixes } from './shell-ast/wrappers';

const GLOB_LITERAL_SPECIAL = /[\\*?[\]{}()!+@|]/g;

export function literalRulePattern(toolName: string, subject: string): string {
  return `${toolName}(${escapeRuleSubjectLiteral(subject)})`;
}

export function escapeRuleSubjectLiteral(subject: string): string {
  return subject.replace(GLOB_LITERAL_SPECIAL, '\\$&');
}

export function matchesGlobRuleSubject(ruleArgs: string, subject: string): boolean {
  // Text semantics (`*` crosses `/`): the subjects matched here are command
  // strings, URLs and search patterns, never file paths — those go through
  // matchesPathRuleSubject.
  return matchRuleSubjects(ruleArgs, [subject], (pattern, value) => textGlobMatch(value, pattern));
}

export interface WrapperAwareMatchOptions {
  /** Master switch (`permission.wrapper_stripping`, default on). */
  readonly enabled: boolean;
  /** Degraded analyses keep literal whole-string matching — never strip. */
  readonly degraded: boolean;
  /**
   * Decision of the rule being evaluated; selects the stripping strength.
   * Absent → original-subject matching only (pre-P2 behavior).
   */
  readonly decision?: 'allow' | 'ask' | 'deny' | undefined;
}

/**
 * Wrapper-aware subject matching (design doc §3.2.A): try the original
 * subject first, then the stripped form with a strength chosen by the
 * rule's decision — 'allow' strips only safe-listed env assignments
 * (`DOCKER_HOST=evil docker ps` must not auto-match an allow rule), while
 * 'ask'/'deny' strip every leading assignment plus wrappers
 * (`FOO=evil sudo rm x` must still hit a `Bash(rm *)` deny).
 */
export function matchesWrapperAwareSubject(
  ruleArgs: string,
  subject: string,
  options: WrapperAwareMatchOptions,
): boolean {
  if (matchesGlobRuleSubject(ruleArgs, subject)) return true;
  if (!options.enabled || options.degraded || options.decision === undefined) return false;
  // Negated patterns (`Bash(!rm *)`) match the original subject only: a
  // stripped form inverts their meaning — `allow !rm *` would start
  // covering `sudo rm x` (fail-open) and `deny !rm *` would stop covering
  // it (confusing either way).
  if (ruleArgs.startsWith('!')) return false;
  const stripped = stripWrapperPrefixes(subject, options.decision === 'allow' ? 'allow' : 'deny');
  return stripped.stripped && matchesGlobRuleSubject(ruleArgs, stripped.command);
}

export function matchesPathRuleSubject(
  ruleArgs: string,
  subject: string,
  options?: PermissionPathMatchOptions,
): boolean {
  return matchRuleSubjects(ruleArgs, [subject], (pattern, value) =>
    pathGlobMatch(value, pattern, options),
  );
}

function matchRuleSubjects(
  ruleArgs: string,
  subjects: readonly string[],
  matchesPositivePattern: (pattern: string, subject: string) => boolean,
): boolean {
  if (ruleArgs.length === 0) return true;
  const negated = ruleArgs.startsWith('!');
  const positivePattern = negated ? ruleArgs.slice(1) : ruleArgs;
  const hit = subjects.some((subject) => matchesPositivePattern(positivePattern, subject));
  return negated ? !hit : hit;
}

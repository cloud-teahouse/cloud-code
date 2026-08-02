import type { Agent } from '../..';
import {
  collectCoveredSubjects,
  matchPermissionRule,
  type PermissionRuleMatch,
} from '../matches-rule';
import type {
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResult,
  PermissionRule,
} from '../types';

export class SessionApprovalHistoryPermissionPolicy implements PermissionPolicy {
  readonly name = 'session-approval-history';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    // Decomposable executions (compound Bash commands) need the union of all
    // session rules to cover every segment; a single rule covering one
    // segment must not approve the whole call.
    if (context.execution.ruleMatch !== undefined) {
      return this.matchSessionApprovalUnion(context);
    }

    const match = this.matchSessionApprovalRule(context);
    if (match === undefined) return;
    return {
      kind: 'approve',
      reason: {
        has_rule_args: match.hasRuleArgs,
        match_strategy: match.strategy,
      },
    };
  }

  private matchSessionApprovalUnion(
    context: PermissionPolicyContext,
  ): PermissionPolicyResult | undefined {
    const cover = collectCoveredSubjects({
      rules: this.sessionRules(),
      toolName: context.toolCall.name,
      execution: context.execution,
    });
    if (cover?.fullyCovered !== true) return;
    return {
      kind: 'approve',
      reason: {
        has_rule_args: cover.firstMatch?.hasRuleArgs ?? false,
        match_strategy: cover.firstMatch?.strategy ?? 'matches_rule',
      },
    };
  }

  private sessionRules(): readonly PermissionRule[] {
    return this.agent.permission.sessionApprovalRules;
  }

  private matchSessionApprovalRule(
    context: PermissionPolicyContext,
  ): PermissionRuleMatch | undefined {
    for (const rule of this.agent.permission.sessionApprovalRules) {
      const match = matchPermissionRule({
        rule,
        toolName: context.toolCall.name,
        execution: context.execution,
      });
      if (match !== undefined) return match;
    }
  }
}

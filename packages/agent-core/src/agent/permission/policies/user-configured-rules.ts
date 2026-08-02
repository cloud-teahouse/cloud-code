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
  PermissionRuleDecision,
  PermissionRuleScope,
} from '../types';

const USER_CONFIGURED_SCOPES = new Set<PermissionRuleScope>([
  'turn-override',
  'project',
  'user',
]);

abstract class UserConfiguredPermissionPolicy {
  constructor(protected readonly agent: Agent) {}

  protected userConfiguredRules(decision: PermissionRuleDecision): PermissionRule[] {
    return this.agent.permission.data().rules.filter((rule): rule is PermissionRule =>
      USER_CONFIGURED_SCOPES.has(rule.scope) && rule.decision === decision,
    );
  }

  protected firstMatchingRule(
    context: PermissionPolicyContext,
    decision: PermissionRuleDecision,
  ): PermissionRuleMatch | undefined {
    for (const rule of this.userConfiguredRules(decision)) {
      const match = matchPermissionRule({
        rule,
        toolName: context.toolCall.name,
        execution: context.execution,
      });
      if (match !== undefined) return match;
    }
    return;
  }
}

export class UserConfiguredDenyPermissionPolicy
  extends UserConfiguredPermissionPolicy
  implements PermissionPolicy
{
  readonly name = 'user-configured-deny';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const match = this.firstMatchingRule(context, 'deny');
    if (match === undefined) return;
    return {
      kind: 'deny',
      reason: userRuleReason('deny', match),
      message: formatPermissionRuleDenyMessage(
        context.toolCall.name,
        match.rule.reason,
        this.agent.type,
      ),
    };
  }
}

export class UserConfiguredAllowPermissionPolicy
  extends UserConfiguredPermissionPolicy
  implements PermissionPolicy
{
  readonly name = 'user-configured-allow';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    // Decomposable executions (compound Bash commands): a single allow rule
    // must not approve the whole call. Approve only when the union of all
    // allow rules — session-runtime grants included, so a session grant and
    // a configured rule can each cover part of one compound command —
    // covers every segment (design doc §3.3).
    if (context.execution.ruleMatch !== undefined) {
      return this.evaluateUnionCover(context);
    }
    const match = this.firstMatchingRule(context, 'allow');
    if (match === undefined) return;
    return {
      kind: 'approve',
      reason: userRuleReason('allow', match),
    };
  }

  private evaluateUnionCover(
    context: PermissionPolicyContext,
  ): PermissionPolicyResult | undefined {
    const cover = collectCoveredSubjects({
      rules: this.allowUnionRules(),
      toolName: context.toolCall.name,
      execution: context.execution,
    });
    if (cover?.fullyCovered !== true || cover.firstMatch === undefined) return;
    return {
      kind: 'approve',
      reason: userRuleReason('allow', cover.firstMatch),
    };
  }

  private allowUnionRules(): PermissionRule[] {
    return [...this.agent.permission.sessionApprovalRules, ...this.userConfiguredRules('allow')];
  }
}

export class UserConfiguredAskPermissionPolicy
  extends UserConfiguredPermissionPolicy
  implements PermissionPolicy
{
  readonly name = 'user-configured-ask';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const match = this.firstMatchingRule(context, 'ask');
    if (match === undefined) return;
    return {
      kind: 'ask',
      reason: userRuleReason('ask', match),
    };
  }
}

function userRuleReason(decision: PermissionRuleDecision, match: PermissionRuleMatch) {
  return {
    rule_decision: decision,
    has_rule_args: match.hasRuleArgs,
    match_strategy: match.strategy,
  };
}

function formatPermissionRuleDenyMessage(
  tool: string,
  reason: string | undefined,
  agentType?: Agent['type'],
): string {
  const suffix = reason !== undefined && reason.length > 0 ? ` Reason: ${reason}` : '';
  if (agentType === 'sub') {
    return `Tool "${tool}" was denied.${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
  }
  return `Tool "${tool}" was denied by permission rule.${suffix}`;
}

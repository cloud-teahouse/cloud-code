import type { Agent } from '..';
import { resolveConfigPath } from '#/config';
import type { PrepareToolExecutionResult } from '../../loop';
import {
  ALWAYS_APPROVAL_RULE_REASON,
  persistAllowRulesToUserConfig,
} from './persist-always-rules';
import { createPermissionDecisionPolicies } from './policies';
import {
  GIT_MUTATION_GATE_APPROVAL_ACTION_PREFIX,
  GIT_MUTATION_GATE_POLICY_NAME,
} from './policies/git-mutation-gate';
import type {
  ApprovalResponse,
  PermissionApprovalResultRecord,
  PermissionData,
  PermissionMode,
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResolution,
  PermissionPolicyResult,
  PermissionRule,
  SessionApprovalGrant,
} from './types';

export * from './types';

export interface PermissionManagerOptions {
  readonly initialRules?: readonly PermissionRule[];
  readonly parent?: PermissionManager;
}

interface PolicyEvaluation {
  readonly policyName: string;
  readonly result: PermissionPolicyResolution;
}

export class PermissionManager {
  readonly policies: PermissionPolicy[];
  readonly rules: PermissionRule[] = [];
  private modeOverride: PermissionMode | undefined;
  private readonly parent: PermissionManager | undefined;
  private readonly localSessionApprovalGrants = new Map<string, SessionApprovalGrant>();
  /**
   * Monotonic counter bumped on every `localSessionApprovalGrants` mutation
   * (the map is private; `recordApprovalResult` is its only writer), so the
   * memoized derived views below invalidate exactly when the grants change.
   */
  private grantsVersion = 0;
  private sessionApprovalRulePatternsMemo:
    | {
        readonly grantsVersion: number;
        readonly parentPatterns: readonly string[] | undefined;
        readonly value: readonly string[];
      }
    | undefined;
  private sessionApprovalRulesMemo:
    | {
        readonly patterns: readonly string[];
        readonly value: readonly PermissionRule[];
      }
    | undefined;

  constructor(
    protected readonly agent: Agent,
    options: PermissionManagerOptions = {},
  ) {
    this.rules = [...(options.initialRules ?? [])];
    this.parent = options.parent;
    this.policies = createPermissionDecisionPolicies(this.agent);
  }

  get mode(): PermissionMode {
    return this.modeOverride ?? this.parent?.mode ?? 'manual';
  }

  set mode(mode: PermissionMode) {
    this.modeOverride = mode;
  }

  data(): PermissionData {
    return {
      mode: this.mode,
      rules: this.effectiveRules,
    };
  }

  setMode(mode: PermissionMode): void {
    this.agent.records.logRecord({
      type: 'permission.set_mode',
      mode,
    });
    this.agent.replayBuilder.push({
      type: 'permission_updated',
      mode,
    });
    this.modeOverride = mode;
    this.agent.emitStatusUpdated();
  }

  /**
   * Records an approval outcome and, for session-scoped approvals, stores
   * one grant per approved pattern with its provenance metadata (C3 P5,
   * design doc §3.4). Live callers pass `options.surface` (the deciding
   * policy names the surface); record replay goes through this same
   * function with no options and derives the metadata from the record's
   * existing fields — the wire schema is unchanged.
   */
  recordApprovalResult(
    record: PermissionApprovalResultRecord,
    options?: { readonly surface?: SessionApprovalGrant['surface'] },
  ): void {
    this.agent.records.logRecord({
      type: 'permission.record_approval_result',
      ...record,
    });
    this.agent.replayBuilder.push({
      type: 'approval_result',
      record,
    });
    if (record.result.decision !== 'approved' || record.result.scope !== 'session') {
      return;
    }
    const patterns =
      record.sessionApprovalRules ??
      (record.sessionApprovalRule !== undefined ? [record.sessionApprovalRule] : undefined);
    if (patterns === undefined) return;
    const surface = options?.surface ?? deriveSessionGrantSurface(record);
    for (const pattern of patterns) {
      this.localSessionApprovalGrants.set(pattern, {
        pattern,
        toolName: record.toolName,
        grantedAtTurnId: record.turnId,
        surface,
      });
    }
    this.grantsVersion += 1;
  }

  get sessionApprovalRulePatterns(): readonly string[] {
    // Re-derived per call in the naive form (spread of the grant keys plus the
    // parent chain) and evaluated by several policies on every tool call; the
    // grants map is append-rarely (one write per session-scoped approval), so
    // memoize on the grants version plus the parent's (itself memoized, hence
    // identity-stable) patterns. The returned array is shared — callers must
    // treat it as read-only.
    const parentPatterns = this.parent?.sessionApprovalRulePatterns;
    const memo = this.sessionApprovalRulePatternsMemo;
    if (
      memo !== undefined &&
      memo.grantsVersion === this.grantsVersion &&
      memo.parentPatterns === parentPatterns
    ) {
      return memo.value;
    }
    const value: readonly string[] = [
      ...this.localSessionApprovalGrants.keys(),
      ...(parentPatterns ?? []),
    ];
    this.sessionApprovalRulePatternsMemo = {
      grantsVersion: this.grantsVersion,
      parentPatterns,
      value,
    };
    return value;
  }

  /**
   * The session-approval grants expressed as allow rules (C3 P3 union-cover
   * input): one synthetic `session-runtime` rule per approved pattern, in the
   * same order as `sessionApprovalRulePatterns`. Built once per grants change
   * rather than once per tool call (three policies map the patterns into
   * identical rule objects on every evaluation). The returned array and its
   * rule objects are shared — callers must treat them as read-only.
   */
  get sessionApprovalRules(): readonly PermissionRule[] {
    const patterns = this.sessionApprovalRulePatterns;
    const memo = this.sessionApprovalRulesMemo;
    if (memo !== undefined && memo.patterns === patterns) return memo.value;
    const value: readonly PermissionRule[] = patterns.map((pattern) => ({
      decision: 'allow',
      scope: 'session-runtime',
      pattern,
      reason: 'approve for session',
    }));
    this.sessionApprovalRulesMemo = { patterns, value };
    return value;
  }

  /**
   * Session approval grants with provenance metadata (C3 P5): local grants
   * first, then the parent chain — same ordering as
   * `sessionApprovalRulePatterns`. Read-only data exposure; nothing renders
   * the grant list over RPC/TUI.
   */
  get sessionApprovalGrants(): readonly SessionApprovalGrant[] {
    return [
      ...this.localSessionApprovalGrants.values(),
      ...(this.parent?.sessionApprovalGrants ?? []),
    ];
  }

  async beforeToolCall(
    context: PermissionPolicyContext,
  ): Promise<PrepareToolExecutionResult | undefined> {
    const evaluation = await this.evaluatePolicies(context);
    if (evaluation === undefined) return undefined;

    return this.permissionPolicyResolutionToPrepare(
      evaluation.result,
      context,
      evaluation.policyName,
    );
  }

  /**
   * The team this agent's approval asks should be bridged through, or
   * undefined for non-teammates / teammates without a team or mailbox.
   */
  private teammateBridgeTeam(): string | undefined {
    const teammate = this.agent.teammate;
    if (teammate?.teamName === undefined) return undefined;
    if (this.agent.mailbox === null) return undefined;
    return teammate.teamName;
  }

  private async requestToolApproval(
    context: PermissionPolicyContext,
    result: Extract<PermissionPolicyResult, { kind: 'ask' }>,
    policyName: string | undefined,
  ): Promise<PrepareToolExecutionResult | undefined> {
    const { signal } = context;
    const id = context.toolCall.id;
    const name = context.toolCall.name;
    const display =
      context.execution.display ?? {
        kind: 'generic',
        summary: context.execution.description ?? `Approve ${name}`,
        detail: context.args,
      };
    const action =
      result.approvalAction ?? context.execution.description ?? `Call ${name}`;

    let response: ApprovalResponse;
    let requestedApproval = false;
    const bridgeTeam = this.teammateBridgeTeam();
    if (bridgeTeam !== undefined) {
      // Leader permission bridge: a teammate's ask rides the leader's
      // approval queue (badged) or the mailbox fallback — never the
      // teammate's own rpc, and never the silent auto-approve below.
      requestedApproval = true;
      void this.agent.hooks?.fireAndForgetTrigger?.('PermissionRequest', {
        matcherValue: name,
        inputData: {
          turnId: Number(context.turnId),
          toolCallId: id,
          toolName: name,
          action,
          toolInput: context.args,
          display,
        },
      });
      try {
        response = await this.agent.mailbox!.requestPermissionViaLeader({
          teamName: bridgeTeam,
          name: this.agent.teammate!.name,
          request: {
            turnId: Number(context.turnId),
            toolCallId: id,
            toolName: name,
            action,
            display,
            input: context.args,
          },
          signal,
        });
      } catch (error) {
        void this.agent.hooks?.fireAndForgetTrigger?.('PermissionResult', {
          matcherValue: name,
          inputData: {
            turnId: Number(context.turnId),
            toolCallId: id,
            toolName: name,
            action,
            decision: 'error',
            error: error instanceof Error ? error.message : String(error),
          },
        });
        const resolved = result.resolveError?.(error);
        return resolved === undefined
          ? Promise.reject(error)
          : this.permissionPolicyResolutionToPrepare(resolved, context, policyName);
      }
    } else if (this.agent.rpc?.requestApproval) {
      requestedApproval = true;
      void this.agent.hooks?.fireAndForgetTrigger?.('PermissionRequest', {
        matcherValue: name,
        inputData: {
          turnId: Number(context.turnId),
          toolCallId: id,
          toolName: name,
          action,
          toolInput: context.args,
          display,
        },
      });
      try {
        response = await this.agent.rpc.requestApproval(
          {
            turnId: Number(context.turnId),
            toolCallId: id,
            toolName: name,
            action,
            display,
          },
          { signal },
        );
      } catch (error) {
        void this.agent.hooks?.fireAndForgetTrigger?.('PermissionResult', {
          matcherValue: name,
          inputData: {
            turnId: Number(context.turnId),
            toolCallId: id,
            toolName: name,
            action,
            decision: 'error',
            error: error instanceof Error ? error.message : String(error),
          },
        });
        const resolved = result.resolveError?.(error);
        return resolved === undefined
          ? Promise.reject(error)
          : this.permissionPolicyResolutionToPrepare(resolved, context, policyName);
      }
    } else {
      response = {
        decision: 'approved',
      };
    }

    const approvedAlways = response.decision === 'approved' && response.scope === 'always';
    let alwaysRulesPersisted = false;
    if (approvedAlways) {
      // Decomposable tools (compound Bash) persist one rule per segment, same
      // as session-scope approval writes.
      const alwaysPatterns = context.execution.approvalRules ?? [
        context.execution.approvalRule,
      ];
      alwaysRulesPersisted = await this.tryPersistAlwaysApproval(alwaysPatterns);
      if (!alwaysRulesPersisted) {
        // Write-back failed (no config path, invalid config, fs error):
        // degrade to a session-scoped approval so the grant is still honored
        // for the rest of this session, and let the record/replay layer tell
        // the truth about what happened.
        response = { ...response, scope: 'session' };
      }
    }

    const approvedForSession = response.decision === 'approved' && response.scope === 'session';
    const sessionApprovalRule = approvedForSession ? context.execution.approvalRule : undefined;
    // Decomposable tools (compound Bash) approve into one rule per segment;
    // `sessionApprovalRule` keeps the primary rule for wire compatibility.
    const sessionApprovalRules = approvedForSession
      ? context.execution.approvalRules
      : undefined;

    if (requestedApproval) {
      void this.agent.hooks?.fireAndForgetTrigger?.('PermissionResult', {
        matcherValue: name,
        inputData: {
          turnId: Number(context.turnId),
          toolCallId: id,
          toolName: name,
          action,
          decision: response.decision,
          scope: response.scope,
          feedback: response.feedback,
          selectedLabel: response.selectedLabel,
        },
      });
    }

    this.recordApprovalResult(
      {
        turnId: Number(context.turnId),
        toolCallId: id,
        toolName: name,
        action,
        sessionApprovalRule,
        sessionApprovalRules,
        result: response,
      },
      {
        // Grant provenance (C3 P5): the deciding policy names the approval
        // surface — asks issued by the git mutation gate produce
        // gate-surfaced grants, everything else is a generic tool approval.
        surface:
          policyName === GIT_MUTATION_GATE_POLICY_NAME ? 'git-mutation-gate' : 'tool-approval',
      },
    );

    const resolved = result.resolveApproval?.(response);
    if (resolved !== undefined) {
      return this.permissionPolicyResolutionToPrepare(resolved, context, policyName);
    }

    if (response.decision === 'approved') {
      return undefined;
    }

    return {
      block: true,
      reason: this.formatApprovalRejectionMessage(name, response),
    };
  }

  /**
   * "Approve always" write-back (B2-1): persist the approved rule patterns to
   * the user config file as scope-`user` allow rules, then adopt them into the
   * root manager's in-memory rule list so they take effect immediately for
   * every agent chained under this session. Returns false — after emitting a
   * user-facing warning — when persistence fails (no brand home, invalid
   * existing config, fs error); the caller then degrades the approval to
   * session scope.
   */
  private async tryPersistAlwaysApproval(patterns: readonly string[]): Promise<boolean> {
    try {
      const brandHomeDir = this.agent.brandHomeDir;
      if (brandHomeDir === undefined) {
        throw new Error('user config path is unavailable (no brand home directory)');
      }
      const configPath = resolveConfigPath({ homeDir: brandHomeDir });
      await persistAllowRulesToUserConfig({
        configPath,
        patterns,
        reason: ALWAYS_APPROVAL_RULE_REASON,
      });
      this.adoptAlwaysApprovalRules(patterns);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        this.agent.log.warn('approve-always rule persistence failed; degrading to session', {
          error: message,
        });
      } catch {
        // diagnostics must never block a permission decision
      }
      try {
        const delivery = this.agent.rpc?.emitEvent?.({
          type: 'warning',
          code: 'permission-always-persist-failed',
          message:
            `Could not save the permission rule to the user config (${message}). ` +
            'It will be remembered for this session only.',
        });
        void delivery?.catch(() => {});
      } catch {
        // diagnostics must never block a permission decision
      }
      return false;
    }
  }

  /**
   * Adopt freshly-persisted always rules into the ROOT manager's rule list:
   * sub-agent managers chain `effectiveRules` through their parents, so one
   * adoption covers every agent of the session. Patterns already present as
   * allow rules (from config or an earlier approval) are skipped.
   */
  private adoptAlwaysApprovalRules(patterns: readonly string[]): void {
    const root = this.rootManager;
    const known = new Set(
      root.effectiveRules.filter((rule) => rule.decision === 'allow').map((rule) => rule.pattern),
    );
    for (const pattern of patterns) {
      if (known.has(pattern)) continue;
      known.add(pattern);
      root.rules.push({
        decision: 'allow',
        scope: 'user',
        pattern,
        reason: ALWAYS_APPROVAL_RULE_REASON,
      });
    }
  }

  private get rootManager(): PermissionManager {
    return this.parent === undefined ? this : this.parent.rootManager;
  }

  /**
   * Sandbox escalation channel (F1): the Bash tool calls this after a
   * sandboxed command exits with a sandbox-denial signature, asking whether
   * the command may be retried once without the sandbox. Reuses the same
   * RPC approval mechanism as `requestToolApproval`, but deliberately does
   * NOT write session approval rules — "approve for session" is remembered
   * by the Bash tool as a full-command-string exemption set, because a
   * `Bash(<glob>)` rule would also waive the sandbox for future *sandboxed*
   * runs, which is not the semantics we want.
   *
   * Fail-safe defaults: with no interactive approval channel (e.g. headless
   * print mode) or on RPC error, the answer is 'reject' — the sandbox is
   * never dropped silently. `sandbox.escalation = 'always'` bypasses this
   * method entirely at the call site.
   */
  async requestSandboxEscalation(info: {
    readonly command: string;
    readonly reason: string;
    readonly turnId: string;
    readonly toolCallId: string;
    readonly signal: AbortSignal;
    /**
     * Tool name shown in the approval prompt and records. Defaults to
     * 'Bash'; ExecSession passes its own name so the prompt attributes the
     * request to the session tool.
     */
    readonly toolName?: string;
    /**
     * Prompt wording override. Defaults to the one-shot Bash retry text;
     * ExecSession supplies wording that makes clear the approval creates a
     * *persistent* unsandboxed session (RFC unified-exec-pty §3.4).
     */
    readonly action?: string;
  }): Promise<'once' | 'session' | 'reject'> {
    const name = info.toolName ?? 'Bash';
    const action =
      info.action ??
      `Command was denied by the OS sandbox (${info.reason}). Retry once without the sandbox?`;
    const display = {
      kind: 'command' as const,
      command: info.command,
      language: 'bash' as const,
    };

    if (!this.agent.rpc?.requestApproval) {
      return 'reject';
    }

    void this.agent.hooks?.fireAndForgetTrigger?.('PermissionRequest', {
      matcherValue: name,
      inputData: {
        turnId: Number(info.turnId),
        toolCallId: info.toolCallId,
        toolName: name,
        action,
        toolInput: { command: info.command },
        display,
      },
    });

    let response: ApprovalResponse;
    try {
      response = await this.agent.rpc.requestApproval(
        {
          turnId: Number(info.turnId),
          toolCallId: info.toolCallId,
          toolName: name,
          action,
          display,
        },
        { signal: info.signal },
      );
    } catch (error) {
      void this.agent.hooks?.fireAndForgetTrigger?.('PermissionResult', {
        matcherValue: name,
        inputData: {
          turnId: Number(info.turnId),
          toolCallId: info.toolCallId,
          toolName: name,
          action,
          decision: 'error',
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return 'reject';
    }

    void this.agent.hooks?.fireAndForgetTrigger?.('PermissionResult', {
      matcherValue: name,
      inputData: {
        turnId: Number(info.turnId),
        toolCallId: info.toolCallId,
        toolName: name,
        action,
        decision: response.decision,
        scope: response.scope,
        feedback: response.feedback,
        selectedLabel: response.selectedLabel,
      },
    });
    // No sessionApprovalRule on purpose: session-scoped memory for sandbox
    // escalation lives in the Bash tool's command-string exemption set.
    this.recordApprovalResult({
      turnId: Number(info.turnId),
      toolCallId: info.toolCallId,
      toolName: name,
      action,
      result: response,
    });

    if (response.decision !== 'approved') return 'reject';
    return response.scope === 'session' ? 'session' : 'once';
  }

  private async evaluatePolicies(
    context: PermissionPolicyContext,
  ): Promise<PolicyEvaluation | undefined> {
    for (const policy of this.policies) {
      const result = await policy.evaluate(context);
      if (result !== undefined) {
        return { policyName: policy.name, result };
      }
    }
    return undefined;
  }

  private get effectiveRules(): PermissionRule[] {
    return [...this.rules, ...(this.parent?.effectiveRules ?? [])];
  }

  private permissionPolicyResolutionToPrepare(
    result: PermissionPolicyResolution,
    context: PermissionPolicyContext,
    policyName?: string,
  ): Promise<PrepareToolExecutionResult | undefined> | PrepareToolExecutionResult | undefined {
    switch (result.kind) {
      case 'approve':
        return result.executionMetadata === undefined
          ? undefined
          : { executionMetadata: result.executionMetadata };
      case 'deny':
        return {
          block: true,
          reason: result.message ?? this.formatPolicyDenyMessage(context.toolCall.name),
        };
      case 'ask':
        return this.requestToolApproval(context, result, policyName);
      case 'result': {
        const { kind: _kind, ...prepareResult } = result;
        return prepareResult;
      }
    }
  }

  protected formatApprovalRejectionMessage(
    toolName: string,
    result: { decision: 'approved' | 'rejected' | 'cancelled'; feedback?: string },
  ): string {
    const suffix =
      result.feedback !== undefined && result.feedback.length > 0
        ? ` Reason: ${result.feedback}`
        : '';
    const prefix =
      result.decision === 'cancelled'
        ? `Tool "${toolName}" was not run because the approval request was cancelled.`
        : `Tool "${toolName}" was not run because the user rejected the approval request.`;
    if (this.agent.type === 'sub') {
      return `${prefix}${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    if (result.decision === 'rejected') {
      return `${prefix}${suffix} Do not re-attempt the exact same call — think about why it was rejected, then adjust your approach or ask the user what they would prefer.`;
    }
    return `${prefix}${suffix}`;
  }

  private formatPolicyDenyMessage(toolName: string): string {
    const prefix = `Tool "${toolName}" was denied by permission policy.`;
    if (this.agent.type === 'sub') {
      return `${prefix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return prefix;
  }
}

/**
 * Replay fallback for the grant surface (C3 P5): the wire record schema
 * carries no surface field, so a replayed grant's surface is derived from
 * the recorded approval prompt — the git mutation gate's asks always lead
 * with its prefix. Records written before the gate existed (or by any
 * other approval surface) fall back to 'tool-approval'.
 */
function deriveSessionGrantSurface(
  record: PermissionApprovalResultRecord,
): SessionApprovalGrant['surface'] {
  return record.action.startsWith(GIT_MUTATION_GATE_APPROVAL_ACTION_PREFIX)
    ? 'git-mutation-gate'
    : 'tool-approval';
}

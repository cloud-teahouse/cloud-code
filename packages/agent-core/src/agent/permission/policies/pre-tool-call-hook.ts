import type { Agent } from '../..';
import { isPlainRecord } from '../../turn/canonical-args';
import type {
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResolution,
} from '../types';

/**
 * Fires the PreToolUse hooks and maps their structured outcome onto a
 * permission decision:
 *   - `permissionDecision: 'deny'` (or exit code 2) → deny the call;
 *   - `permissionDecision: 'ask'` → escalate to the human approval broker
 *     instead of letting any auto-approve policy decide;
 *   - `updatedInput` → rewrite this call's args (flows through
 *     `PrepareToolExecutionResult.updatedArgs`; the loop re-validates and
 *     re-resolves the execution with the new input).
 * A hook returning `allow` — or nothing structured — does not short-circuit
 * the remaining policies.
 */
export class PreToolCallHookPermissionPolicy implements PermissionPolicy {
  readonly name = 'pre-tool-call-hook';

  constructor(private readonly agent: Agent) {}

  async evaluate(
    context: PermissionPolicyContext,
  ): Promise<PermissionPolicyResolution | undefined> {
    const results = await this.agent.hooks?.trigger('PreToolUse', {
      matcherValue: context.toolCall.name,
      signal: context.signal,
      inputData: {
        toolName: context.toolCall.name,
        toolInput: isPlainRecord(context.args) ? context.args : {},
        toolCallId: context.toolCall.id,
      },
      // `if` conditions evaluate against the already-resolved execution's rule
      // matchers, so a non-matching hook never spawns a process.
      ifContext: { toolName: context.toolCall.name, execution: context.execution },
    });
    context.signal.throwIfAborted();
    if (results === undefined || results.length === 0) return undefined;

    // deny beats every other hook outcome (and every later policy).
    const block = results.find((result) => result.action === 'block');
    if (block !== undefined) {
      const reason = block.reason?.trim();
      return {
        kind: 'deny',
        message:
          reason === undefined || reason.length === 0 ? 'Blocked by PreToolUse hook' : reason,
      };
    }

    const updatedInput = results.find(
      (result) => result.updatedInput !== undefined,
    )?.updatedInput;

    if (results.some((result) => result.permissionDecision === 'ask')) {
      return {
        kind: 'ask',
        // Approval keeps any hook-provided input rewrite; a rejection falls
        // back to the standard rejection handling (no resolution).
        resolveApproval: (response) =>
          response.decision === 'approved' && updatedInput !== undefined
            ? { kind: 'result', updatedArgs: updatedInput }
            : undefined,
      };
    }

    if (updatedInput !== undefined) {
      return { kind: 'result', updatedArgs: updatedInput };
    }
    return undefined;
  }
}

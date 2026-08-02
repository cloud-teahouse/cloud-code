/**
 * Tool-call lifecycle for one completed provider response.
 *
 * This module keeps the provider-order invariant in one place:
 *   - validate every provider tool call before hooks or events
 *   - run preparation hooks and compute tool-call display fields in provider order
 *   - dispatch `tool.call` before execution starts
 *   - execute tools with non-conflicting resource accesses concurrently
 *   - serialize tools whose resource accesses conflict
 *   - dispatch terminal `tool.result` events in provider order
 *
 * These phases are coupled by transcript ordering and abort handling, so they
 * should be reviewed together.
 *
 * Streaming tool execution (StreamingToolCallRunner) may run the validation,
 * hook, and read-only execution phases for a call while the provider stream
 * is still open. Only execution start is advanced: every recorded event stays
 * on the post-stream, provider-order drain described above.
 */

import type { ContentPart } from '@cloud-code/kosong';

import type { Logger } from '#/logging/types';
import {
  compileToolArgsValidator,
  validateToolArgs,
  type JsonType,
  type ToolArgsValidator,
} from '../tools/args-validator';
import { PathSecurityError } from '../tools/policies/path-access';

import { isUserCancellation } from '../utils/abort';
import { errorMessage, isAbortError } from './errors';
import type {
  LoopEvent,
  LoopEventDispatcher,
  LoopToolCallEvent,
  LoopToolProgressEvent,
} from './events';
import { parseToolCallArguments } from './tool-args-parse';
import type { LLM, LLMChatResponse, LLMRequestTrace } from './llm';
import { ToolAccesses } from './tool-access';
import { ToolScheduler, type ToolCallTask } from './tool-scheduler';
import type { ToolResultDisplayRef, ToolResultStructured } from '../tools/display';
import type {
  AuthorizeToolExecutionResult,
  ExecutableTool,
  LoopHooks,
  ToolCall,
  PrepareToolExecutionResult,
  ExecutableToolResult,
  RunnableToolExecution,
  ToolExecution,
} from './types';

const GRACE_TIMEOUT_MS = 2_000;
const TOOL_OUTPUT_EMPTY = 'Tool output is empty.';
const TOOL_OUTPUT_NON_TEXT = 'Tool returned non-text content.';

/**
 * Output for a tool call the step never executed: the provider stream broke
 * off (paused / overloaded / token limit), so running the call — whose
 * arguments may be truncated mid-stream — would be unsafe. The wording tells
 * the model the call did not run and invites a clean re-issue instead of
 * assumptions about the outcome.
 */
const UNEXECUTED_TOOL_CALL_OUTPUT =
  'This tool call was not executed: the model response ended before tool execution could start ' +
  '(the provider stream was interrupted). Do not assume the tool ran — ' +
  're-issue the call if it is still needed.';

const validators = new WeakMap<ExecutableTool, ToolArgsValidator>();

/**
 * Output for an aborted tool call. When the abort carries a user-cancellation
 * reason (the user pressed stop), say so explicitly so the model treats it as a
 * deliberate interruption instead of a system fault to theorise about or retry.
 * Any other abort keeps the neutral wording.
 */
function abortedToolOutput(toolName: string, signal: AbortSignal): string {
  if (isUserCancellation(signal.reason)) {
    return `The user manually interrupted "${toolName}" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user's next instruction.`;
  }
  return `Tool "${toolName}" was aborted`;
}

export interface ToolCallStepContext {
  readonly tools?: readonly ExecutableTool[] | undefined;
  /** See RunTurnInput.describeMissingTool. */
  readonly describeMissingTool?: ((name: string) => string | undefined) | undefined;
  readonly hooks?: LoopHooks | undefined;
  readonly log?: Logger | undefined;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly llm: LLM;
  readonly signal: AbortSignal;
  readonly turnId: string;
  readonly currentStep: number;
  readonly stepUuid: string;
  readonly trace: LLMRequestTrace;
}

interface ToolCallBatchContext extends ToolCallStepContext {
  readonly toolCalls: readonly ToolCall[];
}

type PreflightedToolCall = RunnableToolCall | RejectedToolCall;

interface RunnableToolCall {
  readonly kind: 'runnable';
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly tool: ExecutableTool;
  readonly args: unknown;
}

interface RejectedToolCall {
  readonly kind: 'rejected';
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly output: string;
}

type PrepareToolExecutionDecision =
  | { readonly kind: 'allowed'; readonly args: unknown; readonly metadata?: unknown }
  | { readonly kind: 'synthetic'; readonly args: unknown; readonly result: ExecutableToolResult }
  | { readonly kind: 'blocked'; readonly args: unknown; readonly output: string }
  | { readonly kind: 'hookFailed'; readonly args: unknown; readonly output: string };

interface PendingToolResult {
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: ExecutableToolResult;
  readonly stopTurn?: boolean | undefined;
}

interface PreparedToolCallTask {
  readonly task: ToolCallTask<PendingToolResult>;
  readonly stopBatchAfterThis?: boolean | undefined;
}

type ToolCallDisplayFields = Pick<LoopToolCallEvent, 'description' | 'display'>;

export interface ToolCallBatchResult {
  readonly stopTurn: boolean;
}

/**
 * Give every tool call in one provider response a unique id, deterministically.
 *
 * The loop — and everything downstream of it (transcript uuids, host dedup
 * registrations, pending-result tracking in history) — assumes per-response id
 * uniqueness, but kosong deliberately passes duplicate ids from lax providers
 * through verbatim. A repeated id is fatal twice over: host same-step dedup
 * mistakes the original call's finalization for its duplicate's and awaits a
 * deferred only its own finalization could resolve (an ESC-proof deadlock),
 * and history recording silently drops the second same-id `tool.result`.
 *
 * Renaming the Nth occurrence of an id to `<id>_N` at the batch entry fixes
 * both: the loop-recorded `tool.call` id doubles as the tool_use id persisted
 * to history, so the rename is fully transparent to the provider. The mapping
 * preserves provider order and is idempotent — already-unique input passes
 * through unchanged (same array reference).
 */
function uniquifyToolCallIds(
  step: Pick<ToolCallStepContext, 'log' | 'turnId' | 'currentStep'>,
  toolCalls: readonly ToolCall[],
): readonly ToolCall[] {
  const used = new Set<string>();
  let renamedCount = 0;
  const out: ToolCall[] = [];
  for (const toolCall of toolCalls) {
    let id = toolCall.id;
    if (used.has(id)) {
      let suffix = 2;
      while (used.has(`${id}_${String(suffix)}`)) suffix += 1;
      id = `${id}_${String(suffix)}`;
      renamedCount += 1;
    }
    used.add(id);
    out.push(id === toolCall.id ? toolCall : { ...toolCall, id });
  }
  if (renamedCount === 0) return toolCalls;
  step.log?.warn('renamed duplicate provider tool-call ids', {
    turnId: step.turnId,
    step: step.currentStep,
    renamedCount,
    callCount: toolCalls.length,
  });
  return out;
}

export async function runToolCallBatch(
  step: ToolCallStepContext,
  response: LLMChatResponse,
  streaming?: StreamingToolCallRunner,
): Promise<ToolCallBatchResult> {
  if (response.toolCalls.length === 0) {
    if (streaming === undefined || !streaming.hasEntries) return { stopTurn: false };
    // The final response carries no tool calls, but a failed earlier attempt
    // of this step streamed some (retried/resend requests re-stream from
    // scratch). Settle those orphaned preparations so host hook state unwinds.
    await streaming.drainOrphanedPreparations({ ...step, toolCalls: [] }, []);
    return { stopTurn: false };
  }
  const toolCalls = uniquifyToolCallIds(step, response.toolCalls);
  const batchStep: ToolCallBatchContext = { ...step, toolCalls };
  const scheduler = streaming?.scheduler ?? new ToolScheduler<PendingToolResult>();
  const pendingResults: Array<Promise<PendingToolResult>> = [];
  let stopTurn = false;

  try {
    if (streaming !== undefined) {
      // Settle preparations from failed attempts of this step BEFORE draining
      // the final response: a retried call whose args match an orphan is
      // classified as a same-step duplicate by host dedup hooks and its
      // finalization awaits the orphan's result.
      await streaming.drainOrphanedPreparations(batchStep, toolCalls);
    }

    for (let index = 0; index < toolCalls.length; index += 1) {
      const toolCall = toolCalls[index]!;
      const materialized =
        streaming === undefined ? undefined : await streaming.materialize(batchStep, toolCall);
      const prepared =
        materialized ?? (await prepareToolCall(batchStep, preflightToolCall(step, toolCall)));
      pendingResults.push(scheduler.add(prepared.task));

      if (prepared.stopBatchAfterThis === true) {
        stopTurn = true;
        for (const skippedCall of toolCalls.slice(index + 1)) {
          const skippedEntry =
            streaming === undefined ? undefined : await streaming.takeEntry(skippedCall.id);
          // A runner that saw a batch-stopping call marks every later
          // streamed call 'skipped' without running hooks; any other entry
          // kind cannot appear past a stop (defensive fallback: plain skip).
          const skippedPreflight =
            skippedEntry !== undefined && skippedEntry.kind === 'skipped'
              ? skippedEntry.preflighted
              : preflightToolCall(step, skippedCall);
          const skippedTask = await prepareSkippedToolCall(batchStep, skippedPreflight);
          pendingResults.push(scheduler.add(skippedTask));
        }
        break;
      }
    }

    // Tool tasks may finish out of order; terminal results are still emitted in
    // provider order. Await all tasks so each recorded `tool.call` gets a
    // paired `tool.result`; the caller checks abort before writing `step.end`.
    for (const pendingResult of pendingResults) {
      const result = await finalizePendingToolResult(batchStep, await pendingResult);
      if (result.stopTurn === true) stopTurn = true;
      await dispatchToolResult(batchStep, result);
    }
  } finally {
    // Preparation or result dispatch can throw after execution has started.
    // Always settle spawned tasks before the caller continues so rejected
    // execute promises cannot surface as detached unhandled rejections.
    await Promise.allSettled(pendingResults);
  }
  return { stopTurn };
}

/**
 * Record tool calls from a response the step will NOT execute: the provider
 * stream broke off (paused / overloaded / token limit), so running the calls
 * — whose arguments may be truncated mid-stream — would be unsafe. Dropping
 * them silently is not an option either: it loses the model's intent and,
 * when the response carried no other usable content, persists an assistant
 * message strict providers reject as empty. Each call is recorded with
 * sanitized arguments (unparseable JSON, e.g. truncated by an interrupted
 * stream, becomes `{}`) and immediately closed with a synthetic error result,
 * so the exchange stays wire-valid and the model learns the calls never ran.
 */
export async function recordUnexecutedToolCalls(
  step: ToolCallStepContext,
  response: LLMChatResponse,
): Promise<void> {
  for (const toolCall of response.toolCalls) {
    await recordUnexecutedToolCall(step, toolCall);
  }
}

/**
 * Close a single never-executed call with the synthetic interrupted result.
 * Shared by the no-streaming path and the interrupted-stream drain, which
 * applies it to calls the runner never started.
 */
async function recordUnexecutedToolCall(
  step: ToolCallStepContext,
  toolCall: ToolCall,
): Promise<void> {
  const parsedArgs = parseToolCallArguments(toolCall.arguments);
  if (parsedArgs.parseFailed) {
    step.log?.debug('recording unexecuted tool call with unparseable arguments', {
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      rawLength: toolCall.arguments?.length ?? 0,
      error: parsedArgs.error,
    });
  }
  await step.dispatchEvent({
    type: 'tool.call',
    uuid: toolCall.id,
    turnId: step.turnId,
    step: step.currentStep,
    stepUuid: step.stepUuid,
    toolCallId: toolCall.id,
    name: toolCall.name,
    args: parsedArgs.data,
    extras: toolCall.extras,
    traceId: step.trace.traceId,
  });
  await step.dispatchEvent({
    type: 'tool.result',
    parentUuid: toolCall.id,
    toolCallId: toolCall.id,
    result: { output: UNEXECUTED_TOOL_CALL_OUTPUT, isError: true },
    traceId: step.trace.traceId,
  });
}

/**
 * Close out a response whose stream broke off (paused / overloaded / token
 * limit) while streaming execution was active. Calls the runner already
 * started complete for real — their arguments were provably complete — and
 * everything else is closed with the synthetic unexecuted result, in strict
 * provider order, so no `tool_use` is left dangling.
 */
export async function drainInterruptedToolCalls(
  step: ToolCallStepContext,
  response: LLMChatResponse,
  streaming: StreamingToolCallRunner,
): Promise<void> {
  const toolCalls = uniquifyToolCallIds(step, response.toolCalls);
  const batchStep: ToolCallBatchContext = { ...step, toolCalls };
  await streaming.drainOrphanedPreparations(batchStep, toolCalls);
  for (const toolCall of toolCalls) {
    const entry = await streaming.takeEntry(toolCall.id);
    if (entry === undefined || entry.kind === 'skipped') {
      await recordUnexecutedToolCall(step, toolCall);
      continue;
    }
    switch (entry.kind) {
      case 'settled': {
        await entry.announce();
        await finalizeAndDispatchToolResult(batchStep, entry.result);
        continue;
      }
      case 'started': {
        await entry.announce();
        await finalizeAndDispatchToolResult(batchStep, await entry.pending);
        continue;
      }
      case 'deferred': {
        // Prepared (hooks ran) but never authorized or started: do not begin
        // new work on a broken stream. Finalize with the unexecuted result so
        // mid-stream hook registrations (e.g. same-step dedup) still settle.
        await entry.preparation.announce();
        await finalizeAndDispatchToolResult(
          batchStep,
          makeErrorToolResult(
            entry.preparation.call,
            entry.preparation.args,
            UNEXECUTED_TOOL_CALL_OUTPUT,
          ),
        );
        continue;
      }
    }
  }
}

/**
 * Provider-order validation pass. It does not run hooks, spawn tools, or write
 * events. Validator compilation may populate the local cache.
 */
function preflightToolCall(
  step: Pick<ToolCallStepContext, 'tools' | 'describeMissingTool' | 'log'>,
  toolCall: ToolCall,
): PreflightedToolCall {
  const toolName = toolCall.name;
  const parsedArgs = parseToolCallArguments(toolCall.arguments);
  const tool = step.tools?.find((candidate) => candidate.name === toolName);
  if (tool === undefined) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: step.describeMissingTool?.(toolName) ?? `Tool "${toolName}" not found`,
    };
  }

  if (parsedArgs.parseFailed) {
    step.log?.debug('tool args JSON parse failed', {
      toolName,
      toolCallId: toolCall.id,
      rawLength: toolCall.arguments?.length ?? 0,
      error: parsedArgs.error,
    });
  }

  const validationError = validateExecutableToolArgs(tool, parsedArgs.data);
  if (validationError !== null) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: `Invalid args for tool "${toolName}": ${validationError}`,
    };
  }
  return { kind: 'runnable', toolCall, toolName, tool, args: parsedArgs.data };
}

function validateExecutableToolArgs(tool: ExecutableTool, args: unknown): string | null {
  let validator = validators.get(tool);
  if (validator === undefined) {
    try {
      validator = compileToolArgsValidator(tool.parameters);
      validators.set(tool, validator);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return validateToolArgs(validator, args as JsonType);
}

interface SettledToolCallPreparation {
  readonly kind: 'settled';
  readonly result: PendingToolResult;
  readonly stopBatchAfterThis?: boolean | undefined;
  readonly announce: () => Promise<void>;
}

/**
 * A call that passed validation, the prepare hook, and execution resolution;
 * only authorization and scheduling remain. Splitting preparation here lets
 * streaming execution run the early phases the moment a call's arguments
 * complete mid-stream, while deferring authorization/scheduling for calls
 * that are not eligible for an early start.
 */
interface RunnableToolCallPreparation {
  readonly kind: 'runnable';
  readonly call: RunnableToolCall;
  readonly args: unknown;
  readonly execution: RunnableToolExecution;
  readonly metadata: unknown;
  readonly displayFields: ToolCallDisplayFields | undefined;
  readonly announce: () => Promise<void>;
}

type AuthorizedToolCallPreparation =
  | SettledToolCallPreparation
  | {
      readonly kind: 'authorized';
      readonly task: ToolCallTask<PendingToolResult>;
      readonly stopBatchAfterThis?: boolean | undefined;
      readonly announce: () => Promise<void>;
    };

async function prepareToolCall(
  step: ToolCallBatchContext,
  call: PreflightedToolCall,
): Promise<PreparedToolCallTask> {
  const preparation = await resolveToolCallPreparation(step, call);
  if (preparation.kind === 'settled') {
    await preparation.announce();
    return {
      task: makeResolvedToolCallTask(preparation.result),
      stopBatchAfterThis: preparation.stopBatchAfterThis,
    };
  }
  const authorized = await authorizeToolCallPreparation(step, preparation);
  await authorized.announce();
  if (authorized.kind === 'settled') {
    return {
      task: makeResolvedToolCallTask(authorized.result),
      stopBatchAfterThis: authorized.stopBatchAfterThis,
    };
  }
  return { task: authorized.task, stopBatchAfterThis: authorized.stopBatchAfterThis };
}

function settlePreparationError(
  step: ToolCallStepContext,
  call: PreflightedToolCall,
  args: unknown,
  output: string,
  displayFields?: ToolCallDisplayFields,
): SettledToolCallPreparation {
  return {
    kind: 'settled',
    result: makeErrorToolResult(call, args, output),
    announce: async () => dispatchToolCall(step, call, args, displayFields),
  };
}

function settlePreparationSynthetic(
  step: ToolCallStepContext,
  call: PreflightedToolCall,
  args: unknown,
  result: ExecutableToolResult,
  displayFields?: ToolCallDisplayFields,
): SettledToolCallPreparation {
  const coerced = coerceToolResult(result, call.toolName);
  return {
    kind: 'settled',
    result: makeToolResult(call, args, coerced),
    stopBatchAfterThis: toolResultStopsTurn(coerced),
    announce: async () => dispatchToolCall(step, call, args, displayFields),
  };
}

/**
 * First preparation phase: prepare hook, arg re-validation, and execution
 * resolution. Runs no authorization and starts no execution. The returned
 * `announce` performs the `tool.call` dispatch the batch path expects at
 * preparation time; callers deferring visibility invoke it later.
 */
async function resolveToolCallPreparation(
  step: ToolCallBatchContext,
  call: PreflightedToolCall,
): Promise<SettledToolCallPreparation | RunnableToolCallPreparation> {
  if (call.kind === 'rejected') return settlePreparationError(step, call, call.args, call.output);

  const decision = await runPrepareToolExecutionHook(step, call);
  if (decision.kind === 'blocked' || decision.kind === 'hookFailed') {
    return settlePreparationError(step, call, decision.args, decision.output);
  }
  if (decision.kind === 'synthetic') {
    return settlePreparationSynthetic(step, call, decision.args, decision.result);
  }

  const validationError = validateExecutableToolArgs(call.tool, decision.args);
  if (validationError !== null) {
    return settlePreparationError(
      step,
      call,
      decision.args,
      `Invalid args for tool "${call.toolName}" after prepareToolExecution hook: ${validationError}`,
    );
  }

  const effectiveArgs = decision.args;
  let execution: ToolExecution;
  try {
    execution = await call.tool.resolveExecution(effectiveArgs);
  } catch (error) {
    if (!(error instanceof PathSecurityError)) {
      step.log?.warn('tool execution setup failed', {
        toolName: call.toolName,
        toolCallId: call.toolCall.id,
        error,
      });
    }
    const output =
      error instanceof PathSecurityError
        ? error.message
        : `Tool "${call.toolName}" failed to resolve execution: ${errorMessage(error)}`;
    return settlePreparationError(step, call, effectiveArgs, output);
  }

  const displayFields = toolCallDisplayFieldsFromExecution(execution);

  if (step.signal.aborted) {
    return settlePreparationError(
      step,
      call,
      effectiveArgs,
      abortedToolOutput(call.toolName, step.signal),
      displayFields,
    );
  }

  if (execution.isError === true) {
    return settlePreparationSynthetic(step, call, effectiveArgs, execution, displayFields);
  }

  return {
    kind: 'runnable',
    call,
    args: effectiveArgs,
    execution,
    metadata: decision.metadata,
    displayFields,
    announce: async () => dispatchToolCall(step, call, effectiveArgs, displayFields),
  };
}

/**
 * Second preparation phase: the authorize hook, then either a terminal
 * settle (blocked / synthetic / aborted) or a scheduler-ready task.
 */
async function authorizeToolCallPreparation(
  step: ToolCallBatchContext,
  preparation: RunnableToolCallPreparation,
): Promise<AuthorizedToolCallPreparation> {
  const { call, displayFields } = preparation;
  let { args, execution } = preparation;
  const authorization = await runAuthorizeToolExecutionHook(step, call, args, execution);

  if (step.signal.aborted) {
    return settlePreparationError(
      step,
      call,
      args,
      abortedToolOutput(call.toolName, step.signal),
      displayFields,
    );
  }

  if (authorization?.block === true) {
    return settlePreparationError(
      step,
      call,
      args,
      authorization.reason ?? `Tool call "${call.toolName}" was blocked`,
      displayFields,
    );
  }

  if (authorization?.syntheticResult !== undefined) {
    return settlePreparationSynthetic(
      step,
      call,
      args,
      authorization.syntheticResult,
      displayFields,
    );
  }

  let announce = preparation.announce;
  if (authorization?.updatedArgs !== undefined) {
    const rewritten = await reResolveUpdatedExecution(
      step,
      call,
      authorization.updatedArgs,
      displayFields,
    );
    if (rewritten.kind === 'settled') return rewritten;
    args = rewritten.args;
    execution = rewritten.execution;
    announce = rewritten.announce;
  }

  const executionMetadata = authorization?.executionMetadata ?? preparation.metadata;
  return {
    kind: 'authorized',
    task: {
      accesses: execution.accesses ?? ToolAccesses.all(),
      start: async () => ({
        result: runRunnableToolCall(step, call, args, executionMetadata, execution),
      }),
    },
    stopBatchAfterThis: execution.stopBatchAfterThis,
    announce,
  };
}

/**
 * Re-validate and re-resolve an execution when the authorize hook rewrote the
 * call's args (e.g. a PreToolUse hook's `updatedInput`). Mirrors the prepare
 * phase's validation/resolution failure semantics; the announce closure is
 * rebuilt so the recorded `tool.call` shows the args that actually run.
 */
async function reResolveUpdatedExecution(
  step: ToolCallBatchContext,
  call: RunnableToolCall,
  updatedArgs: unknown,
  displayFields: ToolCallDisplayFields | undefined,
): Promise<
  | SettledToolCallPreparation
  | {
      readonly kind: 'resolved';
      readonly args: unknown;
      readonly execution: RunnableToolExecution;
      readonly announce: () => Promise<void>;
    }
> {
  const validationError = validateExecutableToolArgs(call.tool, updatedArgs);
  if (validationError !== null) {
    return settlePreparationError(
      step,
      call,
      updatedArgs,
      `Invalid args for tool "${call.toolName}" after authorizeToolExecution hook: ${validationError}`,
      displayFields,
    );
  }

  let execution: ToolExecution;
  try {
    execution = await call.tool.resolveExecution(updatedArgs);
  } catch (error) {
    if (!(error instanceof PathSecurityError)) {
      step.log?.warn('tool execution setup failed', {
        toolName: call.toolName,
        toolCallId: call.toolCall.id,
        error,
      });
    }
    const output =
      error instanceof PathSecurityError
        ? error.message
        : `Tool "${call.toolName}" failed to resolve execution: ${errorMessage(error)}`;
    return settlePreparationError(step, call, updatedArgs, output, displayFields);
  }

  const updatedDisplayFields = toolCallDisplayFieldsFromExecution(execution) ?? displayFields;

  if (step.signal.aborted) {
    return settlePreparationError(
      step,
      call,
      updatedArgs,
      abortedToolOutput(call.toolName, step.signal),
      updatedDisplayFields,
    );
  }

  if (execution.isError === true) {
    return settlePreparationSynthetic(step, call, updatedArgs, execution, updatedDisplayFields);
  }

  return {
    kind: 'resolved',
    args: updatedArgs,
    execution,
    announce: async () => dispatchToolCall(step, call, updatedArgs, updatedDisplayFields),
  };
}

async function prepareSkippedToolCall(
  step: ToolCallBatchContext,
  call: PreflightedToolCall,
): Promise<ToolCallTask<PendingToolResult>> {
  const output = 'Tool skipped because a previous tool call stopped the turn.';
  await dispatchToolCall(step, call, call.args);
  return makeResolvedToolCallTask(makeErrorToolResult(call, call.args, output));
}

function makeResolvedToolCallTask(result: PendingToolResult): ToolCallTask<PendingToolResult> {
  return {
    accesses: ToolAccesses.none(),
    start: async () => ({ result: Promise.resolve(result) }),
  };
}

async function dispatchToolResult(
  step: ToolCallStepContext,
  result: PendingToolResult,
): Promise<void> {
  await step.dispatchEvent({
    type: 'tool.result',
    parentUuid: result.toolCall.id,
    toolCallId: result.toolCall.id,
    result: result.result,
    traceId: step.trace.traceId,
  });
}

async function finalizeAndDispatchToolResult(
  step: ToolCallBatchContext,
  pendingResult: PendingToolResult,
): Promise<void> {
  const result = await finalizePendingToolResult(step, pendingResult);
  await dispatchToolResult(step, result);
}

/**
 * Output used when a mid-stream preparation is discarded without execution:
 * the attempt that produced the call failed and the step's final response
 * re-streamed without it. The wording mirrors {@link UNEXECUTED_TOOL_CALL_OUTPUT}
 * — the call never ran and the model must not assume otherwise.
 */
const RETRIED_PREPARATION_DISCARD_OUTPUT =
  'This tool call was not executed: the model request was retried before the response ' +
  'completed, and this call was not part of the final response. Do not assume the tool ' +
  'ran — re-issue the call if it is still needed.';

type StreamingToolCallEntry =
  | {
      readonly kind: 'settled';
      readonly result: PendingToolResult;
      readonly stopBatchAfterThis?: boolean | undefined;
      readonly announce: () => Promise<void>;
    }
  | {
      readonly kind: 'started';
      readonly pending: Promise<PendingToolResult>;
      readonly announce: () => Promise<void>;
    }
  | { readonly kind: 'deferred'; readonly preparation: RunnableToolCallPreparation }
  | { readonly kind: 'skipped'; readonly preflighted: PreflightedToolCall };

/**
 * True when a resolved execution may start while the provider stream is still
 * open: its declared resource accesses are exclusively read/search file
 * accesses, so the tool-access conflict model guarantees it can overlap any
 * other task without ordering hazards. Calls with side effects, undeclared
 * accesses (which default to `all`), or batch-stopping executions wait for
 * the post-stream batch path.
 */
function isStreamingEligible(execution: RunnableToolExecution): boolean {
  if (execution.stopBatchAfterThis === true) return false;
  const accesses = execution.accesses;
  if (accesses === undefined) return false;
  return accesses.every(
    (access) =>
      access.kind === 'file' && (access.operation === 'read' || access.operation === 'search'),
  );
}

/**
 * Streaming tool-call runner for one model step.
 *
 * While the provider stream is still open, every tool call whose arguments
 * provably completed (reported via `LLMChatParams.onToolCallReady`) is
 * validated and prepared here in arrival order — the same phases the batch
 * path runs after the stream, serialized in the same relative order. A
 * prepared call starts executing immediately only when
 * {@link isStreamingEligible} holds; anything else is held for the
 * post-stream batch path, which authorizes and schedules it unchanged.
 *
 * Visibility is NOT advanced: `tool.call` events, buffered `tool.progress`
 * passthrough, and `tool.result` events are all released by the post-stream
 * drain in strict provider order.
 *
 * Retry/abort notes:
 * - Retried/resend attempts re-stream fresh call ids, so preparations from a
 *   failed attempt become orphans. `drainOrphanedPreparations` settles and
 *   finalizes them without dispatching events, so stateful host hooks (e.g.
 *   same-step dedup deferreds) cannot wedge on a call that never made the
 *   final response.
 * - The turn signal aborts in-flight early executions through the same grace
 *   path as batch execution; their results are discarded when the step's
 *   response never completes.
 */
export class StreamingToolCallRunner {
  private readonly step: ToolCallStepContext;
  /** Step variant whose dispatcher holds `tool.progress` until the owning call is announced. */
  private readonly gatedStep: ToolCallStepContext;
  private readonly toolScheduler = new ToolScheduler<PendingToolResult>();
  private readonly entries = new Map<string, Promise<StreamingToolCallEntry>>();
  private readonly streamedToolCalls: ToolCall[] = [];
  private readonly progressBuffers = new Map<string, LoopToolProgressEvent[]>();
  private readonly announcedCallIds = new Set<string>();
  private prepareChain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(step: ToolCallStepContext) {
    this.step = step;
    this.gatedStep = { ...step, dispatchEvent: this.gateProgressDispatch() };
  }

  get hasEntries(): boolean {
    return this.entries.size > 0;
  }

  get scheduler(): ToolScheduler<PendingToolResult> {
    return this.toolScheduler;
  }

  /**
   * Feed a provably complete streamed tool call. Synchronous and
   * non-blocking: preparation (hooks included) is appended to a serialized
   * chain so one slow approval cannot stall the provider stream, and
   * preparations never overlap each other.
   */
  addReady(toolCall: ToolCall): void {
    if (this.entries.has(toolCall.id)) return;
    this.streamedToolCalls.push(toolCall);
    if (this.stopped) {
      this.entries.set(
        toolCall.id,
        Promise.resolve({
          kind: 'skipped',
          preflighted: preflightToolCall(this.step, toolCall),
        }),
      );
      return;
    }
    const prepared = this.prepareChain.then(() => this.prepareOne(toolCall));
    this.prepareChain = prepared.then(
      () => undefined,
      () => undefined,
    );
    this.entries.set(toolCall.id, prepared);
  }

  /** Take the prepared entry for a response call, awaiting its preparation. */
  async takeEntry(toolCallId: string): Promise<StreamingToolCallEntry | undefined> {
    const entryPromise = this.entries.get(toolCallId);
    if (entryPromise === undefined) return undefined;
    this.entries.delete(toolCallId);
    return entryPromise;
  }

  /**
   * Resolve the prepared entry for a response call into a schedulable task,
   * releasing the deferred `tool.call` dispatch. Returns `undefined` when the
   * call was never streamed (the batch path prepares it from scratch).
   */
  async materialize(
    batchStep: ToolCallBatchContext,
    toolCall: ToolCall,
  ): Promise<PreparedToolCallTask | undefined> {
    const entry = await this.takeEntry(toolCall.id);
    if (entry === undefined) return undefined;
    switch (entry.kind) {
      case 'settled':
        await entry.announce();
        return {
          task: makeResolvedToolCallTask(entry.result),
          stopBatchAfterThis: entry.stopBatchAfterThis,
        };
      case 'started':
        await entry.announce();
        // Already scheduled mid-stream; wrap its pending result so the batch
        // drain handles every call through one uniform path.
        return {
          task: {
            accesses: ToolAccesses.none(),
            start: async () => ({ result: entry.pending }),
          },
        };
      case 'deferred': {
        const authorized = await authorizeToolCallPreparation(batchStep, entry.preparation);
        await authorized.announce();
        if (authorized.kind === 'settled') {
          return {
            task: makeResolvedToolCallTask(authorized.result),
            stopBatchAfterThis: authorized.stopBatchAfterThis,
          };
        }
        return { task: authorized.task, stopBatchAfterThis: authorized.stopBatchAfterThis };
      }
      case 'skipped':
        return { task: await prepareSkippedToolCall(batchStep, entry.preflighted) };
    }
  }

  /**
   * Settle preparations whose call never made the final response (a failed
   * attempt of this step streamed them, then a retry/resend re-streamed
   * without them). Results are awaited and run through result finalization —
   * without dispatching any event — so host hook state registered during
   * preparation unwinds instead of leaking into later steps.
   */
  async drainOrphanedPreparations(
    batchStep: ToolCallBatchContext,
    responseToolCalls: readonly ToolCall[],
  ): Promise<void> {
    const liveCallIds = new Set(responseToolCalls.map((toolCall) => toolCall.id));
    for (const [toolCallId, entryPromise] of this.entries) {
      if (liveCallIds.has(toolCallId)) continue;
      this.entries.delete(toolCallId);
      const entry = await entryPromise;
      let pending: PendingToolResult | undefined;
      switch (entry.kind) {
        case 'started':
          pending = await entry.pending;
          break;
        case 'settled':
          pending = entry.result;
          break;
        case 'deferred':
          pending = makeErrorToolResult(
            entry.preparation.call,
            entry.preparation.args,
            RETRIED_PREPARATION_DISCARD_OUTPUT,
          );
          break;
        case 'skipped':
          continue;
      }
      await finalizePendingToolResult(batchStep, pending);
    }
  }

  private async prepareOne(toolCall: ToolCall): Promise<StreamingToolCallEntry> {
    const preflighted = preflightToolCall(this.step, toolCall);
    // Re-check at chain execution time: an earlier call's preparation may
    // have stopped the batch after this call was queued.
    if (this.stopped) return { kind: 'skipped', preflighted };
    try {
      if (preflighted.kind === 'rejected') {
        return this.markStoppedOnSettle({
          kind: 'settled',
          result: makeErrorToolResult(preflighted, preflighted.args, preflighted.output),
          announce: this.wrapAnnounce(toolCall.id, async () =>
            dispatchToolCall(this.gatedStep, preflighted, preflighted.args, undefined),
          ),
        });
      }
      // Hooks observe the calls completed so far — a provider-order prefix of
      // the final batch. (The only hook consumer of `toolCalls` that depends
      // on the full batch, AgentSwarm exclusivity, targets a tool that is
      // never streaming-eligible and always authorizes post-stream.)
      const stepForCall: ToolCallBatchContext = {
        ...this.gatedStep,
        toolCalls: [...this.streamedToolCalls],
      };
      const preparation = await resolveToolCallPreparation(stepForCall, preflighted);
      if (preparation.kind === 'settled') {
        return this.markStoppedOnSettle({
          kind: 'settled',
          result: preparation.result,
          stopBatchAfterThis: preparation.stopBatchAfterThis,
          announce: this.wrapAnnounce(toolCall.id, preparation.announce),
        });
      }
      if (!isStreamingEligible(preparation.execution) || this.step.signal.aborted) {
        if (preparation.execution.stopBatchAfterThis === true) this.stopped = true;
        return { kind: 'deferred', preparation };
      }
      const authorized = await authorizeToolCallPreparation(stepForCall, preparation);
      if (authorized.kind === 'settled') {
        return this.markStoppedOnSettle({
          kind: 'settled',
          result: authorized.result,
          stopBatchAfterThis: authorized.stopBatchAfterThis,
          announce: this.wrapAnnounce(toolCall.id, authorized.announce),
        });
      }
      const pending = this.toolScheduler.add(authorized.task);
      return {
        kind: 'started',
        pending,
        announce: this.wrapAnnounce(toolCall.id, authorized.announce),
      };
    } catch (error) {
      // The preparation chain must never die: fall back to a terminal error
      // for this call and let later calls prepare normally.
      this.step.log?.warn('streaming tool-call preparation failed', {
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        error,
      });
      return {
        kind: 'settled',
        result: makeErrorToolResult(
          preflighted,
          preflighted.args,
          `Tool "${toolCall.name}" failed during streaming preparation: ${errorMessage(error)}`,
        ),
        announce: this.wrapAnnounce(toolCall.id, async () =>
          dispatchToolCall(this.gatedStep, preflighted, preflighted.args, undefined),
        ),
      };
    }
  }

  private markStoppedOnSettle(
    entry: Extract<StreamingToolCallEntry, { kind: 'settled' }>,
  ): StreamingToolCallEntry {
    if (entry.stopBatchAfterThis === true) this.stopped = true;
    return entry;
  }

  /**
   * Defer visibility: the wrapped announce runs the `tool.call` dispatch,
   * then releases this call's buffered progress and opens its passthrough.
   */
  private wrapAnnounce(
    toolCallId: string,
    announce: () => Promise<void>,
  ): () => Promise<void> {
    return async () => {
      await announce();
      this.announcedCallIds.add(toolCallId);
      const buffered = this.progressBuffers.get(toolCallId);
      if (buffered !== undefined) {
        this.progressBuffers.delete(toolCallId);
        for (const event of buffered) this.step.dispatchEvent(event);
      }
    };
  }

  private gateProgressDispatch(): LoopEventDispatcher {
    const base = this.step.dispatchEvent;
    const gated = (event: LoopEvent): Promise<void> | void => {
      if (event.type === 'tool.progress' && !this.announcedCallIds.has(event.toolCallId)) {
        const buffer = this.progressBuffers.get(event.toolCallId) ?? [];
        buffer.push(event);
        this.progressBuffers.set(event.toolCallId, buffer);
        return;
      }
      return (base as (event: LoopEvent) => Promise<void> | void)(event);
    };
    return gated as LoopEventDispatcher;
  }
}

/**
 * Run `prepareToolExecution` in provider order before recording `tool.call`.
 * Hook decisions can block a call or replace args before execution starts.
 */
async function runPrepareToolExecutionHook(
  step: ToolCallBatchContext,
  call: RunnableToolCall,
): Promise<PrepareToolExecutionDecision> {
  const { hooks, signal, turnId, currentStep, llm } = step;
  const { toolCall, args } = call;

  if (hooks?.prepareToolExecution === undefined) {
    return { kind: 'allowed', args };
  }

  let hookResult: PrepareToolExecutionResult | undefined;
  try {
    hookResult = await hooks.prepareToolExecution({
      toolCall,
      toolCalls: step.toolCalls,
      tool: call.tool,
      args,
      turnId,
      stepNumber: currentStep,
      traceId: step.trace.traceId,
      signal,
      llm,
    });
  } catch (error) {
    // If the turn is cancelled while an abort-aware hook is awaited, report the
    // call as aborted instead of treating it as a hook failure.
    if (isAbortError(error) || signal.aborted) {
      return {
        kind: 'hookFailed',
        args,
        output: `Tool "${call.toolName}" was aborted during prepareToolExecution hook`,
      };
    }
    return {
      kind: 'hookFailed',
      args,
      output: `prepareToolExecution hook failed for "${call.toolName}": ${errorMessage(error)}`,
    };
  }

  const effectiveArgs = hookResult?.updatedArgs ?? args;
  if (hookResult?.block === true) {
    return {
      kind: 'blocked',
      args: effectiveArgs,
      output: hookResult.reason ?? `Tool call "${call.toolName}" was blocked`,
    };
  }

  if (hookResult?.syntheticResult !== undefined) {
    return { kind: 'synthetic', args: effectiveArgs, result: hookResult.syntheticResult };
  }

  return { kind: 'allowed', args: effectiveArgs, metadata: hookResult?.executionMetadata };
}

async function runAuthorizeToolExecutionHook(
  step: ToolCallBatchContext,
  call: RunnableToolCall,
  args: unknown,
  execution: RunnableToolExecution,
): Promise<AuthorizeToolExecutionResult | undefined> {
  const { hooks, signal, turnId, currentStep, llm } = step;
  if (hooks?.authorizeToolExecution === undefined) return undefined;

  try {
    return await hooks.authorizeToolExecution({
      toolCall: call.toolCall,
      toolCalls: step.toolCalls,
      tool: call.tool,
      args,
      execution,
      turnId,
      stepNumber: currentStep,
      traceId: step.trace.traceId,
      signal,
      llm,
    });
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      return {
        block: true,
        reason: `Tool "${call.toolName}" was aborted during authorizeToolExecution hook`,
      };
    }
    return {
      block: true,
      reason: `authorizeToolExecution hook failed for "${call.toolName}": ${errorMessage(error)}`,
    };
  }
}

function toolCallDisplayFieldsFromExecution(
  execution: ToolExecution,
): ToolCallDisplayFields | undefined {
  if (execution.isError === true) return undefined;
  const description = execution.description;
  const display = execution.display;
  return {
    description: description !== undefined && description.length > 0 ? description : undefined,
    display,
  };
}

async function runRunnableToolCall(
  step: ToolCallStepContext,
  call: RunnableToolCall,
  effectiveArgs: unknown,
  metadata: unknown,
  execution: RunnableToolExecution,
): Promise<PendingToolResult> {
  const { signal } = step;
  const { toolCall, toolName } = call;

  if (signal.aborted) {
    return makeErrorToolResult(call, effectiveArgs, abortedToolOutput(toolName, signal));
  }

  let toolResult: ExecutableToolResult;
  try {
    const raw = await executeTool(step, execution, toolCall, toolName, metadata);
    toolResult = coerceToolResult(raw, toolName);
  } catch (error) {
    const aborted = isAbortError(error) || signal.aborted;
    if (!aborted) {
      step.log?.warn('tool execution failed', {
        toolName,
        toolCallId: toolCall.id,
        error,
      });
    }
    const output = aborted
      ? abortedToolOutput(toolName, signal)
      : `Tool "${toolName}" failed: ${errorMessage(error)}`;
    return makeErrorToolResult(call, effectiveArgs, output);
  }

  return makeToolResult(call, effectiveArgs, toolResult);
}

async function finalizePendingToolResult(
  step: ToolCallBatchContext,
  pendingResult: PendingToolResult,
): Promise<PendingToolResult> {
  const { hooks, signal, turnId, currentStep, llm } = step;
  if (hooks?.finalizeToolResult === undefined) {
    return { ...pendingResult, result: normalizeToolResult(pendingResult.result) };
  }

  try {
    const finalizedResult = await hooks.finalizeToolResult({
      toolCall: pendingResult.toolCall,
      toolCalls: step.toolCalls,
      args: pendingResult.args,
      result: pendingResult.result,
      turnId,
      stepNumber: currentStep,
      traceId: step.trace.traceId,
      signal,
      llm,
    });
    const effectiveResult = coerceToolResult(
      finalizedResult ?? pendingResult.result,
      pendingResult.toolName,
    );
    return {
      ...pendingResult,
      stopTurn: pendingResult.stopTurn === true || toolResultStopsTurn(effectiveResult),
      result: normalizeToolResult(effectiveResult),
    };
  } catch (error) {
    // This is the redaction/truncation boundary. If it fails, do not persist
    // the raw tool output; write an error result instead.
    const aborted = isAbortError(error) || signal.aborted;
    if (!aborted) {
      step.log?.warn('finalizeToolResult hook failed', {
        toolName: pendingResult.toolName,
        toolCallId: pendingResult.toolCall.id,
        error,
      });
    }
    const output = aborted
      ? `Tool "${pendingResult.toolName}" aborted during finalizeToolResult hook.`
      : `finalizeToolResult hook failed for "${pendingResult.toolName}": ${errorMessage(error)}`;
    return {
      ...pendingResult,
      stopTurn: pendingResult.stopTurn,
      result: { output, isError: true },
    };
  }
}

async function executeTool(
  step: ToolCallStepContext,
  execution: RunnableToolExecution,
  toolCall: ToolCall,
  toolName: string,
  metadata: unknown,
): Promise<ExecutableToolResult> {
  const { dispatchEvent, signal, turnId } = step;

  signal.throwIfAborted();

  const executePromise = execution.execute({
    turnId,
    toolCallId: toolCall.id,
    traceId: step.trace.traceId,
    metadata,
    signal,
    onUpdate: (update) => {
      if (signal.aborted) return;
      dispatchEvent({
        type: 'tool.progress',
        toolCallId: toolCall.id,
        update,
      });
    },
  });
  return raceExecuteWithGraceTimeout(executePromise, signal, toolName);
}

async function raceExecuteWithGraceTimeout(
  executePromise: Promise<ExecutableToolResult>,
  signal: AbortSignal,
  toolName: string,
): Promise<ExecutableToolResult> {
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const graceSentinel: Promise<ExecutableToolResult> = new Promise((resolve) => {
    const armTimer = (): void => {
      graceTimer = setTimeout(() => {
        resolve({
          output: `Tool "${toolName}" aborted by grace timeout (${String(GRACE_TIMEOUT_MS)}ms)`,
          isError: true,
        });
      }, GRACE_TIMEOUT_MS);
    };
    if (signal.aborted) {
      armTimer();
    } else {
      onAbort = armTimer;
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    // Tools that ignore AbortSignal may never settle. After abort, the grace
    // branch lets the turn finish with a synthetic error result.
    return await Promise.race([executePromise, graceSentinel]);
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (onAbort !== undefined) {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        // Some AbortSignal polyfills do not implement removeEventListener.
      }
    }
  }
}

function isMediaContentPart(part: ContentPart): boolean {
  return part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url';
}

/**
 * Validate a tool's raw return against the {@link ExecutableToolResult} contract.
 * A tool that returns `undefined`, a primitive, or an object without a valid
 * `output` field is coerced into an `isError: true` result so the loop can still
 * emit a paired `tool.result` event. This is the trust boundary between
 * arbitrary tool implementations and the rest of the loop.
 */
function coerceToolResult(value: unknown, toolName: string): ExecutableToolResult {
  if (value === null || value === undefined) {
    return { output: `Tool "${toolName}" returned no result.`, isError: true };
  }
  if (typeof value !== 'object') {
    return {
      output: `Tool "${toolName}" returned a ${typeof value} instead of a tool result.`,
      isError: true,
    };
  }
  const candidate = value as { output?: unknown };
  if (typeof candidate.output !== 'string' && !Array.isArray(candidate.output)) {
    return {
      output: `Tool "${toolName}" returned a result with a missing or malformed "output" field.`,
      isError: true,
    };
  }
  return value as ExecutableToolResult;
}

function normalizeToolResult(r: ExecutableToolResult): ExecutableToolResult {
  let output: ExecutableToolResult['output'];
  if (typeof r.output === 'string') {
    output = r.output.length > 0 ? r.output : TOOL_OUTPUT_EMPTY;
  } else if (r.output.length === 0) {
    output = TOOL_OUTPUT_EMPTY;
  } else {
    const hasMediaBlock = r.output.some(isMediaContentPart);
    if (hasMediaBlock) {
      const hasNonEmptyText = r.output.some((c) => c.type === 'text' && c.text.length > 0);
      output = hasNonEmptyText
        ? r.output
        : [{ type: 'text', text: TOOL_OUTPUT_NON_TEXT }, ...r.output];
    } else {
      const textJoined = r.output
        .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
        .map((c) => c.text)
        .join('');
      output = textJoined.length > 0 ? textJoined : TOOL_OUTPUT_EMPTY;
    }
  }
  // Rebuild keeps the persisted contract only: `note`, `display`, and
  // `structured` ride into the record (the model reads the note at
  // projection; UIs read the display ref for localized rendering and the
  // structured fields instead of parsing the output), while
  // `stopTurn`/`message` are loop/UI-local and are dropped here. Tools are
  // arbitrary JS, so this is also where the note/display/structured
  // contracts are enforced: a malformed or empty note, a malformed display
  // ref, and a non-JSON-serializable structured payload are discarded —
  // the tool's actual output is still valid, and everything downstream
  // trusts the contract.
  const base: {
    output: typeof output;
    note?: string;
    truncated?: true;
    display?: ToolResultDisplayRef;
    structured?: ToolResultStructured;
  } = { output };
  if (typeof r.note === 'string' && r.note.length > 0) base.note = r.note;
  if (r.truncated === true) base.truncated = true;
  const display = normalizeResultDisplay(r.display);
  if (display !== undefined) base.display = display;
  const structured = normalizeResultStructured(r.structured);
  if (structured !== undefined) base.structured = structured;
  if (r.isError === true) {
    return { ...base, isError: true };
  }
  return base;
}

/**
 * Enforce the display-ref contract (non-empty key; params a flat
 * string/number record) so downstream — the record log, the wire schema,
 * the TUI — never has to re-validate. Returns undefined for anything
 * malformed.
 */
function normalizeResultDisplay(display: unknown): ToolResultDisplayRef | undefined {
  if (typeof display !== 'object' || display === null) return undefined;
  const candidate = display as { key?: unknown; params?: unknown };
  if (typeof candidate.key !== 'string' || candidate.key.length === 0) return undefined;
  if (candidate.params === undefined) return { key: candidate.key };
  if (typeof candidate.params !== 'object' || candidate.params === null) return undefined;
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(candidate.params)) {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    params[name] = value;
  }
  return { key: candidate.key, params };
}

/**
 * Enforce the structured-payload contract: a plain JSON-serializable
 * object. The wire schema and the transcript record only carry JSON, so
 * anything else (arrays, class instances, cycles, functions, non-finite
 * numbers) is dropped rather than allowed to break persistence downstream.
 */
function normalizeResultStructured(structured: unknown): ToolResultStructured | undefined {
  if (typeof structured !== 'object' || structured === null || Array.isArray(structured)) {
    return undefined;
  }
  try {
    // Cycles throw; non-JSON values (functions, undefined, NaN, class
    // instances with non-JSON leaves) are rejected by the deep check.
    JSON.stringify(structured);
  } catch {
    return undefined;
  }
  if (!isJsonValue(structured)) return undefined;
  return structured as ToolResultStructured;
}

function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object': {
      if (Array.isArray(value)) return value.every(isJsonValue);
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== null && proto !== Object.prototype) return false;
      return Object.values(value as Record<string, unknown>).every(isJsonValue);
    }
    default:
      return false;
  }
}

function makeToolResult(
  call: PreflightedToolCall,
  args: unknown,
  result: ExecutableToolResult,
): PendingToolResult {
  return {
    toolCall: call.toolCall,
    toolName: call.toolName,
    args,
    result,
    stopTurn: toolResultStopsTurn(result),
  };
}

function toolResultStopsTurn(result: ExecutableToolResult): boolean {
  return result.stopTurn === true;
}

function makeErrorToolResult(
  call: PreflightedToolCall,
  args: unknown,
  output: string,
): PendingToolResult {
  return makeToolResult(call, args, { output, isError: true });
}

/**
 * Record `tool.call` in provider order. Reusing the provider/API tool-call id
 * keeps transcript linkage on one canonical identity.
 */
async function dispatchToolCall(
  step: ToolCallStepContext,
  call: PreflightedToolCall,
  args: unknown,
  displayFields?: ToolCallDisplayFields | undefined,
): Promise<void> {
  const { toolCall, toolName } = call;
  await step.dispatchEvent({
    type: 'tool.call',
    uuid: toolCall.id,
    turnId: step.turnId,
    step: step.currentStep,
    stepUuid: step.stepUuid,
    toolCallId: toolCall.id,
    name: toolName,
    args,
    description: displayFields?.description,
    display: displayFields?.display,
    extras: toolCall.extras,
    traceId: step.trace.traceId,
  });
}

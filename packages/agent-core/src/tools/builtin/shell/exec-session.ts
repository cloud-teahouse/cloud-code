/**
 * ExecSessionTool — start a persistent interactive shell session in a PTY.
 *
 * The sibling of Bash: where Bash runs a one-shot command with piped stdio,
 * ExecSession spawns the command attached to a pseudo-terminal and keeps it
 * alive across tool calls; the model drives it afterwards with WriteStdin
 * (RFC `docs/rfc/unified-exec-pty.md` §3.1, codex `exec_command`).
 *
 * Permission model: creation goes through the FULL Bash chain — tree-sitter
 * per-segment analysis, session-approval rules in the `Bash(...)` namespace
 * (an approved `Bash(python *)` covers repeated session creation), the
 * policy chain (Guardian included), and the sandbox escalation retry chain.
 * The escalation prompt is worded for a *persistent unsandboxed session*,
 * not a one-shot retry (RFC §3.4 / risk table).
 */

import { isLikelySandboxDenied, type Kaos, type KaosPtyProcess } from '@cloud-code/kaos';
import { z } from 'zod';

import type { ShellSessionManager } from '../../../agent/shell-session';
import { TOOL_SNIP_HINT_SIDE_EFFECT, type BuiltinTool } from '../../../agent/tool/types';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { renderPrompt } from '../../../utils/render-prompt';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject, matchesWrapperAwareSubject } from '../../support/rule-match';
import { analyzeBashCommand } from '../../support/shell-ast';
import type { BashSandboxOptions } from './bash';
import execSessionDescriptionTemplate from './exec-session.md?raw';
import { PTY_SESSION_ENV } from './shell-env';
import { renderSessionPollResult } from './session-result';

export const EXEC_SESSION_TOOL_NAME = 'ExecSession' as const;

/** codex yield clamp: 250ms–30s, default 10s (`mod.rs:64-69`). */
const DEFAULT_YIELD_TIME_MS = 10_000;
const MIN_YIELD_TIME_MS = 250;
const MAX_YIELD_TIME_MS = 30_000;

/**
 * Window after a session start during which an immediate exit is still
 * attributed to launch-time conditions (e.g. a sandbox denial) and is
 * eligible for one escalation retry — mirrors bash.ts's background window.
 */
const SANDBOX_ESCALATION_WINDOW_MS = 1_000;

/** Prefix stamped on the output of an approved unsandboxed retry. */
const UNSANDBOXED_RETRY_MARKER = '[sandbox: session ran without sandbox after approval]';

/** Subset of the execute context needed to route escalation approvals. */
interface SandboxEscalationContext {
  readonly turnId: string;
  readonly toolCallId: string;
}

const EMPTY_ESCALATION_CONTEXT: SandboxEscalationContext = { turnId: '', toolCallId: '' };

export const ExecSessionInputSchema = z.object({
  command: z
    .string()
    .min(1, 'Command cannot be empty.')
    .describe(
      'The command to run in the session. To keep state across calls, start the shell itself (e.g. "bash") or a REPL (e.g. "python3") and drive it with WriteStdin.',
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      "The working directory in which to start the session. When omitted, the session starts in the agent's working directory.",
    ),
  yield_time_ms: z
    .number()
    .int()
    .min(MIN_YIELD_TIME_MS)
    .max(MAX_YIELD_TIME_MS)
    .default(DEFAULT_YIELD_TIME_MS)
    .describe(
      `How long to wait for initial output before returning, in milliseconds (default ${String(DEFAULT_YIELD_TIME_MS)}, range ${String(MIN_YIELD_TIME_MS)}–${String(MAX_YIELD_TIME_MS)}). The process keeps running after the call returns.`,
    )
    .optional(),
  max_output_chars: z
    .number()
    .int()
    .positive()
    .describe(
      'Maximum characters of session output to include in this result. The full log is always written to output_path.',
    )
    .optional(),
});

export type ExecSessionInput = z.Infer<typeof ExecSessionInputSchema>;

export class ExecSessionTool implements BuiltinTool<ExecSessionInput> {
  readonly name = EXEC_SESSION_TOOL_NAME;
  readonly snipHint = TOOL_SNIP_HINT_SIDE_EFFECT;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ExecSessionInputSchema);

  private readonly allowBackground: boolean;
  private readonly sandbox: BashSandboxOptions | undefined;

  /**
   * `permission.wrapper_stripping` (default true): same wrapper-stripping
   * behavior as Bash — session creation shares Bash's rule namespace, so
   * it must share its rule shapes and matching strength (design §3.2.A).
   */
  private readonly wrapperStripping: boolean;

  /**
   * Full command strings approved for unsandboxed execution for the rest of
   * this session ("approve for session" on a sandbox-escalation prompt).
   * Same semantics as BashTool's exemption set.
   */
  private readonly sessionUnsandboxedExemptions = new Set<string>();

  constructor(
    private readonly kaos: Kaos,
    private readonly cwd: string,
    private readonly shellSessions: ShellSessionManager,
    options?: {
      allowBackground?: boolean | undefined;
      sandbox?: BashSandboxOptions | undefined;
      wrapperStripping?: boolean | undefined;
    },
  ) {
    this.allowBackground = options?.allowBackground ?? true;
    this.sandbox = options?.sandbox;
    this.wrapperStripping = options?.wrapperStripping ?? true;
    this.description = this.allowBackground
      ? renderPrompt(execSessionDescriptionTemplate, {
          SHELL_NAME: this.kaos.osEnv.shellName,
        })
      : 'Persistent shell sessions are disabled for this agent because the task management tools (TaskList/TaskOutput/TaskStop) are not enabled. Do not call this tool.';
  }

  async resolveExecution(args: ExecSessionInput): Promise<ToolExecution> {
    const preview = args.command.length > 50 ? `${args.command.slice(0, 50)}…` : args.command;
    // Parse once up front, exactly like Bash: session creation is
    // permissioned with the same per-segment granularity and the same
    // `Bash(...)` session-rule namespace, so an approval of e.g.
    // `Bash(python *)` covers repeated session creation (RFC §3.4).
    const analysis = await analyzeBashCommand(args.command, {
      stripWrappers: this.wrapperStripping,
    });
    const wrapperStripping = this.wrapperStripping;
    return {
      description: `Starting session: ${preview}`,
      display: {
        kind: 'command',
        command: args.command,
        cwd: args.cwd ?? this.cwd,
        language: 'bash',
      },
      approvalRule: literalRulePattern('Bash', args.command),
      approvalRules: analysis.approvalRules,
      // Rule matching happens in the Bash namespace: the `Bash(...)` rules
      // above must gate both one-shot Bash calls and session creation, and a
      // user-configured `allow Bash(python *)` covers ExecSession too.
      ruleToolName: 'Bash',
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.command),
      ruleMatch: {
        subjects: analysis.subjects,
        matches: (ruleArgs, subject, decision) =>
          matchesWrapperAwareSubject(ruleArgs, subject, {
            enabled: wrapperStripping,
            degraded: analysis.degraded,
            decision,
          }),
      },
      astDegraded: analysis.degraded,
      // Same per-segment git classes as Bash: the git mutation gate
      // covers session creation exactly as it covers one-shot commands.
      gitClasses: analysis.segments.map((segment) => segment.gitClass),
      execute: ({ signal, turnId, toolCallId }) =>
        this.execution(args, signal, { turnId, toolCallId }),
    };
  }

  private spawn(
    effectiveCwd: string,
    command: string,
    opts?: { readonly unsandboxed?: boolean },
  ): Promise<KaosPtyProcess> {
    const shellArgs = [this.kaos.osEnv.shellPath, '-c', command];
    // Ambient env + session knobs. Deliberately NO GIT_TERMINAL_PROMPT=0
    // (unlike Bash): a session is interactive, so credential prompts must
    // stay possible.
    const mergedEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...PTY_SESSION_ENV,
      SHELL: this.kaos.osEnv.shellPath,
    };
    const kaos =
      opts?.unsandboxed === true && this.sandbox?.unsandboxedKaos !== undefined
        ? this.sandbox.unsandboxedKaos
        : this.kaos;
    return kaos
      .withCwd(effectiveCwd)
      .ptyExec(shellArgs, mergedEnv, { term: PTY_SESSION_ENV['TERM'] });
  }

  private async execution(
    args: ExecSessionInput,
    signal: AbortSignal,
    execCtx: SandboxEscalationContext = EMPTY_ESCALATION_CONTEXT,
    retryState?: { readonly unsandboxedRetry?: boolean },
  ): Promise<ExecutableToolResult> {
    const validationError = this.validateRunRequest(args, signal);
    if (validationError !== undefined) return validationError;

    const command = args.command;
    const effectiveCwd = args.cwd ?? this.cwd;
    let proc: KaosPtyProcess;
    try {
      proc = await this.spawn(effectiveCwd, command, {
        unsandboxed: retryState?.unsandboxedRetry === true,
      });
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    // Register immediately after spawn, before any waiting: a turn
    // interruption must not lose the last reference to a live process.
    let sessionId: string;
    try {
      ({ sessionId } = this.shellSessions.createSession({
        proc,
        command,
        description: sessionDescription(command),
      }));
    } catch (error) {
      await killSpawnedProcess(proc);
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    // Sandbox-denied sessions typically die within milliseconds of launch.
    // Give such fast failures one escalation chance; sessions that survive
    // the window are never retried (re-running would duplicate side effects).
    const earlyDenial = await this.detectSandboxedEarlyDenial(sessionId, proc, retryState);
    if (earlyDenial !== undefined) {
      const decision = await this.resolveSandboxEscalation(
        command,
        earlyDenial.reason,
        signal,
        execCtx,
      );
      if (decision === 'reject') {
        return {
          isError: true,
          output:
            `Session ${sessionId} exited shortly after start ` +
            `(${earlyDenial.reason}); running it without the sandbox was not approved.\n\n` +
            earlyDenial.output,
        };
      }
      return this.annotateUnsandboxedRetry(
        await this.execution(args, signal, execCtx, { unsandboxedRetry: true }),
      );
    }

    const yieldMs = normalizeYieldTime(args.yield_time_ms);
    let poll;
    try {
      poll = await this.shellSessions.interact(sessionId, { yieldMs, signal });
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
    const result = await renderSessionPollResult(this.shellSessions, poll, {
      maxOutputChars: args.max_output_chars,
      allowBackground: this.allowBackground,
    });
    return retryState?.unsandboxedRetry === true ? this.annotateUnsandboxedRetry(result) : result;
  }

  private validateRunRequest(
    args: ExecSessionInput,
    signal: AbortSignal,
  ): ExecutableToolResult | undefined {
    if (signal.aborted) return { isError: true, output: 'Aborted before session started' };
    // Fail closed: `sandbox.mode = 'enforce'` on an environment that cannot
    // be sandboxed (e.g. SSH kaos) turns every call into this error.
    if (this.sandbox?.unavailableReason !== undefined) {
      return { isError: true, output: this.sandbox.unavailableReason };
    }
    if (args.command.length === 0) return { isError: true, output: 'Command cannot be empty.' };
    if (!this.allowBackground) {
      return {
        isError: true,
        output:
          'Persistent shell sessions are not available for this agent because TaskOutput and TaskStop are not enabled.',
      };
    }
    return undefined;
  }

  /**
   * Detect a session that died within the escalation window with a
   * sandbox-denial signature. Bounded by {@link SANDBOX_ESCALATION_WINDOW_MS};
   * returns undefined when the session is not eligible (not sandboxed,
   * retries disabled, still running, or the exit is not a denial).
   */
  private async detectSandboxedEarlyDenial(
    sessionId: string,
    proc: KaosPtyProcess,
    retryState?: { readonly unsandboxedRetry?: boolean },
  ): Promise<{ readonly exitCode: number; readonly output: string; readonly reason: string } | undefined> {
    if (retryState?.unsandboxedRetry === true) return undefined;
    if (!this.sandboxEscalationArmed()) return undefined;
    if (this.sandbox?.wasSandboxed?.(proc) !== true) return undefined;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        proc.wait().then((code) => ({ kind: 'exited' as const, code })),
        new Promise<{ kind: 'running' }>((resolve) => {
          timer = setTimeout(() => {
            resolve({ kind: 'running' });
          }, SANDBOX_ESCALATION_WINDOW_MS);
        }),
      ]);
      if (outcome.kind === 'running') return undefined;

      const exitCode = outcome.code;
      if (exitCode === 0) return undefined;
      const output = await this.shellSessions.readOutput(sessionId).catch(() => '');
      if (!isLikelySandboxDenied({ exitCode, output })) return undefined;
      return {
        exitCode,
        output,
        reason: `exit code ${String(exitCode)}; output matches the sandbox-denial signature`,
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Whether an unsandboxed retry could possibly be offered right now. */
  private sandboxEscalationArmed(): boolean {
    const sandbox = this.sandbox;
    if (sandbox === undefined) return false;
    if (sandbox.unavailableReason !== undefined) return false;
    if ((sandbox.escalation ?? 'ask') === 'never') return false;
    return sandbox.unsandboxedKaos !== undefined && sandbox.requestEscalation !== undefined;
  }

  /**
   * Decide whether the session may be retried without the sandbox:
   * session-exempted commands and `escalation = 'always'` skip the prompt;
   * otherwise the request goes through the injected approval channel.
   * `'session'` approvals are remembered by the full command string.
   */
  private async resolveSandboxEscalation(
    command: string,
    reason: string,
    signal: AbortSignal,
    execCtx: SandboxEscalationContext,
  ): Promise<'once' | 'session' | 'reject'> {
    const sandbox = this.sandbox;
    if (sandbox?.requestEscalation === undefined) return 'reject';
    if (this.sessionUnsandboxedExemptions.has(command)) return 'once';
    if ((sandbox.escalation ?? 'ask') === 'always') return 'once';
    const decision = await sandbox.requestEscalation({
      command,
      reason,
      turnId: execCtx.turnId,
      toolCallId: execCtx.toolCallId,
      signal,
    });
    if (decision === 'session') this.sessionUnsandboxedExemptions.add(command);
    return decision;
  }

  private annotateUnsandboxedRetry(result: ExecutableToolResult): ExecutableToolResult {
    if (typeof result.output !== 'string') return result;
    return { ...result, output: `${UNSANDBOXED_RETRY_MARKER}\n${result.output}` };
  }
}

function normalizeYieldTime(yieldTimeMs: number | undefined): number {
  const value = yieldTimeMs ?? DEFAULT_YIELD_TIME_MS;
  return Math.min(Math.max(value, MIN_YIELD_TIME_MS), MAX_YIELD_TIME_MS);
}

function sessionDescription(command: string): string {
  const preview = command.length > 60 ? `${command.slice(0, 60)}…` : command;
  return `Session: ${preview}`;
}

async function killSpawnedProcess(proc: KaosPtyProcess): Promise<void> {
  try {
    await proc.kill('SIGTERM');
  } catch {
    /* process already gone */
  } finally {
    try {
      await proc.dispose();
    } catch {
      /* best-effort cleanup */
    }
  }
}

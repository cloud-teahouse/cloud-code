import { describe, expect, it } from 'vitest';

import { buildHookSpawnOptions } from '../../src/session/hooks/runner';

const RUNNER_MODULE = '../../src/session/hooks/runner' as string;

interface HookResult {
  action: 'allow' | 'block';
  message?: string;
  reason?: string;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  structuredOutput?: boolean;
  permissionDecision?: 'allow' | 'deny' | 'ask';
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
}

type RunHook = (
  command: string,
  input: Record<string, unknown>,
  options: { timeout: number; cwd?: string },
) => Promise<HookResult>;

async function importRunHook(): Promise<RunHook> {
  const mod = (await import(RUNNER_MODULE)) as { runHook: RunHook };
  return mod.runHook;
}

describe('runHook process runner', () => {
  it('returns allow when the hook exits 0 and captures stdout', async () => {
    const runHook = await importRunHook();
    const result = await runHook('echo ok', { tool_name: 'Shell' }, { timeout: 5 });
    expect(result.action).toBe('allow');
    expect(result.stdout?.trim()).toBe('ok');
  });

  it('parses stdout JSON message into a hook result message', async () => {
    const runHook = await importRunHook();
    const result = await runHook("node -e \"process.stdout.write(JSON.stringify({message:'hook says hi'}))\"", {}, { timeout: 5 });
    expect(result.action).toBe('allow');
    expect(result.message).toBe('hook says hi');
    expect(result.structuredOutput).toBe(true);
  });

  it('marks structured stdout JSON without message as empty hook output', async () => {
    const runHook = await importRunHook();

    const emptyObject = await runHook("node -e \"process.stdout.write('{}')\"", {}, { timeout: 5 });
    expect(emptyObject.action).toBe('allow');
    expect(emptyObject.message).toBeUndefined();
    expect(emptyObject.structuredOutput).toBe(true);

    const emptyHookSpecificOutput = await runHook(
      "node -e \"process.stdout.write(JSON.stringify({hookSpecificOutput:{}}))\"",
      {},
      { timeout: 5 },
    );
    expect(emptyHookSpecificOutput.action).toBe('allow');
    expect(emptyHookSpecificOutput.message).toBeUndefined();
    expect(emptyHookSpecificOutput.structuredOutput).toBe(true);
  });

  it('returns block when the hook exits 2 and captures stderr as the reason', async () => {
    const runHook = await importRunHook();
    const result = await runHook(
      "node -e \"process.stderr.write('blocked');process.exit(2)\"",
      { tool_name: 'Shell' },
      { timeout: 5 },
    );
    expect(result.action).toBe('block');
    expect(result.reason).toContain('blocked');
  });

  it('returns allow on non-zero, non-2 exit codes (e.g. exit 1)', async () => {
    const runHook = await importRunHook();
    const result = await runHook('exit 1', { tool_name: 'Shell' }, { timeout: 5 });
    expect(result.action).toBe('allow');
  });

  it('returns allow with timedOut=true when the command exceeds the timeout', async () => {
    const runHook = await importRunHook();
    const result = await runHook('sleep 10', { tool_name: 'Shell' }, { timeout: 0.05 });
    expect(result.action).toBe('allow');
    expect(result.timedOut).toBe(true);
  });

  it('parses stdout JSON permissionDecision=deny into a block result with the supplied reason', async () => {
    const runHook = await importRunHook();
    const cmd =
      "node -e \"process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:'use rg'}}))\"";
    const result = await runHook(cmd, { tool_name: 'Bash' }, { timeout: 5 });
    expect(result.action).toBe('block');
    expect(result.reason).toBe('use rg');
  });

  it('writes the input payload to the hook process stdin as JSON', async () => {
    const runHook = await importRunHook();
    const cmd =
      'node -e "let s=\\"\\";process.stdin.on(\\"data\\",d=>s+=d);process.stdin.on(\\"end\\",()=>{const o=JSON.parse(s);process.stdout.write(o.tool_name);})"';
    const result = await runHook(cmd, { tool_name: 'WriteFile' }, { timeout: 5 });
    expect(result.stdout?.trim()).toBe('WriteFile');
  });
});

// Regression coverage for the "every hook flashes an empty console window on
// Windows" bug. With `shell:true` and no `windowsHide`, Node allocates a
// visible console for each hook child process on Windows. The fix is to pass
// `windowsHide:true` (mirrors KAOS' `buildLocalSpawnOptions` and the runner's
// own taskkill spawn). The flag is only observable on Windows, so we assert
// the spawn options builder directly.
describe('buildHookSpawnOptions (Windows console-window regression)', () => {
  it('sets windowsHide:true so hooks do not flash a console on Windows', () => {
    expect(buildHookSpawnOptions({}).windowsHide).toBe(true);
  });

  it('runs through the shell with stdio piped', () => {
    const options = buildHookSpawnOptions({});
    expect(options.shell).toBe(true);
    expect(options.stdio).toBe('pipe');
  });

  it('merges hook env onto process.env and forwards cwd', () => {
    const options = buildHookSpawnOptions({ cwd: '/repo', env: { FOO: 'bar' } });
    expect(options.cwd).toBe('/repo');
    expect(options.env).toMatchObject({ FOO: 'bar' });
  });
});

describe('runHook structured output parsing (hooks 四件套)', () => {
  it('parses permissionDecision=ask as an allow action carrying the ask decision', async () => {
    const runHook = await importRunHook();
    const cmd =
      "node -e \"process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'ask',permissionDecisionReason:'needs human eyes'}}))\"";
    const result = await runHook(cmd, { tool_name: 'Bash' }, { timeout: 5 });
    expect(result.action).toBe('allow');
    expect(result.permissionDecision).toBe('ask');
    expect(result.structuredOutput).toBe(true);
  });

  it('parses permissionDecision=allow without blocking', async () => {
    const runHook = await importRunHook();
    const cmd =
      "node -e \"process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'allow'}}))\"";
    const result = await runHook(cmd, { tool_name: 'Bash' }, { timeout: 5 });
    expect(result.action).toBe('allow');
    expect(result.permissionDecision).toBe('allow');
  });

  it('marks a structured deny with permissionDecision=deny', async () => {
    const runHook = await importRunHook();
    const cmd =
      "node -e \"process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:'use rg'}}))\"";
    const result = await runHook(cmd, { tool_name: 'Bash' }, { timeout: 5 });
    expect(result.action).toBe('block');
    expect(result.permissionDecision).toBe('deny');
    expect(result.reason).toBe('use rg');
  });

  it('parses updatedInput as a record and ignores non-record values', async () => {
    const runHook = await importRunHook();
    const cmd =
      "node -e \"process.stdout.write(JSON.stringify({hookSpecificOutput:{updatedInput:{command:'ls -la'}}}))\"";
    const result = await runHook(cmd, { tool_name: 'Bash' }, { timeout: 5 });
    expect(result.action).toBe('allow');
    expect(result.updatedInput).toEqual({ command: 'ls -la' });

    const badCmd =
      "node -e \"process.stdout.write(JSON.stringify({hookSpecificOutput:{updatedInput:'not-a-record'}}))\"";
    const bad = await runHook(badCmd, { tool_name: 'Bash' }, { timeout: 5 });
    expect(bad.action).toBe('allow');
    expect(bad.updatedInput).toBeUndefined();
  });

  it('parses additionalContext for PostToolUse-style hooks', async () => {
    const runHook = await importRunHook();
    const cmd =
      "node -e \"process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'tsc failed: 2 errors'}}))\"";
    const result = await runHook(cmd, { tool_name: 'Bash' }, { timeout: 5 });
    expect(result.action).toBe('allow');
    expect(result.additionalContext).toBe('tsc failed: 2 errors');
  });
});

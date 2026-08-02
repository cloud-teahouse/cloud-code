import { describe, expect, it } from 'vitest';

import type { ExecutableToolResult } from '../../../src/loop/types';
import {
  ToolCallDeduplicator,
  __testing,
  isHostBlockOutput,
  normalizeErrorSignature,
} from '../../../src/agent/turn/tool-dedup';

const {
  REMINDER_TEXT_1,
  STORM_BREAK_THRESHOLD,
  REPEAT_SUCCESS_BREAK_THRESHOLD,
  LOOP_GUARD_MARKER,
} = __testing;

function okResult(text: string): ExecutableToolResult {
  return { output: text };
}

function errResult(text: string): ExecutableToolResult {
  return { output: text, isError: true };
}

function permissionBlock(toolName: string): ExecutableToolResult {
  return errResult(`Tool "${toolName}" was denied by permission policy.`);
}

function textOf(result: ExecutableToolResult): string {
  return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
}

/** Drive one full step with a single original call. */
async function runStep(
  deduper: ToolCallDeduplicator,
  callId: string,
  tool: string,
  args: unknown,
  result: ExecutableToolResult,
): Promise<ExecutableToolResult> {
  deduper.beginStep();
  const cached = deduper.checkSameStep(callId, tool, args);
  expect(cached).toBeNull();
  const final = await deduper.finalizeResult(callId, tool, args, result);
  deduper.endStep();
  return final;
}

describe('normalizeErrorSignature', () => {
  it('collapses whitespace', () => {
    expect(normalizeErrorSignature('line one\n\n  line\t two')).toBe('line one line two');
  });

  it('normalizes absolute paths', () => {
    expect(normalizeErrorSignature('ENOENT: no such file /etc/foo/bar.txt, open failed')).toBe(
      'ENOENT: no such file <path>, open failed',
    );
    expect(normalizeErrorSignature('cannot read ~/secret/key.pem now')).toBe(
      'cannot read <path> now',
    );
    expect(normalizeErrorSignature('error at C:\\Users\\x\\file.ts: access')).toBe(
      'error at <path>: access',
    );
  });

  it('normalizes numbers, hex and line:col pairs', () => {
    expect(normalizeErrorSignature('timeout after 30000 ms')).toBe('timeout after <n> ms');
    expect(normalizeErrorSignature('src/a.ts:12:34 - error TS2304')).toBe(
      'src/a.ts:<n>:<n> - error TS2304',
    );
    expect(normalizeErrorSignature('bad pointer 0xdeadBEEF')).toBe('bad pointer <n>');
    expect(normalizeErrorSignature('version 1.2.3 mismatch')).toBe('version <n> mismatch');
  });

  it('maps failures differing only in volatile parts to one signature', () => {
    const a = normalizeErrorSignature('EACCES: permission denied, open /var/log/app/1.log (pid 4211)');
    const b = normalizeErrorSignature('EACCES: permission denied, open /var/log/app/2.log (pid 9870)');
    expect(a).toBe(b);
  });

  it('keeps distinct failure classes distinct', () => {
    expect(normalizeErrorSignature('ENOENT: no such file /a/b')).not.toBe(
      normalizeErrorSignature('EACCES: permission denied /a/b'),
    );
  });
});

describe('isHostBlockOutput', () => {
  it('recognizes the canonical permission-block shapes', () => {
    expect(isHostBlockOutput('Tool "Bash" was denied by permission policy.')).toBe(true);
    expect(isHostBlockOutput('Tool "Write" was denied by permission rule. Reason: no')).toBe(true);
    expect(isHostBlockOutput('Tool "Bash" was not run because the approval request was cancelled.')).toBe(true);
    expect(isHostBlockOutput('Tool "Bash" was not run because the user rejected the approval request.')).toBe(true);
    expect(isHostBlockOutput('Tool "Bash" was denied. Try a different approach.')).toBe(true);
    expect(isHostBlockOutput('Plan mode is active. You may only write to the current plan file: /p.')).toBe(true);
    expect(isHostBlockOutput(`${LOOP_GUARD_MARKER} "Write" has already succeeded 2 times…`)).toBe(true);
  });

  it('rejects plain execution errors', () => {
    expect(isHostBlockOutput('ENOENT: no such file or directory')).toBe(false);
    expect(isHostBlockOutput('Command failed with exit code: 1')).toBe(false);
    expect(isHostBlockOutput('')).toBe(false);
  });
});

describe('storm signature guard', () => {
  it('rewrites the result into a change-approach directive at the threshold', async () => {
    const deduper = new ToolCallDeduplicator();
    const err = (file: string) => errResult(`ENOENT: no such file ${file}, open failed`);

    // Same failure, reworded arguments — the same-args ladder cannot see this.
    await runStep(deduper, 'c1', 'Read', { path: '/a/1.txt' }, err('/a/1.txt'));
    await runStep(deduper, 'c2', 'Read', { path: '/a/2.txt' }, err('/a/2.txt'));
    const third = await runStep(deduper, 'c3', 'Read', { path: '/a/3.txt' }, err('/a/3.txt'));

    expect(textOf(third)).toContain(LOOP_GUARD_MARKER);
    expect(textOf(third)).toContain('has now failed 3 times in a row with the same host response');
    expect(textOf(third)).toContain('Change approach');
    expect(third.isError).toBe(true);
    expect(STORM_BREAK_THRESHOLD).toBe(3);
  });

  it('uses blocked wording when the repeated outcome is a host refusal', async () => {
    const deduper = new ToolCallDeduplicator();
    for (const name of ['Write', 'Write']) {
      await runStep(deduper, `c-${name}-${Math.random()}`, 'Write', { path: '/x' }, {
        output: 'Tool "Write" was not run because the user rejected the approval request.',
        isError: true,
      });
    }
    const third = await runStep(deduper, 'c3', 'Write', { path: '/y' }, {
      output: 'Tool "Write" was not run because the user rejected the approval request.',
      isError: true,
    });
    expect(textOf(third)).toContain('has now been blocked or failed 3 times in a row');
  });

  it('resets on any success', async () => {
    const deduper = new ToolCallDeduplicator();
    const err = () => errResult('boom: connection refused');
    await runStep(deduper, 'c1', 'Bash', { command: 'curl a' }, err());
    await runStep(deduper, 'c2', 'Bash', { command: 'curl b' }, err());
    await runStep(deduper, 'c3', 'Bash', { command: 'true' }, okResult('ok'));
    const fourth = await runStep(deduper, 'c4', 'Bash', { command: 'curl c' }, err());
    expect(textOf(fourth)).not.toContain(LOOP_GUARD_MARKER);
  });

  it('resets when the error signature changes', async () => {
    const deduper = new ToolCallDeduplicator();
    await runStep(deduper, 'c1', 'Bash', {}, errResult('ENOENT: /a'));
    await runStep(deduper, 'c2', 'Bash', {}, errResult('ENOENT: /b'));
    const third = await runStep(deduper, 'c3', 'Bash', {}, errResult('EACCES: /c'));
    expect(textOf(third)).not.toContain(LOOP_GUARD_MARKER);
  });

  it('yields to the same-args ladder instead of stacking reminders', async () => {
    const deduper = new ToolCallDeduplicator();
    // Identical (tool, args) failing: the same-args ladder fires r1 at streak
    // 3; the storm guard must not rewrite on top of it.
    await runStep(deduper, 'c1', 'Bash', { command: 'false' }, errResult('exit code 1'));
    await runStep(deduper, 'c2', 'Bash', { command: 'false' }, errResult('exit code 1'));
    const third = await runStep(deduper, 'c3', 'Bash', { command: 'false' }, errResult('exit code 1'));

    expect(textOf(third)).toContain(REMINDER_TEXT_1.trim().slice(0, 40));
    expect(textOf(third)).not.toContain(LOOP_GUARD_MARKER);
  });

  it('normalizes ContentPart outputs before signing', async () => {
    const deduper = new ToolCallDeduplicator();
    const errParts = (file: string): ExecutableToolResult => ({
      output: [{ type: 'text', text: `ENOENT: no such file ${file}` }],
      isError: true,
    });
    await runStep(deduper, 'c1', 'Read', { path: '/a/1' }, errParts('/a/1'));
    await runStep(deduper, 'c2', 'Read', { path: '/a/2' }, errParts('/a/2'));
    const third = await runStep(deduper, 'c3', 'Read', { path: '/a/3' }, errParts('/a/3'));
    expect(JSON.stringify(third.output)).toContain(LOOP_GUARD_MARKER);
  });
});

describe('blocked-turn streak guard', () => {
  it('injects a notice after three consecutive fully-blocked steps', async () => {
    const deduper = new ToolCallDeduplicator();

    // Vary the blocked tools so the storm signature never engages.
    await runStep(deduper, 'c1', 'Bash', {}, permissionBlock('Bash'));
    await runStep(deduper, 'c2', 'Write', {}, permissionBlock('Write'));
    await runStep(deduper, 'c3', 'Edit', {}, permissionBlock('Edit'));

    const fourth = await runStep(deduper, 'c4', 'Bash', {}, permissionBlock('Bash'));
    expect(textOf(fourth)).toContain(LOOP_GUARD_MARKER);
    expect(textOf(fourth)).toContain('every tool call in the last 3 steps has been blocked');
  });

  it('resets when a step contains a non-blocked call', async () => {
    const deduper = new ToolCallDeduplicator();
    await runStep(deduper, 'c1', 'Bash', {}, permissionBlock('Bash'));
    await runStep(deduper, 'c2', 'Write', {}, permissionBlock('Write'));
    // Mixed step: one blocked, one success.
    deduper.beginStep();
    expect(deduper.checkSameStep('c3a', 'Edit', { n: 1 })).toBeNull();
    await deduper.finalizeResult('c3a', 'Edit', { n: 1 }, permissionBlock('Edit'));
    expect(deduper.checkSameStep('c3b', 'Read', { n: 2 })).toBeNull();
    await deduper.finalizeResult('c3b', 'Read', { n: 2 }, okResult('data'));
    deduper.endStep();

    // Streak restarts: two more blocked steps are not enough.
    await runStep(deduper, 'c4', 'Bash', {}, permissionBlock('Bash'));
    const fifth = await runStep(deduper, 'c5', 'Write', {}, permissionBlock('Write'));
    expect(textOf(fifth)).not.toContain('every tool call in the last');
  });

  it('does not count plain execution errors as blocked', async () => {
    const deduper = new ToolCallDeduplicator();
    await runStep(deduper, 'c1', 'Bash', {}, errResult('Command failed with exit code: 1'));
    await runStep(deduper, 'c2', 'Write', {}, errResult('disk full'));
    await runStep(deduper, 'c3', 'Edit', {}, errResult('io error'));
    const fourth = await runStep(deduper, 'c4', 'Bash', {}, errResult('segfault'));
    expect(textOf(fourth)).not.toContain('every tool call in the last');
  });

  it('counts same-step duplicates with the original’s outcome class', async () => {
    const deduper = new ToolCallDeduplicator();
    for (let step = 0; step < 3; step += 1) {
      deduper.beginStep();
      expect(deduper.checkSameStep(`s${step}-a`, 'Bash', { n: step })).toBeNull();
      expect(deduper.checkSameStep(`s${step}-b`, 'Bash', { n: step })).not.toBeNull();
      await deduper.finalizeResult(`s${step}-a`, 'Bash', { n: step }, permissionBlock('Bash'));
      await deduper.finalizeResult(`s${step}-b`, 'Bash', { n: step }, { output: '' });
      deduper.endStep();
    }
    // Both calls of every step were blocked (dup shares the class) → the
    // streak kept growing; step 4's first result carries the notice.
    const fourth = await runStep(deduper, 'c4', 'Write', {}, permissionBlock('Write'));
    expect(textOf(fourth)).toContain('every tool call in the last 3 steps has been blocked');
  });
});

describe('repeat-success guard', () => {
  const writeArgs = { path: '/workspace/a.txt', content: 'same' };

  it('refuses the third identical successful write without executing it', async () => {
    const deduper = new ToolCallDeduplicator();

    await runStep(deduper, 'c1', 'Write', writeArgs, okResult('written'));
    await runStep(deduper, 'c2', 'Write', writeArgs, okResult('written'));
    expect(REPEAT_SUCCESS_BREAK_THRESHOLD).toBe(2);

    deduper.beginStep();
    const cached = deduper.checkSameStep('c3', 'Write', writeArgs);
    expect(cached).not.toBeNull();
    expect(cached?.isError).toBe(true);
    expect(textOf(cached!)).toContain(LOOP_GUARD_MARKER);
    expect(textOf(cached!)).toContain('has already succeeded 2 times with the same write arguments');

    // The guard result flows through finalize without stacked reminders, and
    // registers as a host-block outcome for the blocked-turn streak.
    const final = await deduper.finalizeResult('c3', 'Write', writeArgs, cached!);
    expect(textOf(final)).toContain(LOOP_GUARD_MARKER);
    deduper.endStep();

    // The refusal itself does not raise the success count: the next identical
    // call is refused again.
    deduper.beginStep();
    const again = deduper.checkSameStep('c4', 'Write', writeArgs);
    expect(again?.isError).toBe(true);
    deduper.endStep();
  });

  it('tracks Edit as write-like but ignores read-only and shell tools', async () => {
    const deduper = new ToolCallDeduplicator();
    const editArgs = { path: '/a', old_string: 'x', new_string: 'y' };
    await runStep(deduper, 'e1', 'Edit', editArgs, okResult('edited'));
    await runStep(deduper, 'e2', 'Edit', editArgs, okResult('edited'));
    deduper.beginStep();
    expect(deduper.checkSameStep('e3', 'Edit', editArgs)?.isError).toBe(true);
    deduper.endStep();

    const deduper2 = new ToolCallDeduplicator();
    await runStep(deduper2, 'r1', 'Read', { path: '/a' }, okResult('data'));
    await runStep(deduper2, 'r2', 'Read', { path: '/a' }, okResult('data'));
    deduper2.beginStep();
    expect(deduper2.checkSameStep('r3', 'Read', { path: '/a' })).toBeNull();
    deduper2.endStep();

    const deduper3 = new ToolCallDeduplicator();
    await runStep(deduper3, 'b1', 'Bash', { command: 'make' }, okResult('ok'));
    await runStep(deduper3, 'b2', 'Bash', { command: 'make' }, okResult('ok'));
    deduper3.beginStep();
    expect(deduper3.checkSameStep('b3', 'Bash', { command: 'make' })).toBeNull();
    deduper3.endStep();
  });

  it('keys on arguments: different files have independent budgets', async () => {
    const deduper = new ToolCallDeduplicator();
    await runStep(deduper, 'c1', 'Write', { path: '/a', content: 'x' }, okResult('w'));
    await runStep(deduper, 'c2', 'Write', { path: '/a', content: 'x' }, okResult('w'));
    deduper.beginStep();
    // Same tool, different target: still allowed.
    expect(deduper.checkSameStep('c3', 'Write', { path: '/b', content: 'x' })).toBeNull();
    deduper.endStep();
  });

  it('does not count failed writes toward the refusal budget', async () => {
    const deduper = new ToolCallDeduplicator();
    await runStep(deduper, 'c1', 'Write', writeArgs, errResult('disk full'));
    await runStep(deduper, 'c2', 'Write', writeArgs, errResult('disk full'));
    deduper.beginStep();
    expect(deduper.checkSameStep('c3', 'Write', writeArgs)).toBeNull();
    deduper.endStep();
  });
});

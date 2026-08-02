/**
 * Turn-level coverage for the hooks 四件套 (Claude-Code port):
 *   - PreToolUse `updatedInput` rewriting the call's args before execution
 *   - PreToolUse `permissionDecision: 'ask'` escalating to the approval broker
 *   - PostToolUse blocking hooks injecting `additionalContext` into the tool result
 *   - PostToolUse hook failures never breaking the turn
 */

import { Readable, type Writable } from 'node:stream';

import type { Kaos, KaosProcess } from '@cloud-code/kaos';
import type { ToolCall } from '@cloud-code/kosong';
import { describe, expect, it, vi } from 'vitest';

import { HookEngine } from '../../src/session/hooks';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import { createCommandKaos, testAgent } from './harness/agent';

function bashCall(command: string): ToolCall {
  return {
    type: 'function',
    id: 'call_bash',
    name: 'Bash',
    arguments: JSON.stringify({ command, timeout: 60 }),
  };
}

function createSpyKaos(stdout: string): { kaos: Kaos; execWithEnv: ReturnType<typeof vi.fn> } {
  const execWithEnv = vi.fn().mockImplementation(async (): Promise<KaosProcess> => {
    return {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: Readable.from([stdout]),
      stderr: Readable.from(['']),
      pid: 42,
      exitCode: 0,
      wait: vi.fn().mockResolvedValue(0),
      kill: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
  });
  return { kaos: createFakeKaos({ execWithEnv }), execWithEnv };
}

describe('PreToolUse updatedInput', () => {
  it('rewrites the tool call args before execution and announces the rewritten call', async () => {
    const { kaos, execWithEnv } = createSpyKaos('ok');
    const hookEngine = new HookEngine([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command:
          'node -e "process.stdout.write(JSON.stringify({hookSpecificOutput:{updatedInput:{command:\'printf rewritten\',timeout:60}}}))"',
      },
    ]);
    const ctx = testAgent({ kaos, hookEngine });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall('printf original'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });
    await ctx.untilTurnEnd();

    expect(execWithEnv).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(execWithEnv.mock.calls)).toContain('printf rewritten');
    expect(JSON.stringify(execWithEnv.mock.calls)).not.toContain('printf original');
    const started = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'tool.call.started',
    );
    expect(JSON.stringify(started?.args)).toContain('printf rewritten');
    expect(JSON.stringify(started?.args)).not.toContain('printf original');
  });

  it('fails the call with a validation error when the rewritten args violate the tool schema', async () => {
    const { kaos, execWithEnv } = createSpyKaos('ok');
    const hookEngine = new HookEngine([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command:
          'node -e "process.stdout.write(JSON.stringify({hookSpecificOutput:{updatedInput:{bogus:1}}}))"',
      },
    ]);
    const ctx = testAgent({ kaos, hookEngine });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall('printf original'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });
    await ctx.untilTurnEnd();

    expect(execWithEnv).not.toHaveBeenCalled();
    const history = JSON.stringify(ctx.agent.context.data().history);
    expect(history).toContain('Invalid args for tool');
    expect(history).toContain('after authorizeToolExecution hook');
  });
});

describe('PreToolUse permissionDecision ask', () => {
  it('escalates to the approval broker and runs the tool after approval', async () => {
    const { kaos, execWithEnv } = createSpyKaos('ok');
    const hookEngine = new HookEngine([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command:
          'node -e "process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:\'ask\'}}))"',
      },
    ]);
    const ctx = testAgent({ kaos, hookEngine });
    ctx.configure({ tools: ['Bash'] });
    // auto mode would otherwise approve without asking — the hook ask must win.
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall('printf hook-ask'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });

    const approval = await ctx.takeApprovalRequest();
    expect(execWithEnv).not.toHaveBeenCalled();
    approval.respond({ decision: 'approved', selectedLabel: 'Approve once' });
    await ctx.untilTurnEnd();

    expect(execWithEnv).toHaveBeenCalledTimes(1);
  });

  it('does not run the tool when the escalated approval is rejected', async () => {
    const { kaos, execWithEnv } = createSpyKaos('ok');
    const hookEngine = new HookEngine([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command:
          'node -e "process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:\'ask\'}}))"',
      },
    ]);
    const ctx = testAgent({ kaos, hookEngine });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall('printf hook-ask'));
    ctx.mockNextResponse({ type: 'text', text: 'The user rejected it, moving on.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });

    const approval = await ctx.takeApprovalRequest();
    approval.respond({ decision: 'rejected' });
    await ctx.untilTurnEnd();

    expect(execWithEnv).not.toHaveBeenCalled();
    expect(JSON.stringify(ctx.agent.context.data().history)).toContain('rejected');
  });
});

describe('PostToolUse blocking injection', () => {
  it('appends hook additionalContext to the tool result the model sees', async () => {
    const hookEngine = new HookEngine([
      {
        event: 'PostToolUse',
        matcher: 'Bash',
        command:
          'node -e "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:\'PostToolUse\',additionalContext:\'tsc failed: 2 errors in a.ts\'}}))"',
      },
    ]);
    const ctx = testAgent({ kaos: createCommandKaos('ok'), hookEngine });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall('printf ok'));
    ctx.mockNextResponse({ type: 'text', text: 'I see the lint errors, fixing.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });
    await ctx.untilTurnEnd();

    // The second LLM call must carry the injected context inside the tool result.
    expect(ctx.llmCalls).toHaveLength(2);
    const secondCall = JSON.stringify(ctx.llmCalls[1]);
    expect(secondCall).toContain('<hook_result hook_event=');
    expect(secondCall).toContain('PostToolUse');
    expect(secondCall).toContain('tsc failed: 2 errors in a.ts');
  });

  it('feeds a blocking PostToolUse hook reason back to the model', async () => {
    const hookEngine = new HookEngine([
      {
        event: 'PostToolUse',
        matcher: 'Bash',
        command: 'node -e "process.stderr.write(\'lint gate failed\'); process.exit(2)"',
      },
    ]);
    const ctx = testAgent({ kaos: createCommandKaos('ok'), hookEngine });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall('printf ok'));
    ctx.mockNextResponse({ type: 'text', text: 'Fixing the lint failure.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });
    await ctx.untilTurnEnd();

    const secondCall = JSON.stringify(ctx.llmCalls[1]);
    expect(secondCall).toContain('lint gate failed');
  });

  it('tolerates a failing PostToolUse hook without breaking the turn', async () => {
    const hookEngine = new HookEngine([
      {
        event: 'PostToolUse',
        matcher: 'Bash',
        command: 'node -e "process.stdout.write(\'not json at all\'); process.exit(1)"',
      },
    ]);
    const ctx = testAgent({ kaos: createCommandKaos('ok'), hookEngine });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall('printf ok'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });
    const events = await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    expect(JSON.stringify(events)).toContain('"reason":"completed"');
    // A failed hook injects nothing.
    expect(JSON.stringify(ctx.llmCalls[1])).not.toContain('hook_result');
  });
});

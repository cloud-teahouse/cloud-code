/**
 * ExitPlanModeTool tests against the current Agent-backed tool surface.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import {
  ExitPlanModeInputSchema,
  ExitPlanModeTool,
} from '../../src/tools/builtin/planning/exit-plan-mode';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function makeAgent(
  input: {
    readonly active?: boolean | undefined;
    readonly plan?: string | null | undefined;
    readonly path?: string | undefined;
    readonly planFilePath?: string | null | undefined;
    readonly permissionMode?: string | undefined;
    readonly emit?: ((event: unknown) => void) | undefined;
  } = {},
): { agent: Agent; requestApproval: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> } {
  let active = input.active ?? true;
  const requestApproval = vi.fn(async () => ({ decision: 'approved' }));
  const emit = vi.fn((event: unknown) => {
    input.emit?.(event);
    if ((event as { type?: string }).type === 'plan_mode.exit') active = false;
  });
  const agent = {
    planMode: {
      get isActive() {
        return active;
      },
      get planFilePath() {
        return input.planFilePath ?? null;
      },
      data: vi.fn(async () => {
        if (input.plan === null) return null;
        return {
          content: input.plan ?? 'Step 1: read files\nStep 2: fix bug',
          path: input.path ?? '/tmp/kimi-plan.md',
        };
      }),
      exit: () => {
        emit({ type: 'plan_mode.exit' });
      },
    },
    permission: { mode: input.permissionMode ?? 'auto' },
    rpc: { requestApproval },
    emit,
  } as unknown as Agent;
  return { agent, requestApproval, emit };
}

describe('ExitPlanModeTool', () => {
  it('has name, description, and parameters from the current schema', () => {
    const { agent } = makeAgent();
    const tool = new ExitPlanModeTool(agent);

    expect(tool.name).toBe('ExitPlanMode');
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.description).toContain('This tool does NOT take the plan content as a parameter');
    expect(tool.description).toContain('For research tasks');
    expect(tool.description).toContain('Reject and Revise controls');
    expect(tool.description).toContain('If rejected, revise based on feedback');
    // The description must teach what a good plan looks like (concrete, verifiable).
    expect(tool.description.toLowerCase()).toContain('verifiable');
    expect(ExitPlanModeInputSchema.safeParse({}).success).toBe(true);
    expect(ExitPlanModeInputSchema.safeParse({ plan: '' }).success).toBe(false);
    expect(ExitPlanModeInputSchema.safeParse({ plan: 'a plan' }).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        options: { type: 'array' },
      },
    });
    const optionsSchema = (tool.parameters['properties'] as Record<string, unknown>)[
      'options'
    ] as {
      description?: string;
      items?: {
        properties?: Record<string, { description?: string }>;
      };
    };
    expect(optionsSchema.description).toContain('up to 3 options');
    expect(optionsSchema.description).toContain('single option');
    expect(optionsSchema.items?.properties?.['label']?.description).toContain('(Recommended)');
    expect(optionsSchema.items?.properties?.['description']?.description).toContain('trade-offs');
    expect((tool.parameters['properties'] as Record<string, unknown>)['plan']).toBeUndefined();
  });

  it('refuses to exit when plan mode is inactive', async () => {
    const { agent, emit } = makeAgent({ active: false });

    const result = await executeTool(new ExitPlanModeTool(agent), {
      turnId: '0',
      toolCallId: 'call_1',
      args: {},
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('plan mode');
    expect(emit).not.toHaveBeenCalled();
  });

  it('exits with the current plan without consulting permission approval', async () => {
    const { agent, requestApproval, emit } = makeAgent({
      plan: '# File Plan',
      path: '/tmp/kimi-plan.md',
    });

    const result = await executeTool(new ExitPlanModeTool(agent), {
      turnId: '0',
      toolCallId: 'call_1',
      args: {},
      signal,
    });

    expect(result.isError).toBe(false);
    expect(requestApproval).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith({ type: 'plan_mode.exit' });
    expect(result.output).toContain('Plan saved to: /tmp/kimi-plan.md');
    expect(result.output).toContain('# File Plan');
  });

  it('does not use inline plan fallback when no plan file exists', async () => {
    const { agent, emit } = makeAgent({ plan: null });

    const result = await executeTool(new ExitPlanModeTool(agent), {
      turnId: '0',
      toolCallId: 'call_inline',
      args: {},
      signal,
    });

    expect(result.isError).toBe(true);
    expect(emit).not.toHaveBeenCalled();
    expect(result.output).toContain('No plan file found');
  });

  it('returns an error when no plan content is available', async () => {
    const { agent, emit } = makeAgent({
      plan: '',
      path: '/tmp/kimi-plan.md',
    });

    const result = await executeTool(new ExitPlanModeTool(agent), {
      turnId: '0',
      toolCallId: 'call_empty',
      args: {},
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('Write your plan to /tmp/kimi-plan.md first');
    expect(emit).not.toHaveBeenCalled();
  });

  it('surfaces errors from plan exit as a tool error', async () => {
    const { agent } = makeAgent({
      emit: () => {
        throw new Error('journal write failed');
      },
    });

    const result = await executeTool(new ExitPlanModeTool(agent), {
      turnId: '0',
      toolCallId: 'call_fail',
      args: {},
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('journal write failed');
  });
});

describe('ExitPlanModeTool structured outcome and display refs', () => {
  it('marks auto-approved exits with a structured auto_approved outcome', async () => {
    const { agent } = makeAgent({ path: '/tmp/kimi-plan.md' });

    const result = await executeTool(new ExitPlanModeTool(agent), {
      turnId: '0',
      toolCallId: 'call_auto',
      args: {},
      signal,
    });

    expect(result.isError).toBe(false);
    expect(result.structured).toEqual({ outcome: 'auto_approved', path: '/tmp/kimi-plan.md' });
    // Model-facing output stays byte-identical English.
    expect(result.output).toContain('## Plan (auto-approved, not user-reviewed):');
  });

  it('marks user-mode exits with a structured approved outcome', async () => {
    const { agent } = makeAgent({ path: '/tmp/kimi-plan.md', permissionMode: 'manual' });

    const result = await executeTool(new ExitPlanModeTool(agent), {
      turnId: '0',
      toolCallId: 'call_manual',
      args: {},
      signal,
    });

    expect(result.isError).toBe(false);
    expect(result.structured).toEqual({ outcome: 'approved', path: '/tmp/kimi-plan.md' });
    expect(result.output).toContain('## Approved Plan:');
  });

  it('omits the path from the structured outcome when no plan file path exists', async () => {
    const { agent } = makeAgent({ path: undefined, planFilePath: null });
    // Plan data without a path: approved but nothing to report as `path`.
    const dataSpy = vi.fn(async () => ({ content: 'plan', path: undefined }));
    (agent.planMode as unknown as { data: unknown }).data = dataSpy;

    const result = await executeTool(new ExitPlanModeTool(agent), {
      turnId: '0',
      toolCallId: 'call_nopath',
      args: {},
      signal,
    });

    expect(result.isError).toBe(false);
    expect(result.structured).toEqual({ outcome: 'auto_approved' });
  });

  it('points the inactive-plan-mode error at a localized rendering', async () => {
    const { agent } = makeAgent({ active: false });

    const result = await executeTool(new ExitPlanModeTool(agent), {
      turnId: '0',
      toolCallId: 'call_inactive',
      args: {},
      signal,
    });

    expect(result.display).toEqual({ key: 'toolResult.exitPlanMode.notInPlanMode' });
  });

  it('points the missing-plan-file error at a localized rendering with the path', async () => {
    const { agent } = makeAgent({ plan: '', path: '/tmp/kimi-plan.md' });

    const result = await executeTool(new ExitPlanModeTool(agent), {
      turnId: '0',
      toolCallId: 'call_missing',
      args: {},
      signal,
    });

    expect(result.display).toEqual({
      key: 'toolResult.exitPlanMode.noPlanFileAtPath',
      params: { path: '/tmp/kimi-plan.md' },
    });
  });

  it('points the no-plan-file-path error at a localized rendering without params', async () => {
    const { agent } = makeAgent({ plan: null, planFilePath: null });

    const result = await executeTool(new ExitPlanModeTool(agent), {
      turnId: '0',
      toolCallId: 'call_nofile',
      args: {},
      signal,
    });

    expect(result.display).toEqual({ key: 'toolResult.exitPlanMode.noPlanFile' });
  });

  it('points plan-exit failures at a localized rendering with the error', async () => {
    const { agent } = makeAgent({
      emit: () => {
        throw new Error('journal write failed');
      },
    });

    const result = await executeTool(new ExitPlanModeTool(agent), {
      turnId: '0',
      toolCallId: 'call_exitfail',
      args: {},
      signal,
    });

    expect(result.display).toEqual({
      key: 'toolResult.exitPlanMode.exitFailed',
      params: { error: 'journal write failed' },
    });
  });
});

describe('ExitPlanMode option description optionality', () => {
  it('exposes options[].description as optional with a default of empty string', () => {
    const { agent } = makeAgent();
    const tool = new ExitPlanModeTool(agent);

    const optionItems = (
      (tool.parameters['properties'] as Record<string, unknown>)['options'] as {
        items?: {
          required?: readonly string[];
          properties?: Record<string, { default?: unknown }>;
        };
      }
    ).items;

    expect(optionItems?.required).toEqual(['label']);
    expect(optionItems?.required).not.toContain('description');
    expect(optionItems?.properties?.['description']?.default).toBe('');
  });

  it('accepts an option that omits description', () => {
    const result = ExitPlanModeInputSchema.safeParse({
      options: [{ label: 'Approach A' }],
    });

    expect(result.success).toBe(true);
  });

  it('defaults a missing option description to an empty string', () => {
    const result = ExitPlanModeInputSchema.safeParse({
      options: [{ label: 'Approach A' }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.options?.[0]?.description).toBe('');
    }
  });
});

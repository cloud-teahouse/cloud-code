import { createControlledPromise } from '@antfu/utils';
import { describe, expect, it } from 'vitest';

import {
  createTeammateContext,
  getTeammateContext,
  isInProcessTeammate,
  runWithTeammateContext,
  type TeammateContext,
} from '../../../src/agent/swarm/teammate-context';

function context(name: string, teamName?: string): TeammateContext {
  return createTeammateContext({
    agentId: `agent-${name}`,
    parentAgentId: 'main',
    name,
    teamName,
    abortController: new AbortController(),
  });
}

describe('teammate-context', () => {
  it('is unset outside a teammate scope', () => {
    expect(getTeammateContext()).toBeUndefined();
    expect(isInProcessTeammate()).toBe(false);
  });

  it('exposes the context inside the scope and restores afterwards', () => {
    const ctx = context('researcher', 'core');
    const seen = runWithTeammateContext(ctx, () => {
      expect(isInProcessTeammate()).toBe(true);
      return getTeammateContext();
    });

    expect(seen).toBe(ctx);
    expect(seen).toMatchObject({
      agentId: 'agent-researcher',
      parentAgentId: 'main',
      name: 'researcher',
      teamName: 'core',
      isInProcess: true,
    });
    expect(getTeammateContext()).toBeUndefined();
  });

  it('propagates through awaited continuations', async () => {
    const ctx = context('writer');
    const seen = await runWithTeammateContext(ctx, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return getTeammateContext();
    });
    expect(seen).toBe(ctx);
  });

  it('restores the outer scope when a nested scope exits', () => {
    const outer = context('outer');
    const inner = context('inner');

    runWithTeammateContext(outer, () => {
      expect(getTeammateContext()?.name).toBe('outer');
      runWithTeammateContext(inner, () => {
        expect(getTeammateContext()?.name).toBe('inner');
      });
      expect(getTeammateContext()?.name).toBe('outer');
    });
  });

  it('keeps concurrent teammates isolated from each other', async () => {
    const alice = context('alice', 'core');
    const bob = context('bob', 'core');
    const midpoint = createControlledPromise<void>();

    // Both scopes park at a shared barrier mid-run, so each is provably
    // inside its own async tree while the other is active too.
    const runAlice = runWithTeammateContext(alice, async () => {
      await midpoint;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return getTeammateContext();
    });
    const runBob = runWithTeammateContext(bob, async () => {
      await midpoint;
      return getTeammateContext();
    });
    midpoint.resolve();

    const [seenAlice, seenBob] = await Promise.all([runAlice, runBob]);
    expect(seenAlice?.name).toBe('alice');
    expect(seenBob?.name).toBe('bob');
    expect(getTeammateContext()).toBeUndefined();
  });

  it('does not leak when the scoped function throws', () => {
    const ctx = context('failing');
    expect(() =>
      runWithTeammateContext(ctx, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(getTeammateContext()).toBeUndefined();
  });

  it('carries the run abort controller for lifecycle wiring', () => {
    const controller = new AbortController();
    const ctx = createTeammateContext({
      agentId: 'agent-1',
      parentAgentId: 'main',
      name: 'worker',
      abortController: controller,
    });
    controller.abort('stop');
    expect(ctx.abortController.signal.aborted).toBe(true);
    expect(ctx.abortController.signal.reason).toBe('stop');
  });
});

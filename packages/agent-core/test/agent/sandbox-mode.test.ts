import { describe, expect, it } from 'vitest';

import { testAgent } from './harness';

/**
 * The session-scoped sandbox override (`/sandbox on|off`): stored on the
 * agent config with the null-as-clear record contract, surfaced via the
 * sandboxMode getter that the Bash sandbox wiring reads per spawn.
 */
describe('Agent config — sandboxMode override', () => {
  it('defaults to following the file config (undefined)', () => {
    const ctx = testAgent();
    expect(ctx.agent.config.sandboxMode).toBeUndefined();
    expect(ctx.agent.config.data().sandboxMode).toBeUndefined();
  });

  it('setSandboxMode stores the override and exposes it via data()', () => {
    const ctx = testAgent();

    ctx.agent.config.setSandboxMode('off');
    expect(ctx.agent.config.sandboxMode).toBe('off');
    expect(ctx.agent.config.data().sandboxMode).toBe('off');

    ctx.agent.config.setSandboxMode('auto');
    expect(ctx.agent.config.sandboxMode).toBe('auto');
  });

  it('clears back to the file config with undefined (null on the wire)', () => {
    const ctx = testAgent();
    ctx.agent.config.setSandboxMode('off');

    ctx.agent.config.setSandboxMode(undefined);
    expect(ctx.agent.config.sandboxMode).toBeUndefined();
    expect(ctx.agent.config.data().sandboxMode).toBeUndefined();
  });

  it('is reachable through the agent RPC surface', () => {
    const ctx = testAgent();

    ctx.rpc.setSandboxMode({ mode: 'enforce' });
    expect(ctx.agent.config.sandboxMode).toBe('enforce');

    ctx.rpc.setSandboxMode({ mode: null });
    expect(ctx.agent.config.sandboxMode).toBeUndefined();
  });
});

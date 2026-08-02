/**
 * The permission chain's `ask` path routes through the
 * leader permission bridge for teammates (badged leader queue / mailbox
 * fallback) instead of the agent's own approval RPC — and never through the
 * no-handler auto-approve. Non-teammates keep the legacy rpc path.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { ToolCall } from '@cloud-code/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../../src/agent';
import { PermissionManager, type PermissionPolicyContext } from '../../../src/agent/permission';
import { MailboxService } from '../../../src/agent/swarm/mailbox-service';
import { ToolAccesses } from '../../../src/loop';
import { createFakeKaos } from '../../tools/fixtures/fake-kaos';

const tempDirs: string[] = [];
const services: MailboxService[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const signal = new AbortController().signal;

function hookContext(toolName: string, args: Record<string, unknown>): PermissionPolicyContext {
  const toolCall: ToolCall = {
    type: 'function',
    id: `call_${toolName.toLowerCase()}_1`,
    name: toolName,
    arguments: JSON.stringify(args),
  };
  return {
    turnId: '0',
    stepNumber: 1,
    signal,
    llm: {} as PermissionPolicyContext['llm'],
    toolCall,
    toolCalls: [toolCall],
    args,
    execution: {
      accesses: ToolAccesses.none(),
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  } as unknown as PermissionPolicyContext;
}

interface Fixture {
  readonly manager: PermissionManager;
  readonly mailbox: MailboxService;
  readonly agentRequestApproval: ReturnType<typeof vi.fn>;
  readonly leaderRequestApproval: ReturnType<typeof vi.fn>;
}

async function createFixture(options: {
  readonly teammate?: { name: string; teamName?: string } | undefined;
  readonly leaderDecision?: 'approved' | 'rejected';
}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-code-perm-bridge-'));
  tempDirs.push(dir);
  const leaderRequestApproval = vi.fn(async () => ({ decision: options.leaderDecision ?? 'approved' }) as never);
  const leader = {
    rpc: { requestApproval: leaderRequestApproval },
  } as unknown as Agent;
  const mailbox = new MailboxService(dir, {
    roster: () => ({}),
    leader: () => leader,
    stopAgentTask: async () => true,
  });
  services.push(mailbox);

  const agentRequestApproval = vi.fn(async () => ({ decision: 'approved' }) as never);
  const agent = {
    type: 'sub',
    config: { cwd: '/workspace' },
    kaos: createFakeKaos(),
    emitStatusUpdated: vi.fn(),
    records: { logRecord: vi.fn() },
    replayBuilder: { push: vi.fn() },
    rpc: { requestApproval: agentRequestApproval },
    hooks: undefined,
    mailbox,
    teammate: options.teammate,
    planMode: { get isActive() { return false; } },
    swarmMode: { get isActive() { return false; } },
  } as unknown as Agent;
  const manager = new PermissionManager(agent);
  Object.assign(agent, { permission: manager });
  return { manager, mailbox, agentRequestApproval, leaderRequestApproval };
}

describe('teammate approval bridge in the permission chain', () => {
  it('routes a teammate\'s ask through the leader queue with the badge, not the teammate rpc', async () => {
    const { manager, agentRequestApproval, leaderRequestApproval } = await createFixture({
      teammate: { name: 'researcher', teamName: 'core' },
    });

    // Manual mode + no matching rules: FallbackAsk produces the ask.
    const result = await manager.beforeToolCall(hookContext('Bash', { command: 'pnpm test' }));

    expect(agentRequestApproval).not.toHaveBeenCalled();
    expect(leaderRequestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'Bash',
        requester: { name: 'researcher', teamName: 'core' },
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // Approved → the chain does not block.
    expect(result).toBeUndefined();
  });

  it('blocks the tool when the leader rejects', async () => {
    const { manager } = await createFixture({
      teammate: { name: 'researcher', teamName: 'core' },
      leaderDecision: 'rejected',
    });

    const result = await manager.beforeToolCall(hookContext('Bash', { command: 'pnpm test' }));

    expect(result).toMatchObject({ block: true });
  });

  it('keeps non-teammates on the legacy agent rpc path', async () => {
    const { manager, agentRequestApproval, leaderRequestApproval } = await createFixture({});

    await manager.beforeToolCall(hookContext('Bash', { command: 'pnpm test' }));

    expect(agentRequestApproval).toHaveBeenCalled();
    expect(leaderRequestApproval).not.toHaveBeenCalled();
  });

  it('keeps team-less teammates on the legacy agent rpc path', async () => {
    const { manager, agentRequestApproval, leaderRequestApproval } = await createFixture({
      teammate: { name: 'lonely' },
    });

    await manager.beforeToolCall(hookContext('Bash', { command: 'pnpm test' }));

    expect(agentRequestApproval).toHaveBeenCalled();
    expect(leaderRequestApproval).not.toHaveBeenCalled();
  });
});

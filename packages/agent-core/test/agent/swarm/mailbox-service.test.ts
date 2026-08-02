import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../../src/agent';
import { LEADER_INBOX } from '../../../src/agent/swarm/mailbox';
import {
  MailboxService,
  renderMailboxMessage,
  type MailboxHooks,
} from '../../../src/agent/swarm/mailbox-service';
import type { AgentMeta } from '../../../src/session';

const tempDirs: string[] = [];
const services: MailboxService[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

interface FakeTurn {
  steer: ReturnType<typeof vi.fn>;
  hasActiveTurn: boolean;
}

function fakeAgent(hasActiveTurn: boolean, rpc?: { requestApproval: ReturnType<typeof vi.fn> }): { agent: Agent; turn: FakeTurn } {
  const turn: FakeTurn = { steer: vi.fn(), hasActiveTurn };
  return { agent: { turn, rpc } as unknown as Agent, turn };
}

interface Fixture {
  readonly service: MailboxService;
  readonly hooks: MailboxHooks;
  readonly stopAgentTask: ReturnType<typeof vi.fn<(agentId: string, reason: string) => Promise<boolean>>>;
}

async function createFixture(options: {
  roster?: Record<string, AgentMeta>;
  leader?: Agent;
  pollIntervalMs?: number;
  shutdownGraceMs?: number;
  permissionRequestTimeoutMs?: number;
}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-code-mailbox-service-'));
  tempDirs.push(dir);
  const stopAgentTask = vi.fn(async (_agentId: string, _reason: string) => true);
  const hooks: MailboxHooks = {
    roster: () => options.roster ?? {},
    leader: () => options.leader,
    stopAgentTask,
  };
  const service = new MailboxService(dir, hooks, {
    pollIntervalMs: options.pollIntervalMs ?? 15,
    shutdownGraceMs: options.shutdownGraceMs ?? 20,
    permissionRequestTimeoutMs: options.permissionRequestTimeoutMs,
  });
  services.push(service);
  return { service, hooks, stopAgentTask };
}

function teammateMeta(name: string, teamName: string): AgentMeta {
  return { type: 'sub', parentAgentId: 'main', teammate: { name, teamName } };
}

describe('MailboxService addressing', () => {
  it('resolves the leader inbox and roster teammates', async () => {
    const { service } = await createFixture({
      roster: { 'agent-1': teammateMeta('researcher', 'core') },
    });
    expect(service.resolveRecipient('core', LEADER_INBOX).ok).toBe(true);
    expect(service.resolveRecipient('core', 'researcher').ok).toBe(true);
    const missing = service.resolveRecipient('core', 'ghost');
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('expected miss');
    expect(missing.error).toContain('No teammate named "ghost"');
  });

  it('rejects a same-named teammate in another team', async () => {
    const { service } = await createFixture({
      roster: { 'agent-1': teammateMeta('researcher', 'infra') },
    });
    expect(service.resolveRecipient('core', 'researcher').ok).toBe(false);
  });
});

describe('MailboxService teammate delivery', () => {
  it('steers unread messages into the teammate\'s active turn and marks them read', async () => {
    const { agent, turn } = fakeAgent(true);
    const { service } = await createFixture({});
    await service.sendMessage('core', LEADER_INBOX, 'researcher', 'status check');

    const controller = new AbortController();
    service.startTeammateWatcher({
      teamName: 'core',
      name: 'researcher',
      agentId: 'agent-1',
      agent,
      controller,
    });

    await vi.waitFor(() => {
      expect(turn.steer).toHaveBeenCalledTimes(1);
    });
    const [content, origin] = turn.steer.mock.calls[0]!;
    expect(content[0].text).toContain('status check');
    expect(content[0].text).toContain('<teammate-message from="leader" team="core"');
    expect(origin).toMatchObject({ kind: 'mailbox', teamName: 'core', from: LEADER_INBOX });

    await vi.waitFor(async () => {
      expect(await service.store.unread('core', 'researcher')).toHaveLength(0);
    });
  });

  it('leaves messages unread while the teammate has no active turn', async () => {
    const { agent, turn } = fakeAgent(false);
    const { service } = await createFixture({});
    await service.sendMessage('core', LEADER_INBOX, 'researcher', 'wait for resume');

    const controller = new AbortController();
    service.startTeammateWatcher({
      teamName: 'core',
      name: 'researcher',
      agentId: 'agent-1',
      agent,
      controller,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(turn.steer).not.toHaveBeenCalled();
    expect(await service.store.unread('core', 'researcher')).toHaveLength(1);

    // Once a turn starts, the same watcher delivers the backlog.
    turn.hasActiveTurn = true;
    await vi.waitFor(() => {
      expect(turn.steer).toHaveBeenCalledTimes(1);
    });
  });

  it('stops the teammate task and acks a shutdown with no active turn', async () => {
    const { agent, turn } = fakeAgent(false);
    const { service, stopAgentTask } = await createFixture({});
    await service.requestShutdown('core', LEADER_INBOX, 'researcher', 'work is done');

    const controller = new AbortController();
    service.startTeammateWatcher({
      teamName: 'core',
      name: 'researcher',
      agentId: 'agent-1',
      agent,
      controller,
    });

    await vi.waitFor(async () => {
      expect(stopAgentTask).toHaveBeenCalledWith('agent-1', 'Shutdown requested by the leader: work is done');
      const acks = await service.store.inbox('core', LEADER_INBOX);
      expect(acks.some((message) => message.kind === 'shutdown_approved')).toBe(true);
    });
    // No active turn: nothing was steered, the request is consumed.
    expect(turn.steer).not.toHaveBeenCalled();
    expect(await service.store.unread('core', 'researcher')).toHaveLength(0);
  });

  it('delivers the shutdown notice first and stops after the grace window', async () => {
    const { agent, turn } = fakeAgent(true);
    const { service, stopAgentTask } = await createFixture({ shutdownGraceMs: 100 });
    await service.requestShutdown('core', LEADER_INBOX, 'researcher');

    const controller = new AbortController();
    service.startTeammateWatcher({
      teamName: 'core',
      name: 'researcher',
      agentId: 'agent-1',
      agent,
      controller,
    });

    await vi.waitFor(() => {
      expect(turn.steer).toHaveBeenCalledTimes(1);
    });
    expect(turn.steer.mock.calls[0]![0][0].text).toContain('shutdown');
    // Still inside the grace window: the model gets its wrap-up chance first.
    expect(stopAgentTask).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(stopAgentTask).toHaveBeenCalledWith('agent-1', 'Shutdown requested by the leader');
    });
  });

  it('aborts the run controller when the task lookup fails', async () => {
    const { agent } = fakeAgent(true);
    const { service, stopAgentTask } = await createFixture({ shutdownGraceMs: 10 });
    stopAgentTask.mockResolvedValue(false);
    await service.requestShutdown('core', LEADER_INBOX, 'researcher');

    const controller = new AbortController();
    service.startTeammateWatcher({
      teamName: 'core',
      name: 'researcher',
      agentId: 'agent-1',
      agent,
      controller,
    });

    await vi.waitFor(() => {
      expect(controller.signal.aborted).toBe(true);
    });
    expect(controller.signal.reason).toBe('Shutdown requested by the leader');
  });

  it('sends exactly one ack when the task stop itself tears the watch down', async () => {
    const { agent } = fakeAgent(true);
    const { service, stopAgentTask } = await createFixture({ shutdownGraceMs: 10 });
    await service.requestShutdown('core', LEADER_INBOX, 'researcher');

    const controller = new AbortController();
    // The real stop path aborts the run controller mid-stop; the teardown
    // must not emit a second ack.
    stopAgentTask.mockImplementation(async () => {
      controller.abort('stopped');
      return true;
    });
    service.startTeammateWatcher({
      teamName: 'core',
      name: 'researcher',
      agentId: 'agent-1',
      agent,
      controller,
    });

    await vi.waitFor(async () => {
      const acks = await service.store.inbox('core', LEADER_INBOX);
      expect(acks.filter((message) => message.kind === 'shutdown_approved')).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const acks = await service.store.inbox('core', LEADER_INBOX);
    expect(acks.filter((message) => message.kind === 'shutdown_approved')).toHaveLength(1);
  });

  it('acks a pending shutdown when the run ends during the grace window', async () => {
    const { agent } = fakeAgent(true);
    const { service, stopAgentTask } = await createFixture({ shutdownGraceMs: 60_000 });
    await service.requestShutdown('core', LEADER_INBOX, 'researcher');

    const controller = new AbortController();
    service.startTeammateWatcher({
      teamName: 'core',
      name: 'researcher',
      agentId: 'agent-1',
      agent,
      controller,
    });
    await vi.waitFor(async () => {
      expect(await service.store.unread('core', 'researcher')).toHaveLength(0);
    });

    // The run completes on its own before the grace timer fires: the stop
    // never happens, but the leader still gets the ack.
    controller.abort('run completed');
    await vi.waitFor(async () => {
      const acks = await service.store.inbox('core', LEADER_INBOX);
      expect(acks.some((message) => message.kind === 'shutdown_approved')).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(stopAgentTask).not.toHaveBeenCalled();
  });
});

describe('MailboxService leader delivery', () => {
  it('steers teammate messages into the leader agent', async () => {
    const { agent: leader, turn: leaderTurn } = fakeAgent(true);
    const { service } = await createFixture({ leader });
    service.ensureLeaderWatcher('core');
    await service.sendMessage('core', 'researcher', LEADER_INBOX, 'leader, hello');

    await vi.waitFor(() => {
      expect(leaderTurn.steer).toHaveBeenCalledTimes(1);
    });
    expect(leaderTurn.steer.mock.calls[0]![0][0].text).toContain('leader, hello');
    await vi.waitFor(async () => {
      expect(await service.store.unread('core', LEADER_INBOX)).toHaveLength(0);
    });
  });

  it('delivers each message exactly once even with fast overlapping ticks', async () => {
    const { agent: leader, turn: leaderTurn } = fakeAgent(true);
    const { service } = await createFixture({ leader, pollIntervalMs: 5 });
    service.ensureLeaderWatcher('core');
    await service.sendMessage('core', 'researcher', LEADER_INBOX, 'exactly once');

    await vi.waitFor(async () => {
      expect(await service.store.unread('core', LEADER_INBOX)).toHaveLength(0);
    });
    // Several more tick windows pass; without the in-flight guard an
    // overlapping tick would re-read the message before markRead and steer
    // it a second time.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(leaderTurn.steer).toHaveBeenCalledTimes(1);
  });

  it('keeps messages unread when the leader agent is not ready', async () => {
    const { service } = await createFixture({ leader: undefined });
    service.ensureLeaderWatcher('core');
    await service.sendMessage('core', 'researcher', LEADER_INBOX, 'held');
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(await service.store.unread('core', LEADER_INBOX)).toHaveLength(1);
  });
});

describe('MailboxService permission bridge', () => {
  const askRequest = {
    turnId: 1,
    toolCallId: 'call_bash_1',
    toolName: 'Bash',
    action: 'Run command: pnpm test',
    display: { kind: 'command' as const, command: 'pnpm test', language: 'bash' as const },
    input: { command: 'pnpm test' },
  };

  it('routes the ask through the leader\'s queue with the teammate badge (primary track)', async () => {
    const requestApproval = vi.fn(async () => ({ decision: 'approved' as const }));
    const { agent: leader } = fakeAgent(true, { requestApproval });
    const { service } = await createFixture({ leader });

    const response = await service.requestPermissionViaLeader({
      teamName: 'core',
      name: 'researcher',
      request: askRequest,
      signal: new AbortController().signal,
    });

    expect(response.decision).toBe('approved');
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'call_bash_1',
        toolName: 'Bash',
        requester: { name: 'researcher', teamName: 'core' },
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // The interactive track leaves no mailbox traffic behind.
    expect(await service.store.inbox('core', 'researcher')).toHaveLength(0);
  });

  it('passes a leader rejection through unchanged', async () => {
    const requestApproval = vi.fn(async () => ({ decision: 'rejected' as const, feedback: 'not now' }));
    const { agent: leader } = fakeAgent(true, { requestApproval });
    const { service } = await createFixture({ leader });

    const response = await service.requestPermissionViaLeader({
      teamName: 'core',
      name: 'researcher',
      request: askRequest,
      signal: new AbortController().signal,
    });
    expect(response).toEqual({ decision: 'rejected', feedback: 'not now' });
  });

  it('maps an aborted interactive wait to cancelled, never hangs', async () => {
    const requestApproval = vi.fn(
      (_payload: unknown, options?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal!.reason as unknown),
            { once: true },
          );
        }),
    );
    const { agent: leader } = fakeAgent(true, { requestApproval });
    const { service } = await createFixture({ leader });

    const controller = new AbortController();
    const pending = service.requestPermissionViaLeader({
      teamName: 'core',
      name: 'researcher',
      request: askRequest,
      signal: controller.signal,
    });
    controller.abort('task stopped');
    await expect(pending).resolves.toEqual({ decision: 'cancelled' });
  });

  it('falls back to the mailbox when the leader has no interactive handler', async () => {
    const { service } = await createFixture({ leader: undefined });

    const controller = new AbortController();
    const pending = service.requestPermissionViaLeader({
      teamName: 'core',
      name: 'researcher',
      request: askRequest,
      signal: controller.signal,
    });

    // The request is rendered into the leader's inbox with a correlation id.
    await vi.waitFor(async () => {
      const inbox = await service.store.inbox('core', LEADER_INBOX);
      expect(inbox).toHaveLength(1);
    });
    const request = (await service.store.inbox('core', LEADER_INBOX))[0]!;
    expect(request).toMatchObject({
      from: 'researcher',
      to: LEADER_INBOX,
      kind: 'permission_request',
      body: {
        toolName: 'Bash',
        toolUseId: 'call_bash_1',
        description: 'Run command: pnpm test',
        input: { command: 'pnpm test' },
      },
    });
    const requestId = (request.body as { requestId: string }).requestId;
    expect(requestId).toMatch(/^preq_[0-9a-z]{8}$/);

    // The leader answers out of band; the waiter matches by request_id.
    await service.store.send('core', {
      from: LEADER_INBOX,
      to: 'researcher',
      kind: 'permission_response',
      body: { requestId, subtype: 'success' },
    });
    await expect(pending).resolves.toEqual({ decision: 'approved' });
    // The matched response is consumed; an unrelated response stays unread.
    expect(await service.store.unread('core', 'researcher')).toHaveLength(0);
  });

  it('maps a fallback rejection (subtype error) to rejected with feedback', async () => {
    const { service } = await createFixture({ leader: undefined });
    const pending = service.requestPermissionViaLeader({
      teamName: 'core',
      name: 'researcher',
      request: askRequest,
      signal: new AbortController().signal,
    });
    await vi.waitFor(async () => {
      expect((await service.store.inbox('core', LEADER_INBOX))).toHaveLength(1);
    });
    const requestId = ((await service.store.inbox('core', LEADER_INBOX))[0]!.body as { requestId: string }).requestId;
    await service.store.send('core', {
      from: LEADER_INBOX,
      to: 'researcher',
      kind: 'permission_response',
      body: { requestId, subtype: 'error', error: 'too risky' },
    });
    await expect(pending).resolves.toEqual({ decision: 'rejected', feedback: 'too risky' });
  });

  it('denies deterministically when the fallback wait times out', async () => {
    const { service } = await createFixture({ leader: undefined, permissionRequestTimeoutMs: 40 });

    const response = await service.requestPermissionViaLeader({
      teamName: 'core',
      name: 'researcher',
      request: askRequest,
      signal: new AbortController().signal,
    });

    expect(response.decision).toBe('rejected');
    expect(response.feedback).toContain('timed out');
  });

  it('cancels a pending fallback wait when the teammate stops', async () => {
    const { service } = await createFixture({ leader: undefined });
    const controller = new AbortController();
    const pending = service.requestPermissionViaLeader({
      teamName: 'core',
      name: 'researcher',
      request: askRequest,
      signal: controller.signal,
    });
    await vi.waitFor(async () => {
      expect((await service.store.inbox('core', LEADER_INBOX))).toHaveLength(1);
    });

    controller.abort('task stopped');
    await expect(pending).resolves.toEqual({ decision: 'cancelled' });
  });
});

describe('renderMailboxMessage', () => {
  it('escapes XML in user content', async () => {
    const { service } = await createFixture({});
    // Member names are charset-restricted, so the realistic injection
    // surface is the free-form message text.
    const message = await service.sendMessage('core', LEADER_INBOX, 'researcher', 'x <y> & "z"');
    const rendered = renderMailboxMessage('core', message);
    expect(rendered).toContain('x &lt;y&gt; &amp; &quot;z&quot;');
    expect(rendered).not.toContain('<y>');
    expect(rendered).toContain('<teammate-message from="leader" team="core" kind="message">');
  });
});

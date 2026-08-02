import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import { LEADER_INBOX } from '../../src/agent/swarm/mailbox';
import { MailboxService } from '../../src/agent/swarm/mailbox-service';
import {
  createTeammateContext,
  runWithTeammateContext,
} from '../../src/agent/swarm/teammate-context';
import type { AgentMeta } from '../../src/session';
import { SendMessageTool } from '../../src/tools/builtin/collaboration/send-message';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;
const tempDirs: string[] = [];
const services: MailboxService[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createFixture(roster: Record<string, AgentMeta>): Promise<{
  mailbox: MailboxService;
  tool: SendMessageTool;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-code-send-message-'));
  tempDirs.push(dir);
  const mailbox = new MailboxService(dir, {
    roster: () => roster,
    leader: () => undefined,
    stopAgentTask: async () => true,
  });
  services.push(mailbox);
  return { mailbox, tool: new SendMessageTool(mailbox) };
}

function teammateMeta(name: string, teamName: string): AgentMeta {
  return { type: 'sub', parentAgentId: 'main', teammate: { name, teamName } };
}

function context<Input>(args: Input) {
  return { turnId: '0', toolCallId: 'call_send_message', args, signal };
}

function asTeammate<T>(name: string, teamName: string, fn: () => Promise<T>): Promise<T> {
  return runWithTeammateContext(
    createTeammateContext({
      agentId: `agent-${name}`,
      parentAgentId: 'main',
      name,
      teamName,
      abortController: new AbortController(),
    }),
    fn,
  );
}

describe('SendMessageTool', () => {
  it('lets the leader message a teammate by (team, name)', async () => {
    const { mailbox, tool } = await createFixture({ 'agent-1': teammateMeta('researcher', 'core') });

    const result = await executeTool(tool,
      context({ to: 'researcher', team_name: 'core', message: 'how is it going?' }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('Message sent to "researcher" in team "core"');
    const inbox = await mailbox.store.inbox('core', 'researcher');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      from: LEADER_INBOX,
      to: 'researcher',
      kind: 'message',
      body: { text: 'how is it going?' },
    });
  });

  it('lets a teammate message the leader with identity from the runtime context', async () => {
    const { mailbox, tool } = await createFixture({ 'agent-1': teammateMeta('researcher', 'core') });

    const result = await asTeammate('researcher', 'core', () =>
      executeTool(tool, context({ to: LEADER_INBOX, message: 'found the root cause' })),
    );

    expect(result.isError).toBeUndefined();
    const inbox = await mailbox.store.inbox('core', LEADER_INBOX);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ from: 'researcher', to: LEADER_INBOX, kind: 'message' });
  });

  it('lets teammates message each other in the same team', async () => {
    const { mailbox, tool } = await createFixture({
      'agent-1': teammateMeta('researcher', 'core'),
      'agent-2': teammateMeta('writer', 'core'),
    });

    const result = await asTeammate('researcher', 'core', () =>
      executeTool(tool, context({ to: 'writer', message: 'your section blocks mine' })),
    );

    expect(result.isError).toBeUndefined();
    const inbox = await mailbox.store.inbox('core', 'writer');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ from: 'researcher', to: 'writer' });
  });

  it('rejects unknown recipients, missing teams, and self-sends', async () => {
    const { tool } = await createFixture({ 'agent-1': teammateMeta('researcher', 'core') });

    const unknown = await executeTool(tool,
      context({ to: 'ghost', team_name: 'core', message: 'hi' }),
    );
    expect(unknown.isError).toBe(true);
    expect(unknown.output).toContain('No teammate named "ghost"');

    const noTeam = await executeTool(tool, context({ to: 'researcher', message: 'hi' }));
    expect(noTeam.isError).toBe(true);
    expect(noTeam.output).toContain('team_name is required');

    const self = await asTeammate('researcher', 'core', () =>
      executeTool(tool, context({ to: 'researcher', message: 'note to self' })),
    );
    expect(self.isError).toBe(true);
    expect(self.output).toContain('yourself');
  });

  it('rejects invalid team names', async () => {
    const { tool } = await createFixture({});
    const result = await executeTool(tool,
      context({ to: 'researcher', team_name: 'bad name', message: 'hi' }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Invalid team name');
  });

  it('sends a shutdown request as the leader and rejects it from teammates', async () => {
    const { mailbox, tool } = await createFixture({ 'agent-1': teammateMeta('researcher', 'core') });

    const byTeammate = await asTeammate('writer', 'core', () =>
      executeTool(tool,
        context({ to: 'researcher', message: { type: 'shutdown_request', reason: 'stop' } }),
      ),
    );
    expect(byTeammate.isError).toBe(true);
    expect(byTeammate.output).toContain('Only the leader');

    const byLeader = await executeTool(tool,
      context({ to: 'researcher', team_name: 'core', message: { type: 'shutdown_request', reason: 'wrap up' } }),
    );
    expect(byLeader.isError).toBeUndefined();
    const inbox = await mailbox.store.inbox('core', 'researcher');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      from: LEADER_INBOX,
      kind: 'shutdown_request',
      body: { reason: 'wrap up' },
    });
  });

  it('sends a permission response as the leader and rejects it from teammates', async () => {
    const { mailbox, tool } = await createFixture({ 'agent-1': teammateMeta('researcher', 'core') });

    const byTeammate = await asTeammate('writer', 'core', () =>
      executeTool(tool,
        context({
          to: 'researcher',
          message: { type: 'permission_response', request_id: 'preq_abc', approve: true },
        }),
      ),
    );
    expect(byTeammate.isError).toBe(true);
    expect(byTeammate.output).toContain('Only the leader');

    const byLeader = await executeTool(tool,
      context({
        to: 'researcher',
        team_name: 'core',
        message: { type: 'permission_response', request_id: 'preq_abc123', approve: false, feedback: 'too risky' },
      }),
    );
    expect(byLeader.isError).toBeUndefined();
    expect(byLeader.output).toContain('rejection');
    const inbox = await mailbox.store.inbox('core', 'researcher');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      from: LEADER_INBOX,
      kind: 'permission_response',
      body: { requestId: 'preq_abc123', subtype: 'error', error: 'too risky' },
    });
  });

  it('rejects a shutdown request addressed to the leader', async () => {
    const { tool } = await createFixture({});
    const result = await executeTool(tool,
      context({ to: LEADER_INBOX, team_name: 'core', message: { type: 'shutdown_request' } }),
    );
    expect(result.isError).toBe(true);
    // The leader addressing 'leader' is a self-send.
    expect(result.output).toContain('yourself');
  });
});

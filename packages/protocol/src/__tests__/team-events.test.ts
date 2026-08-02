import { describe, expect, it } from 'vitest';

import {
  agentEventSchema,
  eventSchema,
  mailboxActivityEventSchema,
  teamUpdatedEventSchema,
  type MailboxActivityEvent,
  type TeamUpdatedEvent,
} from '../events';

const team: TeamUpdatedEvent['team'] = {
  name: 'core',
  createdBy: 'main',
  members: [
    { name: 'researcher', agentId: 'agent-1' },
    { name: 'writer', agentId: 'agent-2' },
  ],
  tasks: [
    { id: 1, subject: 'Map ingestion', status: 'in_progress', owner: 'researcher', createdBy: 'leader', createdAt: 1 },
    { id: 2, subject: 'Profile hot path', description: 'with traces', status: 'pending', createdBy: 'leader', createdAt: 2 },
  ],
};

describe('team.updated / mailbox.activity events', () => {
  it('round-trips a full team snapshot through the event schemas', () => {
    const event: TeamUpdatedEvent = { type: 'team.updated', team };
    expect(teamUpdatedEventSchema.parse(event)).toEqual(event);
    expect(agentEventSchema.parse(event)).toEqual(event);
    expect(
      eventSchema.parse({ ...event, agentId: 'main', sessionId: 'ses-1' }),
    ).toEqual({ ...event, agentId: 'main', sessionId: 'ses-1' });
  });

  it('round-trips mailbox activity for every protocol kind', () => {
    const kinds: MailboxActivityEvent['message']['kind'][] = [
      'message',
      'task_assignment',
      'shutdown_request',
      'shutdown_approved',
      'shutdown_rejected',
      'permission_request',
      'permission_response',
    ];
    for (const kind of kinds) {
      const event: MailboxActivityEvent = {
        type: 'mailbox.activity',
        message: {
          id: 'msg_00000001',
          teamName: 'core',
          from: 'researcher',
          to: 'leader',
          kind,
          preview: 'preview',
          createdAt: '2026-07-28T10:15:00.000Z',
        },
      };
      expect(mailboxActivityEventSchema.parse(event)).toEqual(event);
      expect(agentEventSchema.parse(event)).toEqual(event);
    }
  });

  it('rejects malformed payloads', () => {
    expect(() =>
      teamUpdatedEventSchema.parse({ type: 'team.updated', team: { ...team, tasks: [{ id: 'one' }] } }),
    ).toThrow();
    expect(() =>
      mailboxActivityEventSchema.parse({
        type: 'mailbox.activity',
        message: { id: 'm', teamName: 'core', from: 'a', to: 'b', kind: 'broadcast', preview: '', createdAt: 'now' },
      }),
    ).toThrow();
  });
});

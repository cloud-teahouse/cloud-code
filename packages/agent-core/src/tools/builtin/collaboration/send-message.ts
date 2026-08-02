/**
 * SendMessageTool — team mailbox messaging.
 *
 * Addresses are (team, name): a teammate name, or 'leader' for the team
 * leader. The sender identity comes from the AsyncLocalStorage teammate
 * context ('leader' outside one), never from arguments. Plain strings go
 * out as `message` envelopes; the structured `shutdown_request` form is the
 * leader's graceful-stop verb for a teammate.
 */

import { z } from 'zod';

import { getTeammateContext } from '../../../agent/swarm/teammate-context';
import { LEADER_INBOX } from '../../../agent/swarm/mailbox';
import type { MailboxService } from '../../../agent/swarm/mailbox-service';
import { TEAM_NAME_PATTERN } from '../../../agent/swarm/team-store';
import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { normalizeName } from './team-task-shared';
import SEND_MESSAGE_DESCRIPTION from './send-message.md?raw';

export const SendMessageInputSchema = z
  .object({
    to: z
      .string()
      .trim()
      .min(1)
      .describe(`Recipient: a teammate name, or "${LEADER_INBOX}" for the team leader.`),
    team_name: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Team to address. Defaults to the calling teammate\'s team; required for the leader.'),
    message: z
      .union([
        z.string().min(1).describe('Plain text message content.'),
        z
          .object({
            type: z.literal('shutdown_request'),
            reason: z.string().optional(),
          })
          .describe('Structured protocol message (leader only): ask the teammate to shut down.'),
        z
          .object({
            type: z.literal('permission_response'),
            request_id: z.string().describe('The request_id from the permission_request being answered.'),
            approve: z.boolean().describe('true to approve the tool call, false to reject it.'),
            feedback: z.string().optional().describe('Optional reason, shown to the teammate on rejection.'),
          })
          .describe('Structured protocol message (leader only): answer a teammate\'s permission request.'),
      ])
      .describe('Message content: plain text, or a structured protocol message.'),
    summary: z
      .string()
      .optional()
      .describe('Optional 5-10 word preview of the message for UI surfaces.'),
  })
  .strict();

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export class SendMessageTool implements BuiltinTool<SendMessageInput> {
  readonly name = 'SendMessage' as const;
  readonly description = SEND_MESSAGE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SendMessageInputSchema);

  constructor(private readonly mailbox: MailboxService) {}

  resolveExecution(args: SendMessageInput): ToolExecution {
    const summary = typeof args.message === 'string' ? args.message : args.message.type;
    return {
      accesses: ToolAccesses.none(),
      description: `Sending message to ${args.to}: ${summary.slice(0, 60)}`,
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private async execution(args: SendMessageInput): Promise<ExecutableToolResult> {
    const caller = getTeammateContext();
    const teamName = normalizeName(args.team_name) ?? caller?.teamName;
    if (teamName === undefined) {
      return {
        output:
          'team_name is required: pass the team explicitly, or call from a teammate that belongs to one.',
        isError: true,
        display: { key: 'toolResult.team.teamNameRequired' },
      };
    }
    if (!TEAM_NAME_PATTERN.test(teamName)) {
      return {
        output: `Invalid team name "${teamName}": use letters, digits, dashes, or underscores, starting with a letter or digit.`,
        isError: true,
        display: { key: 'toolResult.team.teamNameInvalid', params: { team: teamName } },
      };
    }

    const from = caller?.name ?? LEADER_INBOX;
    const to = args.to.trim();
    if (to === from) {
      return {
        output: 'Cannot send a message to yourself.',
        isError: true,
        display: { key: 'toolResult.sendMessage.cannotSendToSelf' },
      };
    }
    const resolved = this.mailbox.resolveRecipient(teamName, to);
    if (!resolved.ok) {
      return { output: resolved.error, isError: true };
    }

    if (typeof args.message === 'string') {
      const message = await this.mailbox.sendMessage(
        teamName,
        from,
        to,
        args.message,
        normalizeName(args.summary),
      );
      const delivery =
        to === LEADER_INBOX
          ? 'The leader is notified in a later turn.'
          : 'A running teammate receives it mid-run; otherwise it is delivered on their next resume.';
      return {
        output: `Message sent to "${to}" in team "${teamName}" (id: ${message.id}). ${delivery}`,
        display:
          to === LEADER_INBOX
            ? {
                key: 'toolResult.sendMessage.sentLeader',
                params: { team: teamName, id: message.id },
              }
            : {
                key: 'toolResult.sendMessage.sent',
                params: { to, team: teamName, id: message.id },
              },
      };
    }

    // Structured protocol messages. Only the leader may issue them — a
    // teammate must not stop its peers nor answer its own permission asks.
    if (from !== LEADER_INBOX) {
      return {
        output: `Only the leader can send a ${args.message.type}. Teammates message each other with plain text.`,
        isError: true,
        display: { key: 'toolResult.sendMessage.leaderOnly', params: { type: args.message.type } },
      };
    }
    if (to === LEADER_INBOX) {
      return {
        output: `Cannot send a ${args.message.type} to the leader.`,
        isError: true,
        display: {
          key: 'toolResult.sendMessage.cannotSendStructuredToLeader',
          params: { type: args.message.type },
        },
      };
    }
    if (args.message.type === 'permission_response') {
      const message = await this.mailbox.store.send(teamName, {
        from,
        to,
        kind: 'permission_response',
        body: {
          requestId: args.message.request_id,
          subtype: args.message.approve ? 'success' : 'error',
          error: args.message.approve ? undefined : (args.message.feedback ?? 'Rejected by the leader'),
        },
      });
      return {
        output:
          `Permission ${args.message.approve ? 'approval' : 'rejection'} sent to "${to}" in team "${teamName}" ` +
          `(request ${args.message.request_id}, id: ${message.id}).`,
        display: {
          key: args.message.approve
            ? 'toolResult.sendMessage.permissionApprovalSent'
            : 'toolResult.sendMessage.permissionRejectionSent',
          params: { to, team: teamName, requestId: args.message.request_id, id: message.id },
        },
      };
    }
    const message = await this.mailbox.requestShutdown(teamName, from, to, args.message.reason);
    return {
      output:
        `Shutdown request sent to "${to}" in team "${teamName}" (id: ${message.id}). ` +
        'The teammate gets a short wrap-up window before its task is stopped; you are notified when it acknowledges.',
      display: {
        key: 'toolResult.sendMessage.shutdownSent',
        params: { to, team: teamName, id: message.id },
      },
    };
  }
}

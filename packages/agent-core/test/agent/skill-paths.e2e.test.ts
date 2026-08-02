/**
 * `paths`-gated skill activation — end-to-end agent tests.
 *
 * Drives the full chain with the scripted-generate harness: a Write tool call
 * touching a matching file activates the conditional skill mid-turn, the
 * `<skills_activated>` announcement lands at the message-stream tail, the
 * Skill tool can then invoke it, and the system-prompt/tools hashes never
 * move (activation is a tail event, never a prefix rewrite).
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ToolCall } from '@cloud-code/kosong';

import type { AgentRecord } from '../../src/agent';
import { InMemoryAgentRecordPersistence } from '../../src/agent/records';
import { foldAnnouncedActivatedSkillNames } from '../../src/agent/injection/skill-activation';
import { SessionSkillRegistry } from '../../src/skill/registry';
import { testAgent, type TestAgentContext } from './harness/agent';

function conditionalRegistry(): SessionSkillRegistry {
  const registry = new SessionSkillRegistry();
  registry.register({
    name: 'api-lore',
    description: 'API design lore',
    path: '/skills/api-lore/SKILL.md',
    dir: '/skills/api-lore',
    content: 'body of api-lore',
    metadata: { paths: ['src/api/**'] },
    source: 'project',
  });
  return registry;
}

function writeCall(id: string, filePath: string): ToolCall {
  return {
    type: 'function',
    id,
    name: 'Write',
    arguments: JSON.stringify({ path: filePath, content: 'export const x = 1;\n' }),
  };
}

function skillCall(id: string, skill: string): ToolCall {
  return {
    type: 'function',
    id,
    name: 'Skill',
    arguments: JSON.stringify({ skill }),
  };
}

async function runTurn(ctx: TestAgentContext, prompt: string): Promise<void> {
  await ctx.rpc.prompt({ input: [{ type: 'text', text: prompt }] });
  await ctx.untilTurnEnd();
}

function historyText(ctx: TestAgentContext): string {
  return ctx.agent.context.history
    .flatMap((m) => m.content)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

async function skillAgent(
  persistence?: InMemoryAgentRecordPersistence,
): Promise<{ ctx: TestAgentContext; registry: SessionSkillRegistry }> {
  const registry = conditionalRegistry();
  const ctx = testAgent({ skills: registry, persistence });
  ctx.configure();
  // Write into a tmp workspace, never the repo checkout.
  const workDir = await mkdtemp(path.join(tmpdir(), 'skill-paths-e2e-'));
  ctx.agent.config.update({ cwd: workDir });
  // Rebuild builtins so the Write tool's workspace anchors at the tmp cwd.
  await ctx.rpc.setActiveTools({ names: ['Write', 'Skill'] });
  await ctx.rpc.setPermission({ mode: 'yolo' });
  return { ctx, registry };
}

describe('paths-gated skill activation (e2e)', () => {
  it('activates on a matching Write, announces at the tail, and the Skill tool can invoke it', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const { ctx, registry } = await skillAgent(persistence);

    // Before the touch: invisible and un-invocable.
    expect(registry.getSkill('api-lore')).toBeUndefined();
    expect(registry.getModelSkillListing()).not.toContain('api-lore');

    ctx.mockNextResponse({ type: 'text', text: 'writing' }, writeCall('call-1', 'src/api/foo.ts'));
    ctx.mockNextResponse({ type: 'text', text: 'written' });
    await runTurn(ctx, 'create the api file');

    // Activated in the registry; announced once at the message tail.
    expect(registry.getSkill('api-lore')?.name).toBe('api-lore');
    expect([...foldAnnouncedActivatedSkillNames(ctx.agent.context.history)]).toEqual(['api-lore']);
    const text = historyText(ctx);
    expect(text).toContain('<skills_activated>\napi-lore\n</skills_activated>');
    expect(text).toContain('- api-lore: API design lore');
    // The announcement sits AFTER the Write tool result in the stream.
    const history = ctx.agent.context.history;
    const writeResultIndex = history.findIndex((m) => m.role === 'tool');
    const announcementIndex = history.findIndex(
      (m) => m.origin?.kind === 'system_trigger' && m.origin.name === 'skill_activation',
    );
    expect(writeResultIndex).toBeGreaterThanOrEqual(0);
    expect(announcementIndex).toBeGreaterThan(writeResultIndex);

    // Prefix invariant: activation never rewrote the system prompt or tools.
    const requests = persistence.records.filter(
      (record): record is Extract<AgentRecord, { type: 'llm.request' }> =>
        record.type === 'llm.request',
    );
    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const request of requests) {
      expect(request.systemPromptHash).toBe(requests[0]!.systemPromptHash);
      expect(request.toolsHash).toBe(requests[0]!.toolsHash);
    }

    // The model can now invoke the skill through the Skill tool.
    ctx.mockNextResponse({ type: 'text', text: 'invoking' }, skillCall('call-2', 'api-lore'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await runTurn(ctx, 'use the lore');
    expect(historyText(ctx)).toContain('body of api-lore');

    // Second turn boundary: the folded announcement covers the active skill,
    // so no duplicate announcement was appended.
    const announcements = ctx.agent.context.history.filter(
      (m) => m.origin?.kind === 'system_trigger' && m.origin.name === 'skill_activation',
    );
    expect(announcements).toHaveLength(1);
  });

  it('does not activate on non-matching paths', async () => {
    const { ctx, registry } = await skillAgent();

    ctx.mockNextResponse({ type: 'text', text: 'writing' }, writeCall('call-1', 'src/web/app.ts'));
    ctx.mockNextResponse({ type: 'text', text: 'written' });
    await runTurn(ctx, 'create the web file');

    expect(registry.getSkill('api-lore')).toBeUndefined();
    expect(registry.hasPendingConditionalSkills()).toBe(true);
    expect(historyText(ctx)).not.toContain('<skills_activated>');
  });

  it('activates on a Bash command touching a matching path', async () => {
    const { ctx, registry } = await skillAgent();
    await ctx.rpc.setActiveTools({ names: ['Write', 'Skill', 'Bash'] });

    // The command must succeed for the touch to count (failed results do not
    // activate); `echo` of a matching path is the minimal successful touch.
    ctx.mockNextResponse(
      { type: 'text', text: 'inspecting' },
      {
        type: 'function',
        id: 'call-1',
        name: 'Bash',
        arguments: JSON.stringify({ command: 'echo src/api/foo.ts' }),
      },
    );
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await runTurn(ctx, 'look at the api');

    expect(registry.getSkill('api-lore')?.name).toBe('api-lore');
    expect(historyText(ctx)).toContain('<skills_activated>\napi-lore\n</skills_activated>');
  });
});

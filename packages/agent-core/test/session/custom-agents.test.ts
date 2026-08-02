import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { SessionSubagentHost } from '../../src/session/subagent-host';
import { AgentTool } from '../../src/tools/builtin/collaboration/agent';
import { createBackgroundManager } from '../agent/background/helpers';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('Session custom agents', () => {
  it('loads file-based agents from the user and project agents dirs', async () => {
    const userHome = await mkdtemp(join(tmpdir(), 'kimi-custom-agents-home-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'kimi-custom-agents-proj-'));
    tempDirs.push(userHome, projectDir);
    await mkdir(join(userHome, 'agents'), { recursive: true });
    await mkdir(join(projectDir, '.cloud-code', 'agents'), { recursive: true });
    await writeFile(
      join(userHome, 'agents', 'reviewer.md'),
      '---\ndescription: User reviewer\n---\nUser body.\n',
    );
    await writeFile(
      join(projectDir, '.cloud-code', 'agents', 'reviewer.md'),
      '---\ndescription: Project reviewer\n---\nProject body.\n',
    );
    await writeFile(
      join(projectDir, '.cloud-code', 'agents', 'helper.md'),
      '---\ndescription: Helper agent\n---\nHelper body.\n',
    );

    const session = new Session({
      id: 'test-custom-agents',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
        getcwd: () => projectDir,
      }),
      homedir: '/tmp/kimi-session',
      cloudCodeHomeDir: userHome,
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });
    await session.waitForCustomAgents();
    // The agentfile catalog (subagent delegation listing) discovers the same
    // dirs on its own schedule.
    await session.agentCatalog.ready;

    const profiles = session.getAgentProfiles();
    // The project-level definition wins over the user-level one.
    expect(profiles['reviewer']?.description).toBe('Project reviewer');
    expect(profiles['helper']?.description).toBe('Helper agent');
    expect(profiles['agent']?.subagents?.['reviewer']).toBe(profiles['reviewer']);
    // Builtin profiles stay available and unmodified.
    expect(profiles['coder']?.description).toContain('General software engineering agent');

    const host = new SessionSubagentHost(session, 'main');
    const tool = new AgentTool(
      host,
      createBackgroundManager().manager,
      host.delegatableSubagents(),
    );
    expect(tool.description).toContain('- reviewer: Project reviewer');
    expect(tool.description).toContain('- helper: Helper agent');
  });

  it('keeps only the builtin profiles when no agents dirs exist', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'kimi-custom-agents-empty-'));
    tempDirs.push(projectDir);

    const session = new Session({
      id: 'test-custom-agents-empty',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
        getcwd: () => projectDir,
      }),
      homedir: '/tmp/kimi-session',
      cloudCodeHomeDir: join(projectDir, 'no-such-home'),
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });
    await session.waitForCustomAgents();

    expect(session.getAgentProfiles()['agent']?.subagents?.['coder']).toBeDefined();
    expect(Object.keys(session.getAgentProfiles()).toSorted()).toEqual([
      'agent',
      'coder',
      'explore',
      'plan',
    ]);
  });
});

function createSessionRpc(): SDKSessionRPC {
  return new Proxy(
    {},
    {
      get: () => vi.fn(),
    },
  ) as SDKSessionRPC;
}

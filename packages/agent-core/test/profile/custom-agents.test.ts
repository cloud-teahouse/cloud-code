import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../src/logging';
import {
  DEFAULT_AGENT_PROFILES,
  loadCustomAgentProfiles,
  resolveDefaultAgentProfiles,
  type SystemPromptContext,
} from '../../src/profile';
import type { SessionSubagentHost } from '../../src/session/subagent-host';
import { AgentTool } from '../../src/tools/builtin/collaboration/agent';
import { createBackgroundManager } from '../agent/background/helpers';

let workDir: string;
let userDir: string;
let projectDir: string;

const promptContext: SystemPromptContext = {
  osEnv: {
    osKind: 'macOS',
    osArch: 'arm64',
    osVersion: '0',
    shellName: 'bash',
    shellPath: '/bin/bash',
  },
  cwd: '/workspace',
  now: '2026-05-09T00:00:00.000Z',
  cwdListing: 'README.md',
  agentsMd: 'Project instructions.',
  skills: 'Available test skills.',
};

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kimi-custom-agents-'));
  userDir = join(workDir, 'user', 'agents');
  projectDir = join(workDir, 'project', '.cloud-code', 'agents');
  await mkdir(userDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('loadCustomAgentProfiles', () => {
  it('loads markdown agents and applies field defaults', async () => {
    await write(
      userDir,
      'reviewer.md',
      `
---
name: pr-reviewer
description: Reviews pull requests
tools: Read, Grep, Bash
model: fast-model
---

You review pull requests thoroughly.
`,
    );
    await write(
      userDir,
      'helper.md',
      `
---
description: Helps with chores
---

You help with chores.
`,
    );

    const raws = await loadCustomAgentProfiles({ userDir });

    expect(raws).toHaveLength(2);
    const reviewer = raws.find((raw) => raw.name === 'pr-reviewer');
    const helper = raws.find((raw) => raw.name === 'helper');
    expect(reviewer).toMatchObject({
      extends: 'agent',
      description: 'Reviews pull requests',
      tools: ['Read', 'Grep', 'Bash'],
      model: 'fast-model',
      promptVars: { roleAdditional: 'You review pull requests thoroughly.' },
    });
    // `name` defaults to the file name; omitted tools/model stay undefined so
    // they inherit from the root profile during resolution.
    expect(helper).toMatchObject({ extends: 'agent', description: 'Helps with chores' });
    expect(helper?.tools).toBeUndefined();
    expect(helper?.model).toBeUndefined();
  });

  it('lets project-level definitions override user-level ones and rejects builtin names', async () => {
    const warnings: string[] = [];
    const log = captureWarnings(warnings);
    await write(userDir, 'reviewer.md', agentMd('User reviewer', 'User body.'));
    await write(projectDir, 'reviewer.md', agentMd('Project reviewer', 'Project body.'));
    await write(projectDir, 'helper.md', agentMd('Project helper', 'Helper body.'));
    await write(projectDir, 'coder.md', agentMd('Shadowed builtin', 'Shadow body.'));

    const raws = await loadCustomAgentProfiles({
      userDir,
      projectDir,
      reservedNames: new Set(Object.keys(DEFAULT_AGENT_PROFILES)),
      log,
    });

    expect(raws.map((raw) => raw.name).toSorted()).toEqual(['helper', 'reviewer']);
    expect(raws.find((raw) => raw.name === 'reviewer')?.description).toBe('Project reviewer');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('shadows a builtin profile');

    const profiles = resolveDefaultAgentProfiles(raws);
    expect(profiles['reviewer']?.description).toBe('Project reviewer');
    // The builtin coder profile is resolved from the bundled YAML, not the file.
    expect(profiles['coder']?.description).toBe(DEFAULT_AGENT_PROFILES['coder']?.description);
    expect(profiles['coder']?.description).not.toBe('Shadowed builtin');
  });

  it('skips invalid files with a warning and keeps the valid ones', async () => {
    const warnings: string[] = [];
    const log = captureWarnings(warnings);
    await write(projectDir, 'no-description.md', '---\nname: no-desc\n---\nBody without description.\n');
    await write(projectDir, 'broken.md', '---\ndescription: [unclosed\n---\nBody.\n');
    await write(projectDir, 'good.md', agentMd('Good agent', 'Good body.'));

    const raws = await loadCustomAgentProfiles({ projectDir, log });

    expect(raws.map((raw) => raw.name)).toEqual(['good']);
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).toContain('invalid');
  });

  it('returns an empty list when the agents directories do not exist', async () => {
    const raws = await loadCustomAgentProfiles({
      userDir: join(workDir, 'missing-user'),
      projectDir: join(workDir, 'missing-project'),
    });

    expect(raws).toEqual([]);
  });

  it('loads plugin agents as the third source, namespaced as pluginId:name', async () => {
    const pluginAgentsDir = join(workDir, 'plugin', 'agents');
    await mkdir(pluginAgentsDir, { recursive: true });
    await write(pluginAgentsDir, 'reviewer.md', agentMd('Plugin reviewer', 'Plugin body.'));
    // A plugin file named like a builtin profile must NOT be treated as
    // shadowing: the namespace prefix makes the collision impossible.
    await write(pluginAgentsDir, 'coder.md', agentMd('Plugin coder', 'Plugin coder body.'));

    const raws = await loadCustomAgentProfiles({
      userDir,
      projectDir,
      pluginDirs: [{ pluginId: 'superpowers', path: pluginAgentsDir }],
      reservedNames: new Set(Object.keys(DEFAULT_AGENT_PROFILES)),
    });

    expect(raws.map((raw) => raw.name).toSorted()).toEqual([
      'superpowers:coder',
      'superpowers:reviewer',
    ]);
    const reviewer = raws.find((raw) => raw.name === 'superpowers:reviewer');
    expect(reviewer).toMatchObject({
      extends: 'agent',
      description: 'Plugin reviewer',
      promptVars: { roleAdditional: 'Plugin body.' },
    });
  });

  it('lets user/project agents and plugin agents coexist without interference', async () => {
    const pluginAgentsDir = join(workDir, 'plugin', 'agents');
    await mkdir(pluginAgentsDir, { recursive: true });
    await write(userDir, 'reviewer.md', agentMd('User reviewer', 'User body.'));
    // Same base name as a user agent: namespacing keeps both.
    await write(pluginAgentsDir, 'reviewer.md', agentMd('Plugin reviewer', 'Plugin body.'));

    const raws = await loadCustomAgentProfiles({
      userDir,
      projectDir,
      pluginDirs: [{ pluginId: 'acme', path: pluginAgentsDir }],
    });

    expect(raws.map((raw) => raw.name).toSorted()).toEqual(['acme:reviewer', 'reviewer']);
    expect(raws.find((raw) => raw.name === 'reviewer')?.description).toBe('User reviewer');
  });
});

describe('resolveDefaultAgentProfiles with custom agents', () => {
  it('links custom agents as subagents and renders the body via roleAdditional', async () => {
    await write(
      projectDir,
      'reviewer.md',
      `
---
description: Reviews pull requests
tools: Read, Grep
model: fast-model
---

You review pull requests thoroughly.
`,
    );
    await write(projectDir, 'helper.md', agentMd('Helps with chores', 'You help with chores.'));
    const raws = await loadCustomAgentProfiles({ projectDir });

    const profiles = resolveDefaultAgentProfiles(raws);

    expect(profiles['agent']?.subagents?.['reviewer']).toBe(profiles['reviewer']);
    expect(profiles['agent']?.subagents?.['helper']).toBe(profiles['helper']);
    // Bundled subagents remain linked alongside the custom ones.
    expect(profiles['agent']?.subagents?.['coder']).toBe(profiles['coder']);

    // The markdown body slots into the base template's ROLE_ADDITIONAL
    // placeholder; the rest of the shared system prompt stays intact.
    const prompt = profiles['reviewer']?.systemPrompt(promptContext) ?? '';
    expect(prompt).toContain('You review pull requests thoroughly.');
    expect(prompt).toContain('You are Cloud Code CLI');
    expect(prompt).toContain('/workspace');

    expect(profiles['reviewer']?.tools).toEqual(['Read', 'Grep']);
    expect(profiles['reviewer']?.model).toBe('fast-model');
    // Omitted tools inherit the root agent profile's tool set.
    expect(profiles['helper']?.tools).toEqual(DEFAULT_AGENT_PROFILES['agent']?.tools);
  });

  it('includes custom agents in the Agent tool description', async () => {
    await write(
      projectDir,
      'reviewer.md',
      `
---
description: Reviews pull requests
tools: Read, Grep
---

You review pull requests thoroughly.
`,
    );
    const raws = await loadCustomAgentProfiles({ projectDir });
    const profiles = resolveDefaultAgentProfiles(raws);
    const host = { spawn: vi.fn(), resume: vi.fn() } as unknown as SessionSubagentHost;

    const tool = new AgentTool(
      host,
      createBackgroundManager().manager,
      profiles['agent']?.subagents,
    );

    expect(tool.description).toContain('Available agent types');
    expect(tool.description).toContain('- reviewer: Reviews pull requests');
    expect(tool.description).toContain('- coder:');
  });
});

async function write(dir: string, fileName: string, content: string): Promise<void> {
  await writeFile(join(dir, fileName), `${content.trim()}\n`, 'utf-8');
}

function agentMd(description: string, body: string): string {
  return `---\ndescription: ${description}\n---\n${body}\n`;
}

function captureWarnings(warnings: string[]): Logger {
  return {
    warn: (message) => {
      warnings.push(message);
    },
    error: () => {},
    info: () => {},
    debug: () => {},
    createChild: () => captureWarnings(warnings),
  };
}

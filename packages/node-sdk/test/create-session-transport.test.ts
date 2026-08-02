/**
 * Scenario: KimiHarness session creation and resume transport behavior.
 * Responsibilities: SDK options reach the in-process core and session identity remains stable.
 * Wiring: the real SDK/core are used; model/network boundaries are configured but never called.
 * Run: pnpm -C packages/node-sdk exec vitest run test/create-session-transport.test.ts
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Kaos } from '@cloud-code/kaos';
import { createCloudCodeHarness, CloudCodeHarness } from '#/index';
import type { CloudCodeError } from '#/index';
import type { ResumeSessionInput, ResumedSessionSummary } from '#/types';
import { SDKRpcClientBase } from '#/rpc';
import { afterEach, describe, expect, it } from 'vitest';

import { waitForAgentWireEvent } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

// node-sdk/agent-core normalize paths to forward slashes (pathe). Mirror that
// in path assertions so they hold on Windows, where node:path produces
// backslashes.
const toPosix = (p: string): string => p.replaceAll('\\', '/');

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-create-'));
  tempDirs.push(dir);
  return dir;
}

async function writeTestModelConfig(homeDir: string, modelName = 'kimi-test-model'): Promise<void> {
  await writeFile(
    join(homeDir, 'config.toml'),
    `
[providers.local]
type = "kimi"
base_url = "https://example.test/v1"
api_key = "sk-test"

[models."${modelName}"]
provider = "local"
model = "${modelName}"
max_context_size = 1000
`,
    'utf-8',
  );
}

async function writeReviewerAgent(workDir: string): Promise<void> {
  const agentDir = join(workDir, '.cloud-code', 'agents');
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews code.\nsubagents:\n  - explore\n---\n\nReview the requested change.\n',
    'utf-8',
  );
}

class StubRpc extends SDKRpcClientBase {
  resumeCalls: Array<{ input: ResumeSessionInput; kaos: Kaos; persistenceKaos?: Kaos }> = [];

  protected async getRpc(): Promise<never> {
    throw new Error('not used');
  }

  override async createSession(input: { id?: string; workDir: string }) {
    return {
      id: input.id ?? 'ses_stub',
      workDir: input.workDir,
      sessionDir: '/tmp/session',
      createdAt: 1,
      updatedAt: 1,
    };
  }

  override async resumeSessionWithKaos(input: ResumeSessionInput, kaos: Kaos, persistenceKaos?: Kaos): Promise<ResumedSessionSummary> {
    this.resumeCalls.push({ input, kaos, persistenceKaos });
    return {
      id: input.id,
      workDir: '/tmp/work',
      sessionDir: '/tmp/session',
      createdAt: 1,
      updatedAt: 1,
      sessionMetadata: {
        createdAt: '',
        updatedAt: '',
        title: '',
        isCustomTitle: false,
        agents: {},
        custom: {},
      },
      agents: {},
    };
  }
}

describe('CloudCodeHarness.createSession transport link', () => {
  it('creates metadata and keeps the session active in the harness', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    const harness = createCloudCodeHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: 'ses_transport_link',
        workDir,
        model: 'kimi-test-model',
      });

      expect(session.id).toBe('ses_transport_link');
      expect(session.workDir).toBe(toPosix(workDir));
      await expect(session.getStatus()).resolves.toMatchObject({ model: 'kimi-test-model' });
      expect(harness.sessions.get(session.id)).toBe(session);
      const configEvent = await waitForAgentWireEvent(
        homeDir,
        session.id,
        'config.update',
        (event) => event['modelAlias'] === 'kimi-test-model',
      );
      expect(configEvent).toMatchObject({
        type: 'config.update',
        modelAlias: 'kimi-test-model',
      });
      expect(configEvent).not.toHaveProperty('provider');

      const summaries = await harness.listSessions({ workDir });
      const summary = summaries.find((item) => item.id === session.id);
      expect(summary?.sessionDir).not.toBe(join(homeDir, 'sessions', session.id));
      expect(summary?.sessionDir).toContain(toPosix(join(homeDir, 'sessions')));
      expect(existsSync(join(summary!.sessionDir, 'state.json'))).toBe(true);
      expect(await readFile(join(homeDir, 'session_index.jsonl'), 'utf-8')).toContain(session.id);

      const summariesById = await harness.listSessions({ sessionId: session.id });
      expect(summariesById).toHaveLength(1);
      expect(summariesById[0]).toMatchObject({
        id: session.id,
        workDir: toPosix(workDir),
      });
      await expect(harness.listSessions({ sessionId: 'ses_missing' })).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('accepts configured model aliases while creating the core session', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeFile(
      join(homeDir, 'config.toml'),
      `
default_model = "alias-model"

[providers.local]
type = "openai"
base_url = "https://example.test/v1"
api_key = "sk-test"

[models.alias-model]
provider = "local"
model = "real-model"
max_context_size = 1000

[thinking]
effort = "medium"
`,
      'utf-8',
    );
    const harness = createCloudCodeHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_alias_model', workDir });
      expect(session.id).toBe('ses_alias_model');
      await expect(session.getStatus()).resolves.toMatchObject({ model: 'alias-model' });
      expect(harness.sessions.get(session.id)).toBe(session);
      const configEvent = await waitForAgentWireEvent(
        homeDir,
        session.id,
        'config.update',
        (event) => event['modelAlias'] === 'alias-model',
      );
      expect(configEvent).toMatchObject({
        type: 'config.update',
        modelAlias: 'alias-model',
      });
      expect(configEvent).not.toHaveProperty('provider');
    } finally {
      await harness.close();
    }
  });

  it('does not require provider config or API keys before prompt is implemented', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createCloudCodeHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_empty_config', workDir });
      expect(session.id).toBe('ses_empty_config');
      expect((await session.getStatus()).model).toBeUndefined();
      expect(harness.sessions.get(session.id)).toBe(session);
    } finally {
      await harness.close();
    }
  });

  it('requires a non-empty workDir on createSession', async () => {
    const homeDir = await makeTempDir();
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await expect(
        harness.createSession({ id: 'ses_missing_workdir' } as never),
      ).rejects.toMatchObject({
        name: 'CloudCodeError',
        code: 'request.work_dir_required',
      } satisfies Partial<CloudCodeError>);
      await expect(
        harness.createSession({ id: 'ses_blank_workdir', workDir: '   ' }),
      ).rejects.toMatchObject({
        name: 'CloudCodeError',
        code: 'request.work_dir_required',
      } satisfies Partial<CloudCodeError>);
    } finally {
      await harness.close();
    }
  });

  it('does not persist a session record when MCP config validation fails', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    // Project-local mcp.json is intentionally ignored, so plant the malformed
    // file under the user home dir where the loader actually reads from.
    await writeFile(join(homeDir, 'mcp.json'), '{not json}', 'utf-8');
    const harness = createCloudCodeHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await expect(
        harness.createSession({ id: 'ses_bad_mcp_config', workDir }),
      ).rejects.toMatchObject({
        name: 'CloudCodeError',
        code: 'config.invalid',
      });
      expect(await harness.listSessions({ workDir })).toEqual([]);
      expect(existsSync(join(homeDir, 'session_index.jsonl'))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('does not persist a session record when the requested agent profile is missing', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createCloudCodeHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await expect(
        harness.createSession({
          id: 'ses_missing_agent_profile',
          workDir,
          agentProfile: 'missing-agent',
        }),
      ).rejects.toMatchObject({
        name: 'CloudCodeError',
        code: 'agent.not_found',
      });
      expect(await harness.listSessions({ workDir })).toEqual([]);
      expect(existsSync(join(homeDir, 'session_index.jsonl'))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('allows the session ID to be reused after agent profile selection fails', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createCloudCodeHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await expect(
        harness.createSession({
          id: 'ses_reusable_after_missing_profile',
          workDir,
          agentProfile: 'missing-agent',
        }),
      ).rejects.toMatchObject({ code: 'agent.not_found' });

      await expect(
        harness.createSession({
          id: 'ses_reusable_after_missing_profile',
          workDir,
        }),
      ).resolves.toMatchObject({ id: 'ses_reusable_after_missing_profile' });
    } finally {
      await harness.close();
    }
  });

  it('does not persist a session record when an explicit agent file cannot be loaded', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createCloudCodeHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await expect(
        harness.createSession({
          id: 'ses_missing_explicit_agent_file',
          workDir,
          agentFiles: [join(workDir, 'missing-agent.md')],
        }),
      ).rejects.toThrow(/missing-agent\.md/);
      expect(await harness.listSessions({ workDir })).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('closes active runtime handles through closeSession, session.close, and close', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    const harness = createCloudCodeHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    const first = await harness.createSession({
      id: 'ses_close_one',
      workDir,
      model: 'kimi-test-model',
    });
    const second = await harness.createSession({
      id: 'ses_close_two',
      workDir,
      model: 'kimi-test-model',
    });
    expect(coreSessionIds(harness)).toEqual([first.id, second.id]);

    await harness.closeSession(first.id);
    expect(harness.getSession(first.id)).toBeUndefined();
    expect(coreSessionIds(harness)).toEqual([second.id]);

    await second.close();
    expect(harness.getSession(second.id)).toBeUndefined();
    expect(coreSessionIds(harness)).toEqual([]);

    await harness.close();
    expect(harness.sessions.size).toBe(0);
    expect(coreSessionIds(harness)).toEqual([]);
  });

  it('permanently deletes an active session', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createCloudCodeHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_delete_active', workDir });
      const [summary] = await harness.listSessions({ sessionId: session.id });

      await harness.deleteSession(session.id);

      expect(harness.getSession(session.id)).toBeUndefined();
      await expect(harness.listSessions({ sessionId: session.id })).resolves.toEqual([]);
      expect(existsSync(summary!.sessionDir)).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('returns session.not_found when deleteSession targets a missing id', async () => {
    const homeDir = await makeTempDir();
    const harness = createCloudCodeHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await expect(harness.deleteSession('ses_delete_missing')).rejects.toMatchObject({
        name: 'CloudCodeError',
        code: 'session.not_found',
      } satisfies Partial<CloudCodeError>);
    } finally {
      await harness.close();
    }
  });

  it('allows a deleted session id to be created again', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createCloudCodeHarness({ identity: TEST_IDENTITY, homeDir });
    const sessionId = 'ses_delete_recreate';

    try {
      await harness.createSession({ id: sessionId, workDir });
      await harness.deleteSession(sessionId);

      const recreated = await harness.createSession({ id: sessionId, workDir });

      expect(recreated.id).toBe(sessionId);
      await expect(harness.listSessions({ sessionId })).resolves.toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it('preserves a legacy source directory referenced by session metadata', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const legacySourceDir = await makeTempDir();
    const markerPath = join(legacySourceDir, 'legacy-marker.txt');
    await writeFile(markerPath, 'legacy source remains', 'utf-8');
    const harness = createCloudCodeHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      const session = await harness.createSession({
        id: 'ses_delete_migrated',
        workDir,
        metadata: { kimi_cli_source_path: legacySourceDir },
      });

      await harness.deleteSession(session.id);

      await expect(readFile(markerPath, 'utf-8')).resolves.toBe('legacy source remains');
    } finally {
      await harness.close();
    }
  });

  it('applies initial thinking and permission runtime options', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createCloudCodeHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: 'ses_initial_runtime_options',
        workDir,
        thinking: 'low',
        permission: 'auto',
      });

      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          'config.update',
          (event) => event['thinkingEffort'] === 'low',
        ),
      ).resolves.toMatchObject({
        type: 'config.update',
        thinkingEffort: 'low',
      });
      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          'permission.set_mode',
          (event) => event['mode'] === 'auto',
        ),
      ).resolves.toMatchObject({
        type: 'permission.set_mode',
        mode: 'auto',
      });
    } finally {
      await harness.close();
    }
  });

  it('applies configured default permission mode to new sessions', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeFile(join(homeDir, 'config.toml'), 'default_permission_mode = "auto"\n', 'utf-8');
    const harness = createCloudCodeHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: 'ses_default_permission_mode',
        workDir,
      });

      await expect(session.getStatus()).resolves.toMatchObject({ permission: 'auto' });
      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          'permission.set_mode',
          (event) => event['mode'] === 'auto',
        ),
      ).resolves.toMatchObject({
        type: 'permission.set_mode',
        mode: 'auto',
      });

      const explicit = await harness.createSession({
        id: 'ses_default_permission_explicit_override',
        workDir,
        permission: 'manual',
      });
      await expect(explicit.getStatus()).resolves.toMatchObject({ permission: 'manual' });
    } finally {
      await harness.close();
    }
  });

  it('rebinds an active session when resumeSession receives a new Kaos', async () => {
    const rpc = new StubRpc();
    const harness = new CloudCodeHarness(rpc, {
      homeDir: '/tmp/home',
      configPath: '/tmp/config.toml',
      auth: { status: async () => ({ providers: [] }) } as never,
      ensureConfigFile: async () => undefined,
      onClose: () => undefined,
    });

    const session = await harness.createSession({ id: 'ses_active', workDir: '/tmp/work' });
    const kaos = {} as Kaos;

    const resumed = await harness.resumeSession({ id: session.id, kaos });

    expect(resumed).toBe(session);
    expect(rpc.resumeCalls).toHaveLength(1);
    expect(rpc.resumeCalls[0]).toMatchObject({
      input: { id: 'ses_active' },
      kaos,
      persistenceKaos: undefined,
    });
  });

  it('rejects an active session resume when the requested profile differs from its binding', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    await writeReviewerAgent(workDir);
    const harness = createCloudCodeHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      const session = await harness.createSession({
        id: 'ses_active_profile_identity',
        workDir,
        agentProfile: 'reviewer',
      });

      await expect(
        harness.resumeSession({ id: session.id, agentProfile: 'agent' }),
      ).rejects.toThrow(
        'agent is already bound to profile "reviewer"; cannot switch to "agent" in this session',
      );
    } finally {
      await harness.close();
    }
  });

  it('returns the active session when the requested profile matches its binding', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    await writeReviewerAgent(workDir);
    const harness = createCloudCodeHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      const session = await harness.createSession({
        id: 'ses_matching_profile_identity',
        workDir,
        agentProfile: 'reviewer',
      });

      await expect(
        harness.resumeSession({ id: session.id, agentProfile: 'reviewer' }),
      ).resolves.toBe(session);
    } finally {
      await harness.close();
    }
  });

  it('rejects a persisted session resume when the requested profile differs from its binding', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    await writeReviewerAgent(workDir);
    const harness = createCloudCodeHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      const session = await harness.createSession({
        id: 'ses_persisted_profile_identity',
        workDir,
        agentProfile: 'reviewer',
      });
      await session.close();

      await expect(
        harness.resumeSession({ id: session.id, agentProfile: 'agent' }),
      ).rejects.toThrow(
        'agent is already bound to profile "reviewer"; cannot switch to "agent" in this session',
      );
    } finally {
      await harness.close();
    }
  });
});

function coreSessionIds(harness: CloudCodeHarness): readonly string[] {
  const core = (
    harness as unknown as {
      readonly rpc: { readonly core: { readonly sessions: ReadonlyMap<string, unknown> } };
    }
  ).rpc.core;
  return Array.from(core.sessions.keys()).toSorted();
}

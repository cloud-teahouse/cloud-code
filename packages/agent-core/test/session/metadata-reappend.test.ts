/**
 * Session metadata tail re-append + external-change absorption.
 *
 * Tests pin:
 *   - a rename lands a `session.meta` record at the main wire's tail, visible
 *     to the lite reader immediately (no new prompt needed)
 *   - close re-appends the final title/lastPrompt so the lite tail window
 *     always carries them
 *   - before writing prompt metadata, the session absorbs an external
 *     rename from `state.json` (a second process holding the session) instead
 *     of clobbering it with the stale in-memory cache
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { ProviderConfig } from '@cloud-code/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { ProviderManager } from '../../src/session/provider-manager';
import { SessionAPIImpl } from '../../src/session/rpc';
import { readWireLiteSummary } from '../../src/session/store/wire-lite';
import { createScriptedGenerate } from '../agent/harness/scripted-generate';
import { testKaos } from '../fixtures/test-kaos';

const MOCK_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'mock-model',
} as const satisfies ProviderConfig;

const tempDirs: string[] = [];
const openSessions: Session[] = [];

afterEach(async () => {
  // Close sessions first so their async metadata/wire writes settle before the
  // temp dirs are removed (otherwise rm races with a write -> ENOTEMPTY).
  await Promise.allSettled(openSessions.splice(0).map((s) => s.close()));
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function track(session: Session): Session {
  openSessions.push(session);
  return session;
}

async function makeSession(id: string) {
  const sessionDir = await mkdtemp(join(tmpdir(), 'metadata-reappend-'));
  tempDirs.push(sessionDir);
  const events: Array<Record<string, unknown>> = [];
  const scripted = createScriptedGenerate();
  const session = track(
    new Session({
      id,
      kaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc: createSessionRpc(events),
      skills: { explicitDirs: [join(sessionDir, 'missing-skills')] },
      providerManager: testProviderManager(),
    }),
  );
  const { agent } = await session.createAgent(
    { type: 'main', generate: scripted.generate },
    { profile: testProfile() },
  );
  agent.config.update({ modelAlias: MOCK_PROVIDER.model, thinkingEffort: 'off' });
  agent.permission.setMode('yolo');
  return { session, sessionDir, scripted, api: new SessionAPIImpl(session) };
}

/**
 * Open a second process's handle on an existing session dir: same Session
 * options, but no `createAgent` — the caller drives `session.resume()` to
 * adopt the persisted wire.
 */
async function reopenSession(id: string, sessionDir: string) {
  const events: Array<Record<string, unknown>> = [];
  const scripted = createScriptedGenerate();
  const session = track(
    new Session({
      id,
      kaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc: createSessionRpc(events),
      skills: { explicitDirs: [join(sessionDir, 'missing-skills')] },
      providerManager: testProviderManager(),
    }),
  );
  return { session, sessionDir, scripted, api: new SessionAPIImpl(session) };
}

async function steerAndSettle(
  scripted: ReturnType<typeof createScriptedGenerate>,
  session: Session,
  api: SessionAPIImpl,
  text: string,
): Promise<void> {
  // No scripted responses: the turn's generate call fails fast (tolerated —
  // these tests assert metadata, not turn output), which also makes the
  // fire-and-forget AI title refinement a deterministic no-op instead of
  // racing the turn for a mocked response.
  void scripted;
  await api.steer({ agentId: 'main', input: [{ type: 'text', text }] });
  const agent = session.getReadyAgent('main');
  if (agent?.turn.hasActiveTurn === true) {
    await agent.turn.waitForCurrentTurn().catch(() => {});
  }
}

describe('Session metadata tail re-append', () => {
  it('appends a session.meta record to the wire tail on rename', async () => {
    const { session, sessionDir, scripted, api } = await makeSession('reappend-rename');
    await steerAndSettle(scripted, session, api, 'first objective');

    await api.renameSession({ title: 'Renamed Title' });
    await session.flushMetadata();

    // The lite reader sees the rename from the wire tail window.
    const lite = await readWireLiteSummary(join(sessionDir, 'agents', 'main', 'wire.jsonl'));
    expect(lite.title).toBe('Renamed Title');
    expect(lite.isCustomTitle).toBe(true);

    // And the record is genuinely at the tail of the file.
    const raw = await readFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    const records = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    const lastMetaIndex = records.map((r) => r.type).lastIndexOf('session.meta');
    expect(lastMetaIndex).toBe(records.length - 1);
  });

  it('re-appends the final title/lastPrompt at close so the lite tail window carries them', async () => {
    const { session, sessionDir, scripted, api } = await makeSession('reappend-close');
    await steerAndSettle(scripted, session, api, 'close-time objective');

    await session.close();

    const lite = await readWireLiteSummary(join(sessionDir, 'agents', 'main', 'wire.jsonl'));
    expect(lite.lastPrompt).toBe('close-time objective');
    // The easy title derived from the first prompt is re-appended too.
    expect(lite.title).toBe('close-time objective');
  });

  it('absorbs an external rename from state.json instead of clobbering it', async () => {
    const { session, sessionDir, scripted, api } = await makeSession('reappend-absorb');
    await steerAndSettle(scripted, session, api, 'first objective');
    expect(session.metadata.title).toBe('first objective');

    // A second process holding this session renames it: state.json moves
    // forward while this process keeps its stale in-memory cache.
    const statePath = join(sessionDir, 'state.json');
    const onDisk = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
    await writeFile(
      statePath,
      `${JSON.stringify({
        ...onDisk,
        title: 'External Rename',
        isCustomTitle: true,
        updatedAt: new Date(Date.now() + 60_000).toISOString(),
      })}\n`,
      'utf-8',
    );

    await steerAndSettle(scripted, session, api, 'second objective');

    // The absorb-before-write path adopted the external title; the prompt's
    // whole-file write did not resurrect the stale cache value.
    expect(session.metadata.title).toBe('External Rename');
    expect(session.metadata.isCustomTitle).toBe(true);
    expect(session.metadata.lastPrompt).toBe('second objective');
    const persisted = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
    expect(persisted['title']).toBe('External Rename');

    // And the absorbed title is what the close-time tail re-append persists.
    await session.flushMetadata();
    const lite = await readWireLiteSummary(join(sessionDir, 'agents', 'main', 'wire.jsonl'));
    expect(lite.title).toBe('External Rename');
  });

  it('absorbs a static rename that never bumped updatedAt (field-level diff, equal timestamps)', async () => {
    const { session, sessionDir } = await makeSession('absorb-static-rename');
    // Settle the queued createAgent metadata write before overwriting
    // state.json by hand, so the fixture is not racing it.
    await session.flushMetadata();
    // The static SessionStore.rename path (a second process with the session
    // closed there but open here) rewrites state.json WITHOUT bumping
    // updatedAt. The field-level diff must still trigger the absorb.
    const statePath = join(sessionDir, 'state.json');
    await writeFile(
      statePath,
      `${JSON.stringify({
        ...session.metadata,
        title: 'Static Rename',
        isCustomTitle: true,
        // Deliberately identical to the in-memory updatedAt.
        updatedAt: session.metadata.updatedAt,
      })}\n`,
      'utf-8',
    );

    await session.absorbExternalMetadata();

    expect(session.metadata.title).toBe('Static Rename');
    expect(session.metadata.isCustomTitle).toBe(true);
  });

  it('does not absorb a disk state older than the in-memory cache', async () => {
    const { session, sessionDir } = await makeSession('absorb-stale-disk');
    // The cache is ahead (a newer write is queued or just landed): an older
    // on-disk state must never pull it backward.
    session.metadata = {
      ...session.metadata,
      title: 'Fresh Title',
      isCustomTitle: true,
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const statePath = join(sessionDir, 'state.json');
    await writeFile(
      statePath,
      `${JSON.stringify({
        ...session.metadata,
        title: 'Stale Title',
        isCustomTitle: false,
        updatedAt: new Date(1_600_000_000_000).toISOString(),
      })}\n`,
      'utf-8',
    );

    await session.absorbExternalMetadata();

    expect(session.metadata.title).toBe('Fresh Title');
    expect(session.metadata.isCustomTitle).toBe(true);
  });

  it('re-appends metadata when the main agent completes a compaction (no close needed)', async () => {
    // Claude's reAppendSessionMetadata fires during compaction and at exit;
    // the compaction trigger keeps a long-lived session's wire tail
    // self-describing even if the process never reaches a clean close.
    const { session, sessionDir, scripted, api } = await makeSession('reappend-compaction');
    await steerAndSettle(scripted, session, api, 'compaction trigger objective');
    await session.flushMetadata();
    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const linesBefore = (await readFile(wirePath, 'utf-8')).trim().split('\n').length;

    const agent = session.getReadyAgent('main');
    agent?.emitEvent({
      type: 'compaction.completed',
      result: {
        summary: 'compacted',
        compactedCount: 2,
        tokensBefore: 100,
        tokensAfter: 10,
      },
    });

    // The re-append is fire-and-forget on the event channel; wait for the
    // record to land on the wire WITHOUT any close/rename intervening.
    await vi.waitFor(async () => {
      const raw = await readFile(wirePath, 'utf-8');
      const records = raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string });
      expect(records.length).toBeGreaterThan(linesBefore);
      expect(records.at(-1)?.type).toBe('session.meta');
    });
    const lite = await readWireLiteSummary(wirePath);
    expect(lite.title).toBe('compaction trigger objective');
    expect(lite.lastPrompt).toBe('compaction trigger objective');
  });

  it('re-appends metadata on close after a bare resume (the resumed wire is adopted)', async () => {
    // adoptResumedSessionFile analog: a process that resumes an old session
    // and exits without sending a new message must still land the close-time
    // metadata re-append on the RESUMED wire (its records persistence targets
    // the same file from the first replayed record on).
    const first = await makeSession('reappend-resume-adopt');
    await steerAndSettle(first.scripted, first.session, first.api, 'adopt me');
    const wirePath = join(first.sessionDir, 'agents', 'main', 'wire.jsonl');
    await first.session.close();
    const linesBefore = (await readFile(wirePath, 'utf-8')).trim().split('\n').length;

    const reopened = await reopenSession('reappend-resume-adopt', first.sessionDir);
    await reopened.session.resume();
    await reopened.session.close();

    const raw = await readFile(wirePath, 'utf-8');
    const records = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    expect(records.length).toBeGreaterThan(linesBefore);
    expect(records.at(-1)?.type).toBe('session.meta');
    const lite = await readWireLiteSummary(wirePath);
    expect(lite.title).toBe('adopt me');
  });
});

function testProviderManager(): ProviderManager {
  return new ProviderManager({
    config: {
      providers: {
        test: { type: MOCK_PROVIDER.type, apiKey: MOCK_PROVIDER.apiKey },
      },
      models: {
        [MOCK_PROVIDER.model]: {
          provider: 'test',
          model: MOCK_PROVIDER.model,
          maxContextSize: 1_000_000,
        },
      },
    },
  });
}

function testProfile(): ResolvedAgentProfile {
  return {
    name: 'test',
    systemPrompt: () => '<system-prompt>',
    tools: [],
  };
}

function createSessionRpc(events: Array<Record<string, unknown>>): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async (event) => {
      events.push(event);
    }),
    requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({
      output: 'custom tools are not supported in this test',
      isError: true,
    })),
  } as unknown as SDKSessionRPC;
}

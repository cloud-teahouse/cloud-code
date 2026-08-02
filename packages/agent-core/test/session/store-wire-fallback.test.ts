/**
 * SessionStore wire fallback: when a session's `state.json` is missing
 * or lacks the listing fields, `summaryFromDir` recovers title/lastPrompt from
 * the main agent's wire log via the head/tail lite reader — and never lets the
 * wire override a field `state.json` already carries.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentRecord } from '../../src/agent/records';
import { appendSessionIndexEntry } from '../../src/session/store/session-index';
import { SessionStore } from '../../src/session/store/session-store';
import { encodeWorkDirKey, normalizeWorkDir } from '../../src/session/store/workdir-key';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeStore(): Promise<{ store: SessionStore; homeDir: string; workDir: string }> {
  const homeDir = await mkdtemp(join(tmpdir(), 'wire-fallback-home-'));
  tempDirs.push(homeDir);
  const workDir = '/tmp/wire-fallback-work';
  return { store: new SessionStore(homeDir), homeDir, workDir };
}

async function seedSession(
  homeDir: string,
  workDir: string,
  sessionId: string,
  options: {
    readonly wireRecords?: readonly AgentRecord[];
    readonly state?: Record<string, unknown>;
  },
): Promise<string> {
  const sessionDir = join(
    homeDir,
    'sessions',
    encodeWorkDirKey(normalizeWorkDir(workDir)),
    sessionId,
  );
  await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
  if (options.wireRecords !== undefined) {
    await writeFile(
      join(sessionDir, 'agents', 'main', 'wire.jsonl'),
      options.wireRecords.map((record) => JSON.stringify(record) + '\n').join(''),
      'utf-8',
    );
  }
  if (options.state !== undefined) {
    await writeFile(
      join(sessionDir, 'state.json'),
      `${JSON.stringify(options.state, null, 2)}\n`,
      'utf-8',
    );
  }
  await appendSessionIndexEntry(homeDir, { sessionId, sessionDir, workDir });
  return sessionDir;
}

function userPrompt(text: string, time: number): AgentRecord {
  return {
    type: 'context.append_message',
    time,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'user' },
    },
  };
}

const METADATA: AgentRecord = {
  type: 'metadata',
  protocol_version: '1.4',
  created_at: 1,
  time: 1,
};

describe('SessionStore wire fallback', () => {
  it('derives title and lastPrompt from the wire when state.json is missing entirely', async () => {
    const { store, homeDir, workDir } = await makeStore();
    await seedSession(homeDir, workDir, 'sess_no_state', {
      wireRecords: [
        METADATA,
        userPrompt('refactor the login form', 2),
        userPrompt('add OAuth support', 3),
      ],
    });

    const summary = await store.get('sess_no_state');

    // No session.meta and no state.json: the title falls back to the
    // truncated first prompt — the same rule the live title path uses.
    expect(summary.title).toBe('refactor the login form');
    expect(summary.lastPrompt).toBe('add OAuth support');
  });

  it('prefers the session.meta title from the wire tail over the first prompt', async () => {
    const { store, homeDir, workDir } = await makeStore();
    await seedSession(homeDir, workDir, 'sess_meta_title', {
      wireRecords: [
        METADATA,
        userPrompt('refactor the login form', 2),
        { type: 'session.meta', time: 3, title: 'Login Refactor', isCustomTitle: true },
      ],
    });

    const summary = await store.get('sess_meta_title');

    expect(summary.title).toBe('Login Refactor');
  });

  it('keeps state.json fields authoritative and only fills the gaps from the wire', async () => {
    const { store, homeDir, workDir } = await makeStore();
    await seedSession(homeDir, workDir, 'sess_partial_state', {
      state: {
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        title: 'State Title',
        isCustomTitle: true,
        workDir,
        agents: {},
        custom: {},
      },
      wireRecords: [
        METADATA,
        userPrompt('wire decoy prompt', 2),
        { type: 'session.meta', time: 3, title: 'Wire Decoy Title' },
      ],
    });

    const summary = await store.get('sess_partial_state');

    // Title comes from state.json (the wire decoy must not override it);
    // lastPrompt is missing from state.json, so the wire fills it.
    expect(summary.title).toBe('State Title');
    expect(summary.lastPrompt).toBe('wire decoy prompt');
  });

  it('lists a state-less session through the workDir listing path too', async () => {
    const { store, homeDir, workDir } = await makeStore();
    await seedSession(homeDir, workDir, 'sess_listed', {
      wireRecords: [METADATA, userPrompt('listed session prompt', 2)],
    });

    const sessions = await store.list({ workDir });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'sess_listed',
      title: 'listed session prompt',
      lastPrompt: 'listed session prompt',
    });
  });
});

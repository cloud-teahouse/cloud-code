/**
 * wire-lite — the head/tail-window lite reader for session listing.
 *
 * Tests pin:
 *   - small files (single window) yield first/last prompt, session.meta title,
 *     and last activity
 *   - large files are read through the 64KB head/tail windows ONLY: decoys
 *     placed between the windows never leak into the summary
 *   - a crash-truncated final line and corrupt lines are skipped, never fatal
 *   - missing/empty files degrade to an empty summary (never throw)
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentRecord } from '../../src/agent/records';
import {
  readWireLiteSummary,
  WIRE_LITE_READ_BUF_SIZE,
} from '../../src/session/store/wire-lite';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeWire(lines: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wire-lite-'));
  tempDirs.push(dir);
  const wirePath = join(dir, 'wire.jsonl');
  await writeFile(wirePath, lines.join('\n') + '\n', 'utf-8');
  return wirePath;
}

function line(record: AgentRecord): string {
  return JSON.stringify(record);
}

function metadataRecord(time: number): AgentRecord {
  return { type: 'metadata', protocol_version: '1.4', created_at: time, time };
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

describe('readWireLiteSummary', () => {
  it('extracts prompts, session.meta title, and last activity from a small file', async () => {
    const wirePath = await writeWire([
      line(metadataRecord(1_000)),
      line(userPrompt('first prompt', 2_000)),
      line({
        type: 'context.append_loop_event',
        time: 3_000,
        event: { type: 'step.begin', uuid: 's1', turnId: '0', step: 1 },
      }),
      line(userPrompt('last prompt', 4_000)),
      line({
        type: 'session.meta',
        time: 5_000,
        title: 'Tail Title',
        isCustomTitle: true,
        lastPrompt: 'last prompt',
      }),
    ]);

    const summary = await readWireLiteSummary(wirePath);

    expect(summary.firstPrompt).toBe('last prompt'.length > 0 ? 'first prompt' : undefined);
    expect(summary.lastPrompt).toBe('last prompt');
    expect(summary.title).toBe('Tail Title');
    expect(summary.isCustomTitle).toBe(true);
    expect(summary.lastActiveAt).toBe(5_000);
  });

  it('reads only the head/tail windows of a large file — middle decoys never leak', async () => {
    // Layout: [head records][BIG filler][decoys][BIG filler][tail records].
    // The decoys sit outside both 64KB windows; a full-file parse would pick
    // them up, so their absence proves the reader never touches the middle.
    const fillerText = 'x'.repeat(WIRE_LITE_READ_BUF_SIZE * 2);
    const filler = line({
      type: 'context.append_message',
      time: 10,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: fillerText }],
        toolCalls: [],
      },
    });
    const decoys = [
      line(userPrompt('DECOY middle prompt', 20)),
      line({ type: 'session.meta', time: 21, title: 'DECOY title' }),
    ];
    const head = [
      line(metadataRecord(1)),
      line(userPrompt('head first prompt', 2)),
      filler,
    ];
    const tail = [
      filler,
      line(userPrompt('tail last prompt', 3_000_000)),
      line({ type: 'session.meta', time: 3_000_001, title: 'Real Tail Title' }),
    ];
    const wirePath = await writeWire([...head, ...decoys, ...tail]);

    const summary = await readWireLiteSummary(wirePath);

    expect(summary.firstPrompt).toBe('head first prompt');
    expect(summary.lastPrompt).toBe('tail last prompt');
    expect(summary.title).toBe('Real Tail Title');
    expect(summary.isCustomTitle).toBeUndefined();
    expect(summary.lastActiveAt).toBe(3_000_001);
    expect(JSON.stringify(summary)).not.toContain('DECOY');
  });

  it('skips a crash-truncated final line instead of failing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wire-lite-'));
    tempDirs.push(dir);
    const wirePath = join(dir, 'wire.jsonl');
    const good = [
      line(metadataRecord(1)),
      line(userPrompt('kept prompt', 2)),
      line({ type: 'session.meta', time: 3, title: 'Kept Title' }),
    ].join('\n');
    // The tail write died mid-line: no newline terminator, partial JSON.
    await writeFile(wirePath, `${good}\n{"type":"session.meta","title":"Brok`, 'utf-8');

    const summary = await readWireLiteSummary(wirePath);

    expect(summary.firstPrompt).toBe('kept prompt');
    expect(summary.lastPrompt).toBe('kept prompt');
    expect(summary.title).toBe('Kept Title');
  });

  it('skips corrupt lines inside a small file', async () => {
    const wirePath = await writeWire([
      line(metadataRecord(1)),
      'not json at all',
      line(userPrompt('surviving prompt', 2)),
    ]);

    const summary = await readWireLiteSummary(wirePath);

    expect(summary.firstPrompt).toBe('surviving prompt');
    expect(summary.lastActiveAt).toBe(2);
  });

  it('skips well-formed JSON lines that are not well-formed records (foreign wire)', async () => {
    const wirePath = await writeWire([
      line(metadataRecord(1)),
      // `turn.prompt` without `origin`: the classifier would TypeError on a
      // strict read — must degrade to a skipped line, not a lost window.
      '{"type":"turn.prompt","input":[{"type":"text","text":"no origin"}]}',
      // `context.append_message` without `message`.
      '{"type":"context.append_message"}',
      // `turn.steer` with neither `origin` nor `input`.
      '{"type":"turn.steer"}',
      line(userPrompt('recovered prompt', 2)),
      line({ type: 'session.meta', time: 3, title: 'Kept Title' }),
      // A sparse session.meta AFTER the good one must not blank its fields.
      '{"type":"session.meta"}',
    ]);

    const summary = await readWireLiteSummary(wirePath);

    expect(summary.firstPrompt).toBe('recovered prompt');
    expect(summary.lastPrompt).toBe('recovered prompt');
    expect(summary.title).toBe('Kept Title');
    expect(summary.lastActiveAt).toBe(3);
  });

  it('a malformed line in one window does not poison the other window', async () => {
    // Pre-fix, one strict-read TypeError threw the whole scan away and the
    // outer catch returned {} — losing BOTH windows over a single bad line.
    const fillerText = 'x'.repeat(WIRE_LITE_READ_BUF_SIZE * 2);
    const filler = line({
      type: 'context.append_message',
      time: 10,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: fillerText }],
        toolCalls: [],
      },
    });
    const wirePath = await writeWire([
      line(metadataRecord(1)),
      '{"type":"context.append_message"}', // malformed, head window
      line(userPrompt('head prompt', 2)),
      filler,
      filler,
      '{"type":"turn.prompt"}', // malformed, tail window
      line(userPrompt('tail prompt', 3)),
    ]);

    const summary = await readWireLiteSummary(wirePath);

    expect(summary.firstPrompt).toBe('head prompt');
    expect(summary.lastPrompt).toBe('tail prompt');
  });

  it('classifies turn inputs: user-slash skills count, retries and injections do not', async () => {
    const wirePath = await writeWire([
      line(metadataRecord(1)),
      line({
        type: 'turn.prompt',
        time: 2,
        input: [{ type: 'text', text: 'retry me' }],
        origin: { kind: 'retry' },
      }),
      line({
        type: 'turn.prompt',
        time: 3,
        input: [{ type: 'text', text: 'silent' }],
        origin: { kind: 'injection', variant: 'system_reminder' },
      }),
      line({
        type: 'context.append_message',
        time: 4,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '/review src/app.ts' }],
          toolCalls: [],
          origin: {
            kind: 'skill_activation',
            activationId: 'a1',
            skillName: 'review',
            skillArgs: 'src/app.ts',
            trigger: 'user-slash',
          },
        },
      }),
    ]);

    const summary = await readWireLiteSummary(wirePath);

    expect(summary.firstPrompt).toBe('/review src/app.ts');
    expect(summary.lastPrompt).toBe('/review src/app.ts');
  });

  it('returns an empty summary for missing and empty files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wire-lite-'));
    tempDirs.push(dir);
    expect(await readWireLiteSummary(join(dir, 'missing.jsonl'))).toEqual({});

    const emptyPath = join(dir, 'empty.jsonl');
    await writeFile(emptyPath, '', 'utf-8');
    expect(await readWireLiteSummary(emptyPath)).toEqual({});
  });
});

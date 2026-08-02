/**
 * HeadTailBuffer — port of codex `head_tail_buffer_tests.rs` to the
 * string-based TypeScript buffer (see src/agent/shell-session/head-tail-buffer.ts).
 */

import { describe, expect, it } from 'vitest';

import { HeadTailBuffer } from '../../../src/agent/shell-session/head-tail-buffer';

describe('HeadTailBuffer', () => {
  it('keeps prefix and suffix when over budget', () => {
    const buf = new HeadTailBuffer(10);

    buf.push('0123456789');
    expect(buf.omitted).toBe(0);

    // Exceeds max by 2; keep head+tail, omit the middle.
    buf.push('ab');
    expect(buf.omitted).toBeGreaterThan(0);

    expect(buf.toStringWithOmissionMarker()).toBe('01234\n... 2 bytes omitted ...\n789ab');
  });

  it('max_bytes zero drops everything', () => {
    const buf = new HeadTailBuffer(0);
    buf.push('abc');

    expect(buf.retainedBytes).toBe(0);
    expect(buf.omitted).toBe(3);
    // Marker rendering still shows the omission between empty head/tail.
    expect(buf.toStringWithOmissionMarker()).toBe('\n... 3 bytes omitted ...\n');
  });

  it('head budget zero keeps only the last byte in tail', () => {
    const buf = new HeadTailBuffer(1);
    buf.push('abc');

    expect(buf.retainedBytes).toBe(1);
    expect(buf.omitted).toBe(2);
    expect(buf.toStringWithOmissionMarker()).toBe('\n... 2 bytes omitted ...\nc');
  });

  it('draining resets state and reports omission metadata', () => {
    const buf = new HeadTailBuffer(10);
    buf.push('0123456789');
    buf.push('ab');

    const drained = buf.drain();

    expect(buf.retainedBytes).toBe(0);
    expect(buf.omitted).toBe(0);
    expect(buf.toStringWithOmissionMarker()).toBe('');
    expect(drained.output).toBe('01234\n... 2 bytes omitted ...\n789ab');
    expect(drained.omittedBytes).toBe(2);
    expect(drained.totalBytes).toBe(12);

    // The buffer keeps working (and its capacity) after a drain.
    buf.push('xy');
    expect(buf.toStringWithOmissionMarker()).toBe('xy');
  });

  it('chunk larger than tail budget keeps only the tail end', () => {
    const buf = new HeadTailBuffer(10);
    buf.push('0123456789');

    // Tail budget is 5; this chunk replaces the tail with its last 5 bytes.
    buf.push('ABCDEFGHIJK');

    const out = buf.toStringWithOmissionMarker();
    expect(out.startsWith('01234')).toBe(true);
    expect(out.endsWith('GHIJK')).toBe(true);
    expect(buf.omitted).toBeGreaterThan(0);
  });

  it('fills head then tail across multiple chunks', () => {
    const buf = new HeadTailBuffer(10);

    // Fill the 5-byte head budget across multiple chunks.
    buf.push('01');
    buf.push('234');
    expect(buf.toStringWithOmissionMarker()).toBe('01234');

    // Then fill the 5-byte tail budget.
    buf.push('567');
    buf.push('89');
    expect(buf.toStringWithOmissionMarker()).toBe('0123456789');
    expect(buf.omitted).toBe(0);

    // One more byte causes the tail to drop its oldest byte.
    buf.push('a');
    expect(buf.toStringWithOmissionMarker()).toBe('01234\n... 1 bytes omitted ...\n6789a');
    expect(buf.omitted).toBe(1);
  });

  it('empty and tiny chunks have bounded metadata', () => {
    const buf = new HeadTailBuffer(10);

    for (const ch of '0123456789ab') {
      buf.push('');
      buf.push(ch);
    }

    expect(buf.retainedBytes).toBe(10);
    expect(buf.omitted).toBe(2);
    expect(buf.toStringWithOmissionMarker()).toBe('01234\n... 2 bytes omitted ...\n789ab');
    expect(buf.totalBytes).toBe(12);
  });
});

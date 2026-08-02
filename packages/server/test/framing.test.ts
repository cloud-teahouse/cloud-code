import { describe, expect, it } from 'vitest';

import { encodeJsonlFrame, JsonlFraming } from '../src/jsonrpc/framing';

function collect() {
  const messages: unknown[] = [];
  const errors: string[] = [];
  const framing = new JsonlFraming(
    (message) => messages.push(message),
    (error) => errors.push(error.message),
  );
  return { framing, messages, errors };
}

describe('JsonlFraming', () => {
  it('decodes one message per line', () => {
    const { framing, messages } = collect();
    framing.feed('{"a":1}\n{"b":2}\n');
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('handles a half line split across chunks', () => {
    const { framing, messages, errors } = collect();
    framing.feed('{"metho');
    expect(messages).toEqual([]);
    framing.feed('d":"prompt","id":1}\n');
    expect(messages).toEqual([{ method: 'prompt', id: 1 }]);
    expect(errors).toEqual([]);
  });

  it('handles several frames arriving in one chunk', () => {
    const { framing, messages } = collect();
    const frame = encodeJsonlFrame({ jsonrpc: '2.0', id: 1, method: 'prompt', params: {} });
    framing.feed(frame + frame + frame);
    expect(messages).toHaveLength(3);
  });

  it('reports a malformed line and keeps going', () => {
    const { framing, messages, errors } = collect();
    framing.feed('not json\n{"ok":true}\n');
    expect(errors).toHaveLength(1);
    expect(messages).toEqual([{ ok: true }]);
  });

  it('tolerates CRLF line endings and blank lines', () => {
    const { framing, messages, errors } = collect();
    framing.feed('{"a":1}\r\n\n{"b":2}\r\n');
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
    expect(errors).toEqual([]);
  });

  it('reports a truncated trailing frame at end of input', () => {
    const { framing, messages, errors } = collect();
    framing.feed('{"a":1}\n{"trunc');
    expect(messages).toEqual([{ a: 1 }]);
    framing.end();
    expect(errors).toHaveLength(1);
  });

  it('handles large frames', () => {
    const { framing, messages, errors } = collect();
    const big = { data: 'x'.repeat(1024 * 1024) };
    const frame = encodeJsonlFrame(big);
    for (let i = 0; i < frame.length; i += 4096) {
      framing.feed(frame.slice(i, i + 4096));
    }
    expect(errors).toEqual([]);
    expect(messages).toEqual([big]);
  });
});

import {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  type Message,
  type ToolCall,
} from '#/message';
import {
  closeTruncatedJson,
  normalizeMessagesForWire,
  UNKNOWN_TOOL_NAME,
  type NormalizeRepairKind,
} from '#/normalize';
import { describe, expect, it } from 'vitest';

function toolCall(id: string, name: string, args: string | null): ToolCall {
  return { type: 'function', id, name, arguments: args };
}

function repairCollector() {
  const repairs: Array<{ kind: NormalizeRepairKind; toolCallId: string }> = [];
  return {
    repairs,
    onRepair: (kind: NormalizeRepairKind, toolCallId: string) => {
      repairs.push({ kind, toolCallId });
    },
  };
}

describe('normalizeMessagesForWire fast path', () => {
  it('returns the same array reference for a healthy multi-exchange history', () => {
    const history: Message[] = [
      createUserMessage('hi'),
      createAssistantMessage([{ type: 'text', text: 'calling a tool' }], [
        toolCall('c1', 'Read', '{"path":"/tmp/a"}'),
        toolCall('c2', 'Grep', '{"pattern":"x"}'),
      ]),
      createToolMessage('c1', 'file body'),
      createToolMessage('c2', 'matches'),
      createAssistantMessage([{ type: 'text', text: 'done' }]),
      createUserMessage('thanks'),
    ];
    const out = normalizeMessagesForWire(history);
    expect(out).toBe(history);
  });

  it('passes null and empty arguments through untouched', () => {
    const history: Message[] = [
      createUserMessage('go'),
      createAssistantMessage([], [toolCall('c1', 'NoArgs', null), toolCall('c2', 'EmptyArgs', '')]),
      createToolMessage('c1', 'r1'),
      createToolMessage('c2', 'r2'),
    ];
    expect(normalizeMessagesForWire(history)).toBe(history);
  });

  it('passes duplicate id pairs through verbatim (lax-provider contract)', () => {
    // Two calls sharing one id with two results: structurally weird but the
    // producing provider must see its own history as-is — dedupe is a
    // projection-level decision, not this layer's.
    const history: Message[] = [
      createUserMessage('go'),
      createAssistantMessage([], [toolCall('c1', 'A', '{}'), toolCall('c1', 'B', '{}')]),
      createToolMessage('c1', 'r1'),
      createToolMessage('c1', 'r2'),
    ];
    expect(normalizeMessagesForWire(history)).toBe(history);
  });

  it('does not require a leading user message or touch content parts', () => {
    const history: Message[] = [
      createAssistantMessage([{ type: 'text', text: 'orphan-ish but legal here' }]),
      createUserMessage('ok'),
    ];
    expect(normalizeMessagesForWire(history)).toBe(history);
  });
});

describe('normalizeMessagesForWire truncated arguments', () => {
  it('closes an unterminated string', () => {
    const history: Message[] = [
      createUserMessage('go'),
      createAssistantMessage([], [toolCall('c1', 'Write', '{"path":"/tmp/a","content":"hello wor')]),
      createToolMessage('c1', 'ok'),
    ];
    const { repairs, onRepair } = repairCollector();
    const out = normalizeMessagesForWire(history, { onRepair });
    expect(out).not.toBe(history);
    const args = out[1]!.toolCalls[0]!.arguments;
    expect(args).toBe('{"path":"/tmp/a","content":"hello wor"}');
    expect(JSON.parse(args!)).toEqual({ path: '/tmp/a', content: 'hello wor' });
    expect(repairs).toEqual([{ kind: 'arguments_closed', toolCallId: 'c1' }]);
    // Copy-on-write: the caller's message is untouched.
    expect(history[1]!.toolCalls[0]!.arguments).toBe('{"path":"/tmp/a","content":"hello wor');
  });

  it('drops a dangling comma before closing', () => {
    expect(closeTruncatedJson('{"a":1,')).toBe('{"a":1}');
  });

  it('fills a dangling colon with null', () => {
    expect(closeTruncatedJson('{"a":')).toBe('{"a":null}');
  });

  it('closes nested unclosed brackets in reverse order', () => {
    expect(closeTruncatedJson('{"a":{"b":[1,2')).toBe('{"a":{"b":[1,2]}}');
  });

  it('drops a dangling escape before closing the string', () => {
    expect(closeTruncatedJson('{"a":"x\\')).toBe('{"a":"x"}');
  });

  it('falls back to {} for unrecoverable garbage', () => {
    const history: Message[] = [
      createUserMessage('go'),
      createAssistantMessage([], [toolCall('c1', 'Write', 'definitely not json')]),
      createToolMessage('c1', 'ok'),
    ];
    const { repairs, onRepair } = repairCollector();
    const out = normalizeMessagesForWire(history, { onRepair });
    expect(out[1]!.toolCalls[0]!.arguments).toBe('{}');
    expect(repairs).toEqual([{ kind: 'arguments_fallback_empty', toolCallId: 'c1' }]);
  });

  it('falls back to {} when a closed fragment still does not parse', () => {
    expect(closeTruncatedJson('{"a"')).toBe('{}');
    expect(closeTruncatedJson('{"a": tru')).toBe('{}');
  });
});

describe('normalizeMessagesForWire non-object arguments', () => {
  it('replaces valid non-object JSON arguments with {} (converters require an object)', () => {
    const history: Message[] = [
      createUserMessage('go'),
      createAssistantMessage([], [
        toolCall('c1', 'Read', '[1,2]'),
        toolCall('c2', 'Grep', '"abc"'),
        toolCall('c3', 'Bash', '123'),
      ]),
      createToolMessage('c1', 'r1'),
      createToolMessage('c2', 'r2'),
      createToolMessage('c3', 'r3'),
    ];
    const { repairs, onRepair } = repairCollector();
    const out = normalizeMessagesForWire(history, { onRepair });
    expect(out).not.toBe(history);
    expect(out[1]!.toolCalls.map((call) => call.arguments)).toEqual(['{}', '{}', '{}']);
    expect(repairs).toEqual([
      { kind: 'arguments_fallback_non_object', toolCallId: 'c1' },
      { kind: 'arguments_fallback_non_object', toolCallId: 'c2' },
      { kind: 'arguments_fallback_non_object', toolCallId: 'c3' },
    ]);
    // Copy-on-write: the caller's history keeps the original arguments.
    expect(history[1]!.toolCalls[0]!.arguments).toBe('[1,2]');
  });

  it('does not flag a valid object that merely starts with a bracket-adjacent shape', () => {
    const history: Message[] = [
      createUserMessage('go'),
      createAssistantMessage([], [toolCall('c1', 'Read', '{"a":[1,2]}')]),
      createToolMessage('c1', 'r1'),
    ];
    expect(normalizeMessagesForWire(history)).toBe(history);
  });

  it('falls back to {} (not the closed array) when a truncated fragment closes to a non-object', () => {
    const history: Message[] = [
      createUserMessage('go'),
      createAssistantMessage([], [toolCall('c1', 'Read', '[1,2')]),
      createToolMessage('c1', 'r1'),
    ];
    const { repairs, onRepair } = repairCollector();
    const out = normalizeMessagesForWire(history, { onRepair });
    expect(out[1]!.toolCalls[0]!.arguments).toBe('{}');
    expect(repairs).toEqual([{ kind: 'arguments_fallback_empty', toolCallId: 'c1' }]);
  });

  it('repairs the JSON literal null the same way (converters reject it too)', () => {
    const history: Message[] = [
      createUserMessage('go'),
      createAssistantMessage([], [toolCall('c1', 'Read', 'null')]),
      createToolMessage('c1', 'r1'),
    ];
    const { repairs, onRepair } = repairCollector();
    const out = normalizeMessagesForWire(history, { onRepair });
    expect(out[1]!.toolCalls[0]!.arguments).toBe('{}');
    expect(repairs).toEqual([{ kind: 'arguments_fallback_non_object', toolCallId: 'c1' }]);
  });
});

describe('normalizeMessagesForWire empty tool names', () => {
  it('backfills a deterministic placeholder name', () => {
    const history: Message[] = [
      createUserMessage('go'),
      createAssistantMessage([], [toolCall('c1', '', '{"a":1}')]),
      createToolMessage('c1', 'ok'),
    ];
    const { repairs, onRepair } = repairCollector();
    const out = normalizeMessagesForWire(history, { onRepair });
    expect(out[1]!.toolCalls[0]!.name).toBe(UNKNOWN_TOOL_NAME);
    expect(repairs).toEqual([{ kind: 'empty_tool_name', toolCallId: 'c1' }]);
    expect(history[1]!.toolCalls[0]!.name).toBe('');
  });

  it('avoids collision with an existing placeholder name in the same message', () => {
    const history: Message[] = [
      createUserMessage('go'),
      createAssistantMessage(
        [],
        [toolCall('c1', UNKNOWN_TOOL_NAME, '{}'), toolCall('c2', '  ', '{}'), toolCall('c3', '', '{}')],
      ),
      createToolMessage('c1', 'r1'),
      createToolMessage('c2', 'r2'),
      createToolMessage('c3', 'r3'),
    ];
    const out = normalizeMessagesForWire(history);
    const names = out[1]!.toolCalls.map((call) => call.name);
    expect(names).toEqual([UNKNOWN_TOOL_NAME, `${UNKNOWN_TOOL_NAME}_2`, `${UNKNOWN_TOOL_NAME}_3`]);
  });
});

describe('normalizeMessagesForWire pairing fallback', () => {
  it('drops an orphan tool message', () => {
    const history: Message[] = [
      createUserMessage('go'),
      createToolMessage('c_lost', 'stray result'),
      createUserMessage('next'),
    ];
    const { repairs, onRepair } = repairCollector();
    const out = normalizeMessagesForWire(history, { onRepair });
    expect(out.map((m) => m.role)).toEqual(['user', 'user']);
    expect(repairs).toEqual([{ kind: 'orphan_tool_result_dropped', toolCallId: 'c_lost' }]);
  });

  it('drops a tool message whose id matches no call in the preceding assistant', () => {
    const history: Message[] = [
      createUserMessage('go'),
      createAssistantMessage([], [toolCall('c1', 'A', '{}')]),
      createToolMessage('c_other', 'stray'),
      createToolMessage('c1', 'r1'),
    ];
    const out = normalizeMessagesForWire(history);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(out[2]!.toolCallId).toBe('c1');
  });

  it('synthesizes a placeholder result for an unanswered mid-history call', () => {
    const history: Message[] = [
      createUserMessage('go'),
      createAssistantMessage([], [toolCall('c1', 'A', '{}'), toolCall('c2', 'B', '{}')]),
      createToolMessage('c1', 'r1'),
      createUserMessage('moved on'),
    ];
    const { repairs, onRepair } = repairCollector();
    const out = normalizeMessagesForWire(history, { onRepair });
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user']);
    expect(out[2]!.toolCallId).toBe('c1');
    expect(out[3]!.toolCallId).toBe('c2');
    expect(repairs).toEqual([{ kind: 'missing_tool_result_synthesized', toolCallId: 'c2' }]);
  });

  it('synthesizes results for a trailing open exchange (never wire-legal)', () => {
    const history: Message[] = [
      createUserMessage('go'),
      createAssistantMessage([], [toolCall('c1', 'A', '{}')]),
    ];
    const out = normalizeMessagesForWire(history);
    expect(out).toHaveLength(3);
    expect(out[2]!.role).toBe('tool');
    expect(out[2]!.toolCallId).toBe('c1');
  });

  it('keeps existing results and appends synthesized ones after the block', () => {
    const history: Message[] = [
      createUserMessage('go'),
      createAssistantMessage([], [toolCall('c1', 'A', '{}'), toolCall('c2', 'B', '{}')]),
      createToolMessage('c2', 'r2'),
      createUserMessage('next'),
    ];
    const out = normalizeMessagesForWire(history);
    expect(out.map((m) => m.toolCallId)).toEqual([undefined, undefined, 'c2', 'c1', undefined]);
  });

  it('never mutates the caller array or message objects', () => {
    const history: Message[] = [
      createUserMessage('go'),
      createAssistantMessage([], [toolCall('c1', '', '{"a":')]),
      createToolMessage('c_lost', 'stray'),
    ];
    const snapshot = structuredClone(history);
    const out = normalizeMessagesForWire(history);
    expect(out).not.toBe(history);
    expect(history).toEqual(snapshot);
    // Untouched messages keep their identity in the repaired copy.
    expect(out[0]).toBe(history[0]);
  });
});

describe('closeTruncatedJson', () => {
  it('returns valid input unchanged', () => {
    expect(closeTruncatedJson('{"a":1,"b":[2,3]}')).toBe('{"a":1,"b":[2,3]}');
  });

  it('returns {} for empty input', () => {
    expect(closeTruncatedJson('')).toBe('{}');
    expect(closeTruncatedJson('   ')).toBe('{}');
  });

  it('handles chained dangling separators', () => {
    expect(closeTruncatedJson('{"a":1,"b":')).toBe('{"a":1,"b":null}');
  });
});

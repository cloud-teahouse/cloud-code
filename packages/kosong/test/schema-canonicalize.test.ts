import { canonicalizeToolSchema } from '#/schema-canonicalize';
import { describe, expect, it } from 'vitest';

describe('canonicalizeToolSchema', () => {
  it('produces identical bytes for logically identical schemas with different key order', () => {
    const a = {
      type: 'object',
      properties: { path: { type: 'string', description: 'p' } },
      required: ['path'],
      additionalProperties: false,
    };
    const b = {
      additionalProperties: false,
      required: ['path'],
      properties: { path: { description: 'p', type: 'string' } },
      type: 'object',
    };
    expect(JSON.stringify(canonicalizeToolSchema(a))).toBe(
      JSON.stringify(canonicalizeToolSchema(b)),
    );
  });

  it('sorts required arrays', () => {
    const out = canonicalizeToolSchema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['b', 'a'],
    });
    expect(out['required']).toEqual(['a', 'b']);
  });

  it('sorts dependentRequired value arrays', () => {
    const out = canonicalizeToolSchema({
      type: 'object',
      properties: { a: {}, b: {}, c: {} },
      dependentRequired: { a: ['c', 'b'] },
    });
    expect(out['dependentRequired']).toEqual({ a: ['b', 'c'] });
  });

  it('fills empty, null, and non-object schemas with an empty object schema', () => {
    const expected = { properties: {}, type: 'object' };
    expect(canonicalizeToolSchema({})).toEqual(expected);
    expect(canonicalizeToolSchema(null)).toEqual(expected);
    expect(canonicalizeToolSchema(undefined)).toEqual(expected);
    expect(canonicalizeToolSchema([] as unknown as Record<string, unknown>)).toEqual(expected);
  });

  it('fills missing root type and properties', () => {
    const out = canonicalizeToolSchema({ description: 'root only' });
    expect(out['type']).toBe('object');
    expect(out['properties']).toEqual({});
    // Keys stay sorted after the fill.
    expect(Object.keys(out)).toEqual(['description', 'properties', 'type']);
  });

  it('does not override an explicit root type or properties', () => {
    const out = canonicalizeToolSchema({
      type: 'object',
      properties: { a: { type: 'string' } },
    });
    expect(out['type']).toBe('object');
    expect(out['properties']).toEqual({ a: { type: 'string' } });
  });

  it('drops OpenAPI-style non-array required', () => {
    const out = canonicalizeToolSchema({
      type: 'object',
      properties: { a: { type: 'string', required: true } },
    });
    const properties = out['properties'] as Record<string, unknown>;
    expect(properties['a']).toEqual({ type: 'string' });
  });

  it('sorts keys recursively through nested objects', () => {
    const out = canonicalizeToolSchema({
      type: 'object',
      properties: {
        z: { type: 'object', properties: { b: { type: 'string' }, a: { type: 'string' } } },
        a: { type: 'string' },
      },
    });
    expect(Object.keys(out['properties'] as Record<string, unknown>)).toEqual(['a', 'z']);
    const z = (out['properties'] as Record<string, Record<string, unknown>>)['z']!;
    expect(Object.keys(z['properties'] as Record<string, unknown>)).toEqual(['a', 'b']);
  });

  it('keeps array order for non-required arrays', () => {
    const out = canonicalizeToolSchema({
      type: 'string',
      enum: ['b', 'a', 'c'],
    });
    expect(out['enum']).toEqual(['b', 'a', 'c']);
  });

  it('does not mutate the input schema', () => {
    const input = {
      required: ['b', 'a'],
      properties: { b: { type: 'string' }, a: { type: 'string' } },
    };
    const snapshot = structuredClone(input);
    canonicalizeToolSchema(input);
    expect(input).toEqual(snapshot);
  });

  it('is idempotent', () => {
    const input = {
      required: ['b', 'a'],
      properties: { b: { description: 'd', type: 'string' }, a: { type: 'string' } },
    };
    const once = canonicalizeToolSchema(input);
    expect(canonicalizeToolSchema(once)).toEqual(once);
    expect(JSON.stringify(canonicalizeToolSchema(once))).toBe(JSON.stringify(once));
  });
});

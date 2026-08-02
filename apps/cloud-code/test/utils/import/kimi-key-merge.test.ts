import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildKeyMergePlan,
  mapModelAliasReference,
  mergeConfigTomlData,
  mergeFlatRecordData,
  mergeMcpData,
} from '#/utils/import/kimi-key-merge';

describe('mergeConfigTomlData', () => {
  it('imports upstream-only keys and keeps existing target values', () => {
    const source = {
      default_model: 'kimi-code/kimi-for-coding',
      default_provider: 'managed:kimi-code',
      yolo: true,
    };
    const target = { default_model: 'mine/model', thinking: { type: 'enabled' } };
    const result = mergeConfigTomlData(source, target);

    expect(result.merged['default_model']).toBe('mine/model'); // target wins
    expect(result.merged['default_provider']).toBe('managed:kimi-code'); // imported
    expect(result.merged['yolo']).toBe(true); // imported
    expect(result.merged['thinking']).toEqual({ type: 'enabled' }); // untouched
    expect(result.importedKeys.toSorted()).toEqual(['default_provider', 'yolo']);
    expect(result.keptKeys).toEqual(['default_model']);
  });

  it('merges providers/models tables per entry, keeping target entries', () => {
    const source = {
      models: {
        'kimi-code/kimi-for-coding': { provider: 'managed:kimi-code', model: 'kimi-for-coding' },
        'custom/a': { provider: 'custom', model: 'a' },
      },
      providers: { 'managed:kimi-code': { type: 'kimi' }, custom: { type: 'openai' } },
    };
    const target = {
      models: { 'custom/a': { provider: 'custom', model: 'a2', maxContextSize: 1 } },
      providers: { custom: { type: 'openai', baseUrl: 'https://mine' } },
    };
    const result = mergeConfigTomlData(source, target);

    const models = result.merged['models'] as Record<string, unknown>;
    expect(models['kimi-code/kimi-for-coding']).toEqual({
      provider: 'managed:kimi-code',
      model: 'kimi-for-coding',
    });
    expect(models['custom/a']).toEqual({ provider: 'custom', model: 'a2', maxContextSize: 1 });
    const providers = result.merged['providers'] as Record<string, unknown>;
    expect(providers['managed:kimi-code']).toEqual({ type: 'kimi' });
    expect(providers['custom']).toEqual({ type: 'openai', baseUrl: 'https://mine' });
    expect(result.importedKeys).toEqual(['models."kimi-code/kimi-for-coding"', 'providers."managed:kimi-code"'].toSorted() as string[]);
    expect(result.keptKeys.toSorted()).toEqual(['models."custom/a"', 'providers."custom"']);
  });

  it('keeps the kimi-code/ alias prefix unchanged (managed platform id is shared)', () => {
    expect(mapModelAliasReference('kimi-code/kimi-for-coding')).toBe('kimi-code/kimi-for-coding');
  });
});

describe('mergeFlatRecordData', () => {
  it('imports only actions the target does not bind', () => {
    const result = mergeFlatRecordData(
      { 'app.exit': ['ctrl+c'], 'editor.undo': 'ctrl+z' },
      { 'app.exit': ['ctrl+q'] },
    );
    expect(result.merged).toEqual({ 'app.exit': ['ctrl+q'], 'editor.undo': 'ctrl+z' });
    expect(result.importedKeys).toEqual(['editor.undo']);
    expect(result.keptKeys).toEqual(['app.exit']);
  });

  it('stores hostile keys like __proto__ as own properties, never via the prototype', () => {
    const source = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as Record<
      string,
      unknown
    >;
    const result = mergeFlatRecordData(source, {});
    expect(Object.prototype.hasOwnProperty.call(result.merged, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.getPrototypeOf(result.merged)).toBe(Object.prototype);
  });
});

describe('mergeMcpData', () => {
  it('merges mcpServers entries and preserves unrelated target keys', () => {
    const result = mergeMcpData(
      { mcpServers: { context7: { command: 'npx' }, mine: { url: 'https://x' } } },
      { mcpServers: { mine: { url: 'https://y' } }, otherTopLevel: 1 },
    );
    expect(result.merged).toEqual({
      mcpServers: { mine: { url: 'https://y' }, context7: { command: 'npx' } },
      otherTopLevel: 1,
    });
    expect(result.importedKeys).toEqual(['mcpServers."context7"']);
    expect(result.keptKeys).toEqual(['mcpServers."mine"']);
  });
});

describe('buildKeyMergePlan', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-import-merge-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns undefined when the source file does not exist', async () => {
    const built = await buildKeyMergePlan({
      sourcePath: join(dir, 'nope.toml'),
      targetPath: join(dir, 'target.toml'),
      format: 'toml',
      merge: mergeConfigTomlData,
    });
    expect(built).toBeUndefined();
  });

  it('flags an unparseable source as sourceError and a bad target as targetError', async () => {
    const bad = join(dir, 'bad.toml');
    await writeFile(bad, 'this is = = not toml\n', 'utf-8');
    const sourceBad = await buildKeyMergePlan({
      sourcePath: bad,
      targetPath: join(dir, 'target.toml'),
      format: 'toml',
      merge: mergeConfigTomlData,
    });
    expect(sourceBad?.plan.sourceError).toBeDefined();

    const good = join(dir, 'good.json');
    const badTarget = join(dir, 'bad-target.json');
    await writeFile(good, '{"a": 1}\n', 'utf-8');
    await writeFile(badTarget, '{oops\n', 'utf-8');
    const targetBad = await buildKeyMergePlan({
      sourcePath: good,
      targetPath: badTarget,
      format: 'json',
      merge: mergeFlatRecordData,
    });
    expect(targetBad?.plan.targetError).toBeDefined();
    expect(targetBad?.plan.importedKeys).toEqual([]);
  });

  it('round-trips a TOML merge: merged data parses back with both sides preserved', async () => {
    const sourcePath = join(dir, 'source.toml');
    const targetPath = join(dir, 'target.toml');
    await writeFile(
      sourcePath,
      'default_model = "kimi-code/kimi-for-coding"\n[models."kimi-code/kimi-for-coding"]\nprovider = "managed:kimi-code"\nmodel = "kimi-for-coding"\n',
      'utf-8',
    );
    await writeFile(targetPath, 'yolo = true\n', 'utf-8');
    const built = await buildKeyMergePlan({
      sourcePath,
      targetPath,
      format: 'toml',
      merge: mergeConfigTomlData,
    });
    expect(built?.plan.importedKeys.toSorted()).toEqual([
      'default_model',
      'models."kimi-code/kimi-for-coding"',
    ]);
    expect(built?.merged['yolo']).toBe(true);
    expect(built?.merged['default_model']).toBe('kimi-code/kimi-for-coding');
    // The merged payload must still be valid TOML once serialized.
    const { stringify, parse } = await import('smol-toml');
    expect(parse(stringify(built!.merged))).toEqual(built!.merged);
    await expect(readFile(sourcePath, 'utf-8')).resolves.toContain('default_model');
  });
});

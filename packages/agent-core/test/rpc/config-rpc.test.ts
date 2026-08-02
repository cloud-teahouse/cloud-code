import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CloudCodeCore } from '../../src/rpc/core-impl';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeHome(configToml?: string): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'kimi-home-'));
  tempDirs.push(home);
  if (configToml !== undefined) {
    await writeFile(path.join(home, 'config.toml'), configToml, 'utf-8');
  }
  return home;
}

function makeCore(home: string): CloudCodeCore {
  return new CloudCodeCore(async () => ({}) as never, { homeDir: home });
}

const VALID_TOML = `
default_model = "k2"

[providers.kimi]
type = "kimi"
api_key = "sk-good"

[models.k2]
provider = "kimi"
model = "kimi-for-coding"
max_context_size = 128000
`;

describe('CloudCodeCore degraded config loading', () => {
  it('reports no diagnostics for a valid config', async () => {
    const core = makeCore(await makeHome(VALID_TOML));
    const config = await core.getCloudCodeConfig({});
    expect(config.providers['kimi']).toBeDefined();
    await expect(core.getConfigDiagnostics({})).resolves.toEqual({ warnings: [] });
  });

  it('refuses to start when the TOML cannot be parsed at all', async () => {
    const home = await makeHome('[[[');
    // A fully unusable file means defaults-only (looks logged out), which is
    // worse than failing fast with the parse location.
    expect(() => makeCore(home)).toThrow(/Invalid TOML/);
  });

  it('starts with a partially invalid config, keeping the valid sections', async () => {
    const core = makeCore(
      await makeHome(`${VALID_TOML}
[loop_control]
max_steps_per_turn = "nope"
`),
    );
    const config = await core.getCloudCodeConfig({});
    expect(config.providers['kimi']).toBeDefined();
    expect(config.loopControl).toBeUndefined();
    const diagnostics = await core.getConfigDiagnostics({});
    expect(diagnostics.warnings).toHaveLength(1);
    expect(diagnostics.warnings[0]).toContain('loop_control');
  });

  it('rejects config writes with an actionable error while the file is invalid', async () => {
    const home = await makeHome(`${VALID_TOML}
[loop_control]
max_steps_per_turn = "nope"
`);
    const core = makeCore(home);
    const before = await readFile(path.join(home, 'config.toml'), 'utf-8');

    // Write paths stay strict: changing settings on top of a broken file
    // must fail with a short, actionable message — not raw validation JSON —
    // and must leave the file untouched.
    const write = core.setCloudCodeConfig({ thinking: { enabled: true } });
    await expect(write).rejects.toThrow(/fix it first/i);
    await expect(write).rejects.toThrow(/cloudcode doctor/);
    await expect(write).rejects.not.toThrow(/invalid_type/);

    const after = await readFile(path.join(home, 'config.toml'), 'utf-8');
    expect(after).toBe(before);
  });

  it('keeps the last good config when the file breaks mid-run', async () => {
    const home = await makeHome(VALID_TOML);
    const core = makeCore(home);
    const configPath = path.join(home, 'config.toml');

    await writeFile(configPath, '[[[', 'utf-8');
    const kept = await core.getCloudCodeConfig({ reload: true });
    expect(kept.providers['kimi']).toBeDefined();
    const degraded = await core.getConfigDiagnostics({});
    expect(degraded.warnings.some((w) => w.includes('Invalid TOML'))).toBe(true);
    expect(degraded.warnings.some((w) => w.includes('previous'))).toBe(true);

    await writeFile(configPath, `[thinking]\nenabled = true\n${VALID_TOML}`, 'utf-8');
    const adopted = await core.getCloudCodeConfig({ reload: true });
    expect(adopted.thinking?.enabled).toBe(true);
    await expect(core.getConfigDiagnostics({})).resolves.toEqual({ warnings: [] });
  });
});

describe('CloudCodeCore imageLimits scoping', () => {
  it('two cores keep independent [image] limits and only follow their own reloads', async () => {
    const homeA = await makeHome(`${VALID_TOML}
[image]
max_edge_px = 800
read_byte_budget = 65536
`);
    const homeB = await makeHome(`${VALID_TOML}
[image]
max_edge_px = 1600
`);
    const coreA = makeCore(homeA);
    const coreB = makeCore(homeB);

    // Baseline: each core resolves its own [image] section.
    expect(coreA.imageLimits.maxEdgePx()).toBe(800);
    expect(coreA.imageLimits.readByteBudget()).toBe(65536);
    expect(coreB.imageLimits.maxEdgePx()).toBe(1600);
    expect(coreB.imageLimits.readByteBudget()).toBe(256 * 1024);

    // Reloading B must not restamp A (the module-global regression).
    await writeFile(
      path.join(homeB, 'config.toml'),
      `${VALID_TOML}
[image]
max_edge_px = 1000
read_byte_budget = 32768
`,
      'utf-8',
    );
    await coreB.getCloudCodeConfig({ reload: true });
    expect(coreB.imageLimits.maxEdgePx()).toBe(1000);
    expect(coreB.imageLimits.readByteBudget()).toBe(32768);
    expect(coreA.imageLimits.maxEdgePx()).toBe(800);
    expect(coreA.imageLimits.readByteBudget()).toBe(65536);
  });

  it('reloading [image] takes effect on the core instance immediately', async () => {
    const home = await makeHome(VALID_TOML);
    const core = makeCore(home);
    expect(core.imageLimits.maxEdgePx()).toBe(2000);

    await writeFile(
      path.join(home, 'config.toml'),
      `${VALID_TOML}
[image]
max_edge_px = 1400
read_byte_budget = 131072
`,
      'utf-8',
    );
    await core.getCloudCodeConfig({ reload: true });
    expect(core.imageLimits.maxEdgePx()).toBe(1400);
    expect(core.imageLimits.readByteBudget()).toBe(131072);

    // Removing the section clears back to built-ins.
    await writeFile(path.join(home, 'config.toml'), VALID_TOML, 'utf-8');
    await core.getCloudCodeConfig({ reload: true });
    expect(core.imageLimits.maxEdgePx()).toBe(2000);
    expect(core.imageLimits.readByteBudget()).toBe(256 * 1024);
  });
});

const CUSTOM_ENTRIES_TOML = `
default_model = "acme/m1"

[providers.acme]
type = "openai"
base_url = "https://api.acme.test/v1"
api_key = "sk-old"
unsupported_future_field = "keep-me"

[models."acme/m1"]
provider = "acme"
model = "m1"
max_context_size = 128000
display_name = "M1"
support_efforts = ["low"]
custom_model_field = "keep-me-too"

[models."acme/m2"]
provider = "acme"
model = "m2"
max_context_size = 128000
`;

describe('CloudCodeCore custom-entry config RPCs', () => {
  it('setCloudCodeProvider replaces the entry wholesale: dropped fields clear, raw-only fields survive', async () => {
    const home = await makeHome(CUSTOM_ENTRIES_TOML);
    const core = makeCore(home);

    const config = await core.setCloudCodeProvider({
      providerId: 'acme',
      provider: { type: 'openai', apiKey: 'sk-new' },
    });
    expect(config.providers['acme']).toEqual({ type: 'openai', apiKey: 'sk-new' });

    const text = await readFile(path.join(home, 'config.toml'), 'utf-8');
    expect(text).not.toContain('base_url = "https://api.acme.test/v1"');
    expect(text).toContain('unsupported_future_field = "keep-me"');
  });

  it('setCloudCodeModel replaces the alias wholesale: dropped fields clear, raw-only fields survive', async () => {
    const home = await makeHome(CUSTOM_ENTRIES_TOML);
    const core = makeCore(home);

    const config = await core.setCloudCodeModel({
      alias: 'acme/m1',
      model: { provider: 'acme', model: 'm1', maxContextSize: 64_000 },
    });
    expect(config.models?.['acme/m1']).toEqual({
      provider: 'acme',
      model: 'm1',
      maxContextSize: 64_000,
    });

    const text = await readFile(path.join(home, 'config.toml'), 'utf-8');
    expect(text).not.toContain('display_name = "M1"');
    expect(text).not.toContain('support_efforts');
    expect(text).toContain('custom_model_field = "keep-me-too"');
  });

  it('removeCloudCodeModel deletes the alias and clears a dangling defaultModel', async () => {
    const home = await makeHome(CUSTOM_ENTRIES_TOML);
    const core = makeCore(home);

    const config = await core.removeCloudCodeModel({ alias: 'acme/m1' });
    expect(config.models?.['acme/m1']).toBeUndefined();
    expect(config.models?.['acme/m2']).toBeDefined();
    expect(config.defaultModel).toBeUndefined();

    const text = await readFile(path.join(home, 'config.toml'), 'utf-8');
    expect(text).not.toContain('acme/m1');
    expect(text).toContain('acme/m2');
  });

  it('rejects malformed wholesale writes without touching the file', async () => {
    const home = await makeHome(CUSTOM_ENTRIES_TOML);
    const before = await readFile(path.join(home, 'config.toml'), 'utf-8');
    const core = makeCore(home);

    await expect(
      core.setCloudCodeProvider({ providerId: 'acme', provider: { type: 'nope' } as never }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      core.setCloudCodeModel({
        alias: 'acme/m1',
        model: { provider: 'acme', model: 'm1', maxContextSize: 0 } as never,
      }),
    ).rejects.toBeInstanceOf(Error);

    await expect(readFile(path.join(home, 'config.toml'), 'utf-8')).resolves.toBe(before);
  });
});

const SECONDARY_TOML = `
default_model = "acme/m1"

[providers.acme]
type = "openai"
api_key = "sk-old"

[providers.other]
type = "openai"
api_key = "sk-other"
base_url = "https://api.other.test/v1"

[models."acme/m1"]
provider = "acme"
model = "m1"
max_context_size = 128000

[models."acme/m2"]
provider = "acme"
model = "m2"
max_context_size = 128000

[models."other/m1"]
provider = "other"
model = "o1"
max_context_size = 128000

[secondary_model]
model = "acme/m2"
effort = "high"
secondary_future_field = "keep-secondary"
`;

describe('CloudCodeCore secondary model config RPCs', () => {
  it('setCloudCodeSecondaryModel replaces the section wholesale: dropped fields clear, raw-only fields survive', async () => {
    const home = await makeHome(SECONDARY_TOML);
    const core = makeCore(home);

    const config = await core.setCloudCodeSecondaryModel({ model: 'acme/m1' });
    expect(config.secondaryModel).toEqual({ model: 'acme/m1' });

    const text = await readFile(path.join(home, 'config.toml'), 'utf-8');
    expect(text).toContain('[secondary_model]');
    expect(text).toContain('model = "acme/m1"');
    // The dropped effort must not resurrect from the raw section.
    expect(text).not.toContain('effort = "high"');
    expect(text).toContain('secondary_future_field = "keep-secondary"');
  });

  it('setCloudCodeSecondaryModel with an absent or blank model drops the section', async () => {
    const home = await makeHome(SECONDARY_TOML);
    const core = makeCore(home);

    const cleared = await core.setCloudCodeSecondaryModel({});
    expect(cleared.secondaryModel).toBeUndefined();
    let text = await readFile(path.join(home, 'config.toml'), 'utf-8');
    expect(text).not.toContain('[secondary_model]');

    // A blank model string is the same clear (resolveSecondaryModel treats
    // blank as unset too).
    await core.setCloudCodeSecondaryModel({ model: 'acme/m1', effort: 'low' });
    const blanked = await core.setCloudCodeSecondaryModel({ model: '   ' });
    expect(blanked.secondaryModel).toBeUndefined();
    text = await readFile(path.join(home, 'config.toml'), 'utf-8');
    expect(text).not.toContain('[secondary_model]');
  });

  it('removeCloudCodeModel scrubs a dangling secondary model', async () => {
    const home = await makeHome(SECONDARY_TOML);
    const core = makeCore(home);

    const config = await core.removeCloudCodeModel({ alias: 'acme/m2' });
    expect(config.models?.['acme/m2']).toBeUndefined();
    expect(config.secondaryModel).toBeUndefined();
    expect(config.defaultModel).toBe('acme/m1');

    const text = await readFile(path.join(home, 'config.toml'), 'utf-8');
    expect(text).not.toContain('[secondary_model]');
  });

  it('removeCloudCodeProvider scrubs the secondary model only when its alias vanishes', async () => {
    const home = await makeHome(SECONDARY_TOML);
    const core = makeCore(home);

    // Removing an unrelated provider keeps the assignment.
    const kept = await core.removeCloudCodeProvider({ providerId: 'other' });
    expect(kept.secondaryModel).toEqual({ model: 'acme/m2', defaultEffort: 'high' });

    // Removing the provider the secondary model belongs to scrubs it.
    const scrubbed = await core.removeCloudCodeProvider({ providerId: 'acme' });
    // No model aliases survive (the reloaded config normalizes an empty map
    // to undefined).
    expect(Object.keys(scrubbed.models ?? {})).toEqual([]);
    expect(scrubbed.secondaryModel).toBeUndefined();

    const text = await readFile(path.join(home, 'config.toml'), 'utf-8');
    expect(text).not.toContain('[secondary_model]');
  });
});

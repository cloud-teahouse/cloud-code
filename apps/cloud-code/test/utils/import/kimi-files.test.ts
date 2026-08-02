import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  agentsMdBlockMarker,
  applyAgentsMdImport,
  applyCredentialImport,
  applyHistoryMerge,
  applySkillImport,
  buildAgentsMdPlan,
  buildCredentialPlan,
  buildHistoryMergePlan,
  buildSkillImportPlan,
} from '#/utils/import/kimi-files';

describe('kimi file category imports', () => {
  let sourceHome: string;
  let targetHome: string;

  beforeEach(async () => {
    sourceHome = await mkdtemp(join(tmpdir(), 'cc-import-src-'));
    targetHome = await mkdtemp(join(tmpdir(), 'cc-import-dst-'));
  });
  afterEach(async () => {
    await rm(sourceHome, { recursive: true, force: true });
    await rm(targetHome, { recursive: true, force: true });
  });

  describe('input history', () => {
    const historyFile = (home: string, name: string, lines: string[]) =>
      writeFile(join(home, 'user-history', name), `${lines.join('\n')}\n`, 'utf-8');

    beforeEach(async () => {
      await mkdir(join(sourceHome, 'user-history'), { recursive: true });
      await mkdir(join(targetHome, 'user-history'), { recursive: true });
    });

    it('merges new entries and dedupes against existing content', async () => {
      await historyFile(sourceHome, 'abc.jsonl', [
        JSON.stringify({ content: 'fix the bug' }),
        JSON.stringify({ content: 'run tests' }),
        'not json at all',
        JSON.stringify({ content: 'fix the bug' }), // dupe within source
      ]);
      await historyFile(targetHome, 'abc.jsonl', [JSON.stringify({ content: 'fix the bug' })]);

      const plan = await buildHistoryMergePlan({ sourceHome, targetHome });
      expect(plan).toHaveLength(1);
      expect(plan[0]?.action).toBe('import');
      expect(plan[0]?.entriesToAppend).toEqual(['run tests']);

      const result = await applyHistoryMerge(plan);
      expect(result).toEqual({ imported: 1, errors: [] });
      const merged = await readFile(join(targetHome, 'user-history', 'abc.jsonl'), 'utf-8');
      const contents = merged
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { content: string }).content);
      expect(contents).toEqual(['fix the bug', 'run tests']);
    });

    it('marks fully-duplicate files as skipped', async () => {
      await historyFile(sourceHome, 'abc.jsonl', [JSON.stringify({ content: 'same' })]);
      await historyFile(targetHome, 'abc.jsonl', [JSON.stringify({ content: 'same' })]);
      const plan = await buildHistoryMergePlan({ sourceHome, targetHome });
      expect(plan[0]?.action).toBe('skip');
      expect(plan[0]?.skipReason).toBe('duplicate');
    });
  });

  describe('skills', () => {
    beforeEach(async () => {
      await mkdir(join(sourceHome, 'skills'), { recursive: true });
    });

    const writeBundle = async (home: string, name: string, frontmatter: string) => {
      const dir = join(home, 'skills', name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), frontmatter, 'utf-8');
      await writeFile(join(dir, 'helper.py'), '# helper\n', 'utf-8');
    };

    it('plans bundles and flat skills, flags invalid frontmatter', async () => {
      await writeBundle(
        sourceHome,
        'good-skill',
        '---\nname: good-skill\ndescription: does things\n---\n# body\n',
      );
      await writeBundle(sourceHome, 'no-desc', '---\nname: no-desc\n---\n# body\n');
      await writeFile(join(sourceHome, 'skills', 'flat.md'), '---\nname: flat\n---\n', 'utf-8');

      const plan = await buildSkillImportPlan({ sourceHome, targetHome });
      const byName = new Map(plan.map((s) => [s.name, s]));
      expect(byName.get('good-skill')?.action).toBe('import');
      expect(byName.get('good-skill')?.kind).toBe('bundle');
      expect(byName.get('flat.md')?.action).toBe('import');
      expect(byName.get('flat.md')?.kind).toBe('flat');
      expect(byName.get('no-desc')?.skipReason).toBe('invalid');
    });

    it('skips conflicts and precomputes a free -kimi rename', async () => {
      await writeBundle(sourceHome, 'dup', '---\nname: dup\ndescription: x\n---\n');
      await writeBundle(targetHome, 'dup', '---\nname: dup\ndescription: mine\n---\n');

      const plan = await buildSkillImportPlan({ sourceHome, targetHome });
      expect(plan[0]?.action).toBe('skip');
      expect(plan[0]?.skipReason).toBe('conflict');
      expect(plan[0]?.renameName).toBe('dup-kimi');

      // Default apply skips it; rename apply imports under the new name.
      const skipped = await applySkillImport(plan, false);
      expect(skipped.imported).toBe(0);
      const renamed = await applySkillImport(plan, true);
      expect(renamed.imported).toBe(1);
      const renamedSkill = await readFile(
        join(targetHome, 'skills', 'dup-kimi', 'SKILL.md'),
        'utf-8',
      );
      expect(renamedSkill).toContain('name: dup');
      // The original target skill is untouched.
      const original = await readFile(join(targetHome, 'skills', 'dup', 'SKILL.md'), 'utf-8');
      expect(original).toContain('mine');
    });

    it('copies bundle supporting files and never overwrites', async () => {
      await writeBundle(sourceHome, 'bundle', '---\nname: bundle\ndescription: x\n---\n');
      const plan = await buildSkillImportPlan({ sourceHome, targetHome });
      const result = await applySkillImport(plan, false);
      expect(result.imported).toBe(1);
      expect((await stat(join(targetHome, 'skills', 'bundle', 'helper.py'))).isFile()).toBe(true);
      // Second apply: errorOnExist turns into a reported error, not an overwrite.
      const again = await applySkillImport(plan, false);
      expect(again.imported).toBe(0);
      expect(again.errors).toHaveLength(1);
    });
  });

  describe('credentials', () => {
    beforeEach(async () => {
      await mkdir(join(sourceHome, 'credentials'), { recursive: true });
    });

    it('offers only kimi-code credential files and reports conflicts', async () => {
      await writeFile(join(sourceHome, 'credentials', 'kimi-code.json'), '{"access_token":"a"}', 'utf-8');
      await writeFile(join(sourceHome, 'credentials', 'kimi-code-env-ab12.json'), '{}', 'utf-8');
      await writeFile(join(sourceHome, 'credentials', 'chatgpt-codex.json'), '{}', 'utf-8');
      await mkdir(join(targetHome, 'credentials'), { recursive: true });
      await writeFile(join(targetHome, 'credentials', 'kimi-code.json'), '{"access_token":"mine"}', 'utf-8');

      const plan = await buildCredentialPlan({ sourceHome, targetHome });
      expect(plan.map((c) => c.fileName).toSorted()).toEqual([
        'kimi-code-env-ab12.json',
        'kimi-code.json',
      ]);
      const byName = new Map(plan.map((c) => [c.fileName, c]));
      expect(byName.get('kimi-code.json')?.skipReason).toBe('conflict');
      expect(byName.get('kimi-code-env-ab12.json')?.skipReason).toBeUndefined();

      const result = await applyCredentialImport(plan);
      expect(result).toEqual({ imported: 1, errors: [] });
      // Existing target credential was not overwritten.
      expect(await readFile(join(targetHome, 'credentials', 'kimi-code.json'), 'utf-8')).toBe(
        '{"access_token":"mine"}',
      );
      expect(
        (await stat(join(targetHome, 'credentials', 'kimi-code-env-ab12.json'))).isFile(),
      ).toBe(true);
      // chatgpt-codex.json was never offered.
      await expect(stat(join(targetHome, 'credentials', 'chatgpt-codex.json'))).rejects.toThrow();
    });
  });

  describe('AGENTS.md', () => {
    it('appends a marked block once and dedupes on rescan', async () => {
      await writeFile(join(sourceHome, 'AGENTS.md'), '# upstream rules\n', 'utf-8');
      const sourcePath = join(sourceHome, 'AGENTS.md');

      const plan = await buildAgentsMdPlan({ sourceHome, targetHome });
      expect(plan?.action).toBe('import');
      await applyAgentsMdImport(plan!);

      const content = await readFile(join(targetHome, 'AGENTS.md'), 'utf-8');
      expect(content).toContain(agentsMdBlockMarker(sourcePath));
      expect(content).toContain('# upstream rules');
      expect(content).toContain(`<!-- End Imported from Kimi Code: ${sourcePath} -->`);

      const rescan = await buildAgentsMdPlan({ sourceHome, targetHome });
      expect(rescan?.action).toBe('skip');
      expect(rescan?.skipReason).toBe('duplicate');
    });

    it('skips an empty source file', async () => {
      await writeFile(join(sourceHome, 'AGENTS.md'), '   \n', 'utf-8');
      const plan = await buildAgentsMdPlan({ sourceHome, targetHome });
      expect(plan?.skipReason).toBe('empty');
    });
  });
});

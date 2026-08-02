import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';
import CHECK_CLOUD_CODE_DOCS_BODY from './check-cloud-code-docs.md?raw';

const PSEUDO_PATH = 'builtin://check-cloud-code-docs';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/check-cloud-code-docs.md',
  skillDirName: 'check-cloud-code-docs',
  source: 'builtin',
  text: CHECK_CLOUD_CODE_DOCS_BODY,
});

export const CHECK_CLOUD_CODE_DOCS_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
};

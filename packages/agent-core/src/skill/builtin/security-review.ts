import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';
import SECURITY_REVIEW_BODY from './security-review.md?raw';

const PSEUDO_PATH = 'builtin://security-review';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/security-review.md',
  skillDirName: 'security-review',
  source: 'builtin',
  text: SECURITY_REVIEW_BODY,
});

export const SECURITY_REVIEW_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
};

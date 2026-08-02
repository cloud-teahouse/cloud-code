import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';
import REVIEW_BODY from './review.md?raw';

const PSEUDO_PATH = 'builtin://review';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/review.md',
  skillDirName: 'review',
  source: 'builtin',
  text: REVIEW_BODY,
});

export const REVIEW_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
};

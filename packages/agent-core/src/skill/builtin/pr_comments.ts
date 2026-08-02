import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';
import PR_COMMENTS_BODY from './pr_comments.md?raw';

const PSEUDO_PATH = 'builtin://pr_comments';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/pr_comments.md',
  skillDirName: 'pr_comments',
  source: 'builtin',
  text: PR_COMMENTS_BODY,
});

export const PR_COMMENTS_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
};

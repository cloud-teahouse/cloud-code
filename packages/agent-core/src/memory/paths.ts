import { dirname, join } from 'pathe';

import type { Kaos } from '@cloud-code/kaos';

export interface MemoryDirs {
  /** Project-scope memory dir: `<projectRoot>/.cloud-code/memory/`. */
  readonly project: string;
  /** User-scope memory dir: `<brandHome>/memory/` (CLOUD_CODE_HOME-aware). */
  readonly user: string;
}

/**
 * Resolve the two memory scopes. The project dir hangs off the git root so
 * every subdirectory of one repo shares it; the user dir follows the brand
 * home (CLOUD_CODE_HOME, default `~/.cloud-code`) exactly like the branded
 * AGENTS.md and skills dirs. Both are returned unresolved-by-existence —
 * callers decide whether a missing dir means "no section" (injection) or
 * "create on write" (save).
 */
export async function resolveMemoryDirs(kaos: Kaos, brandHome?: string): Promise<MemoryDirs> {
  const projectRoot = await findMemoryProjectRoot(kaos, kaos.getcwd());
  return {
    project: join(projectRoot, '.cloud-code', 'memory'),
    user: join(brandHome ?? join(kaos.gethome(), '.cloud-code'), 'memory'),
  };
}

// Same root rule as `findProjectRoot` in profile/context.ts (git root, else
// the work dir itself). Kept local so this module does not import
// profile/context, which itself imports the memory loader.
async function findMemoryProjectRoot(kaos: Kaos, workDir: string): Promise<string> {
  const initial = kaos.normpath(workDir);
  let current = initial;

  while (true) {
    try {
      await kaos.stat(join(current, '.git'));
      return current;
    } catch {
      // Not the root — walk up.
    }
    const parent = dirname(current);
    if (parent === current) return initial;
    current = parent;
  }
}

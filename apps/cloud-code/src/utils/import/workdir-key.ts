/**
 * Session bucket-key derivation, replicated from
 * `packages/agent-core/src/session/store/workdir-key.ts` (and its
 * `slugifyWorkDirName` helper). The app layer must not import agent-core
 * internals, so the importer keeps a copy; the algorithm MUST stay in sync
 * with agent-core or imported sessions land in buckets the store would not
 * mint for the same workDir (still recovered via the session index, but
 * needlessly divergent).
 */

import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { basename, resolve } from 'pathe';

const WORKDIR_KEY_PREFIX = 'wd_';
const HASH_LENGTH = 12;
const MAX_WORKDIR_SLUG_LENGTH = 40;

export function normalizeWorkDir(workDir: string): string {
  if (/^[A-Za-z]:[\\/]/.test(workDir) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(workDir)) {
    return win32.resolve(workDir).replaceAll('\\', '/');
  }
  return resolve(workDir);
}

export function encodeWorkDirKey(workDir: string): string {
  const normalized = normalizeWorkDir(workDir);
  const slug = slugifyWorkDirName(basename(normalized));
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}

function slugifyWorkDirName(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, MAX_WORKDIR_SLUG_LENGTH)
    .replaceAll(/^-+|-+$/g, '');
  return slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
}

/** Session-id safety rule, mirroring agent-core's `isSafeSessionId`. */
export function isSafeSessionId(id: string): boolean {
  return id !== '.' && id !== '..' && /^[A-Za-z0-9._-]+$/.test(id);
}

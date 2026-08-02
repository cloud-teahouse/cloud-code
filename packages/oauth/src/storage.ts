/**
 * File-based OAuth token storage.
 *
 * Tokens are persisted under a directory (default
 * `~/.cloud-code/credentials/`) as `<name>.json` with mode 0600 (parent
 * dir 0700). Wire format uses snake_case to match the server contract.
 *
 * Write semantics: write to `<name>.tmp.<pid>.<rand>` → fsync → rename.
 * Atomic on POSIX; Windows best-effort.
 *
 * Load semantics: missing file → undefined. Corrupt JSON / wrong shape →
 * undefined (never throws). Callers treat undefined as "no token stored".
 * Loads are cached per path keyed on the file's mtime (see `load`).
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import type { TokenInfo, TokenInfoWire } from './types';
import { tokenFromWire, tokenToWire } from './types';
import { isRecord } from './utils';

export interface TokenStorage {
  load(name: string): Promise<TokenInfo | undefined>;
  save(name: string, token: TokenInfo): Promise<void>;
  remove(name: string): Promise<void>;
  list(): Promise<string[]>;
}

/**
 * Per-path cache entry for `FileTokenStorage.load`. `mtimeMs` is the file's
 * mtime at the moment `value` was read (or `'missing'` when the file was
 * absent); `value` is undefined for missing/corrupt files.
 */
interface LoadCacheEntry {
  readonly mtimeMs: number | 'missing';
  readonly value: TokenInfo | undefined;
}

export class FileTokenStorage implements TokenStorage {
  private readonly dir: string;
  private readonly loadCache = new Map<string, LoadCacheEntry>();

  constructor(dir: string) {
    this.dir = dir;
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // recursive=true with mode only applies on initial create; tighten after
    // the fact in case an existing dir had looser permissions.
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // best-effort; Windows / read-only FS may refuse
    }
  }

  private pathFor(name: string): string {
    // Guard against path traversal: caller-provided names (from config.toml
    // or slash commands) must not escape the credentials dir. `basename`
    // strips any `..` or `/` segments; if the sanitized value differs from
    // the input we refuse the request entirely rather than silently
    // writing to a different file than the caller asked for.
    const safe = basename(name);
    if (safe.length === 0 || safe !== name || safe.startsWith('.')) {
      throw new Error(`Invalid token name: "${name}"`);
    }
    return join(this.dir, `${safe}.json`);
  }

  async load(name: string): Promise<TokenInfo | undefined> {
    const file = this.pathFor(name);
    // Mtime-guarded cache: every load still stats the file, so a rewrite by
    // any process (atomic rename in `save`) bumps mtimeMs and forces a
    // re-read below. Same-instance writes never rely on this comparison —
    // `save`/`remove` write the cache through synchronously, so e.g.
    // `getAuthHeaders` observes the accountId persisted by a refresh
    // milliseconds earlier even when both writes land in the same mtime tick.
    //
    // Residual window: a PEER-process write whose resulting mtime equals the
    // cached marker keeps serving the stale value until the file changes
    // again — ~1 ms on ns-precision filesystems (ext4/APFS), longer on
    // coarse ones (FAT, some network mounts).
    let mtimeMs: number | 'missing';
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      mtimeMs = 'missing';
    }
    const cached = this.loadCache.get(file);
    if (cached !== undefined && cached.mtimeMs === mtimeMs) {
      // Shallow copy per call: TokenInfo fields are all primitives, and this
      // preserves the previous contract where every load returned a fresh
      // object from `tokenFromWire`.
      return cached.value === undefined ? undefined : { ...cached.value };
    }
    let raw: string;
    try {
      raw = readFileSync(file, 'utf-8');
    } catch {
      this.loadCache.set(file, { mtimeMs, value: undefined });
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.loadCache.set(file, { mtimeMs, value: undefined });
      return undefined;
    }
    const value = isRecord(parsed) ? tokenFromWire(parsed as Partial<TokenInfoWire>) : undefined;
    // A 'missing' stat with a successful read means a peer created the file
    // in between; 'missing' does not describe this content, so skip caching
    // rather than pair a value with a marker a future absent file would match.
    if (mtimeMs !== 'missing' || value === undefined) {
      this.loadCache.set(file, { mtimeMs, value });
    }
    return value === undefined ? undefined : { ...value };
  }

  async save(name: string, token: TokenInfo): Promise<void> {
    this.ensureDir();
    const target = this.pathFor(name);
    const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    const data = Buffer.from(`${JSON.stringify(tokenToWire(token), null, 2)}\n`, 'utf-8');
    const fd = openSync(tmp, 'w', 0o600);
    try {
      let written = 0;
      while (written < data.length) {
        written += writeSync(fd, data, written, data.length - written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      // chmod again in case umask stripped bits during open
      chmodSync(tmp, 0o600);
      // Capture the mtime before the rename: rename(2) preserves it, and the
      // tmp path is exclusively ours, so this marker cannot race a peer
      // write. Write-through keeps same-instance readers consistent even
      // when the new mtime lands in the same tick as the previously cached
      // one. Cache a snapshot — callers may reuse/mutate `token` after save.
      const mtimeMs = statSync(tmp).mtimeMs;
      renameSync(tmp, target);
      this.loadCache.set(target, { mtimeMs, value: { ...token } });
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  async remove(name: string): Promise<void> {
    const file = this.pathFor(name);
    try {
      unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    // Write-through: from this instance's perspective the file is gone
    // (unlinked, or already absent). A peer recreate bumps the stat marker
    // from 'missing' to a number, forcing a re-read on the next load.
    this.loadCache.set(file, { mtimeMs: 'missing', value: undefined });
  }

  async list(): Promise<string[]> {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return [];
    }
    return entries.filter((e) => e.endsWith('.json')).map((e) => e.slice(0, -'.json'.length));
  }
}

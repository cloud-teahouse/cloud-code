/**
 * Isolate the app home per worker: several suites write through the real
 * CLOUD_CODE_HOME (feedback archives, caches), which breaks on read-only
 * homes and leaks state between runs. A repo-local per-worker home keeps
 * the suites hermetic and parallel-safe. Explicit CLOUD_CODE_HOME in the
 * environment still wins.
 */
import { join } from 'node:path';

if (process.env['CLOUD_CODE_HOME'] === undefined) {
  const worker = process.env['VITEST_WORKER_ID'] ?? '0';
  process.env['CLOUD_CODE_HOME'] = join(
    __dirname,
    '..',
    '..',
    '.tmp',
    `test-home-${worker}`,
  );
}

import { cloudCodeEnv } from '../utils/env';
import { resolveGlobalLogPath } from './logger';
import type { LogLevel, LoggingConfig } from './types';

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';
export const DEFAULT_GLOBAL_MAX_BYTES = 6 * 1024 * 1024; // 6 MB
export const DEFAULT_GLOBAL_FILES = 5; // 6 MB x 5 = 30 MB
export const DEFAULT_SESSION_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const DEFAULT_SESSION_FILES = 3; // 5 MB x 3 = 15 MB

export interface ResolveLoggingInput {
  readonly homeDir: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/**
 * Build the runtime `LoggingConfig` from env vars + defaults.
 *
 * v1 deliberately does not read `config.toml [logging]` — the schema is in
 * flux and reading it adds a startup-time failure surface. Users who need to
 * override the defaults set env vars (legacy `KIMI_LOG_*` names are honored
 * as fallbacks):
 *
 *   CLOUD_CODE_LOG_LEVEL=debug
 *   CLOUD_CODE_LOG_GLOBAL_MAX_BYTES=... CLOUD_CODE_LOG_GLOBAL_FILES=...
 *   CLOUD_CODE_LOG_SESSION_MAX_BYTES=... CLOUD_CODE_LOG_SESSION_FILES=...
 */
export function resolveLoggingConfig(input: ResolveLoggingInput): LoggingConfig {
  const env = input.env ?? process.env;
  const logEnv = (name: string) => cloudCodeEnv(`CLOUD_CODE_LOG_${name}`, `KIMI_LOG_${name}`, env);
  return {
    level: parseLevel(logEnv('LEVEL')) ?? DEFAULT_LOG_LEVEL,
    globalLogPath: resolveGlobalLogPath(input.homeDir),
    globalMaxBytes: parsePositiveInt(logEnv('GLOBAL_MAX_BYTES')) ?? DEFAULT_GLOBAL_MAX_BYTES,
    globalFiles: parsePositiveInt(logEnv('GLOBAL_FILES')) ?? DEFAULT_GLOBAL_FILES,
    sessionMaxBytes:
      parsePositiveInt(logEnv('SESSION_MAX_BYTES')) ?? DEFAULT_SESSION_MAX_BYTES,
    sessionFiles: parsePositiveInt(logEnv('SESSION_FILES')) ?? DEFAULT_SESSION_FILES,
  };
}

function parseLevel(value: string | undefined): LogLevel | undefined {
  if (value === undefined) return undefined;
  const v = value.toLowerCase().trim();
  if (v === 'off' || v === 'error' || v === 'warn' || v === 'info' || v === 'debug') return v;
  return undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

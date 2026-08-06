/**
 * Read an env var by its current `CLOUD_CODE_*` name, falling back to the
 * legacy `KIMI_*` name from pre-rebrand releases so existing setups keep
 * working.
 */
export function cloudCodeEnv(
  primary: string,
  legacy: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[primary] ?? env[legacy];
}

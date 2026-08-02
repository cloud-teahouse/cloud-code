import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'pathe';

export function resolveCloudCodeHome(homeDir?: string | undefined): string {
  return homeDir ?? process.env['CLOUD_CODE_HOME'] ?? join(homedir(), '.cloud-code');
}

export function resolveConfigPath(input: {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
}): string {
  return input.configPath ?? join(resolveCloudCodeHome(input.homeDir), 'config.toml');
}

export function ensureCloudCodeHome(homeDir: string): void {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
}

#!/usr/bin/env node
/**
 * Standalone `@cloud-code/server` entry.
 *
 * The product surface is `cloud-code serve` (apps/cloud-code/src/cli/run-serve.ts);
 * this entry exists so SDK tests and development can spawn a server without
 * building the full CLI:
 *
 *   node --import tsx --import build/register-raw-text-loader.mjs \
 *     packages/server/src/cli.ts --transport stdio --home-dir <dir>
 *
 *   node --import tsx --import build/register-raw-text-loader.mjs \
 *     packages/server/src/cli.ts --transport ws --port 0 --token <t> --home-dir <dir>
 *
 * All diagnostics go to stderr; stdout is reserved for protocol frames.
 */
import { createServer } from './index';

interface CliArgs {
  transport: string;
  homeDir?: string;
  configPath?: string;
  uiMode?: string;
  host?: string;
  port?: number;
  token?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { transport: 'stdio' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string | undefined => argv[(i += 1)];
    switch (arg) {
      case '--transport':
        args.transport = next() ?? args.transport;
        break;
      case '--home-dir':
        args.homeDir = next();
        break;
      case '--config-path':
        args.configPath = next();
        break;
      case '--ui-mode':
        args.uiMode = next();
        break;
      case '--host':
        args.host = next();
        break;
      case '--port':
        args.port = Number.parseInt(next() ?? '', 10);
        break;
      case '--token':
        args.token = next();
        break;
      default:
        process.stderr.write(`[cloud-code serve] ignoring unknown argument: ${String(arg)}\n`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.transport !== 'stdio' && args.transport !== 'ws') {
    process.stderr.write(`[cloud-code serve] unsupported transport: ${args.transport}\n`);
    process.exit(1);
  }
  if (args.transport === 'ws' && (args.port === undefined || Number.isNaN(args.port))) {
    process.stderr.write('[cloud-code serve] ws transport requires --port <n> (0 = ephemeral)\n');
    process.exit(1);
  }
  const server = await createServer({
    transport: args.transport,
    homeDir: args.homeDir,
    configPath: args.configPath,
    uiMode: args.uiMode,
    host: args.host,
    port: args.port,
    token: args.token,
  });
  if (server.ws !== undefined) {
    // Tests and scripts parse these two lines off stderr.
    process.stderr.write(`[cloud-code serve] ws listening on ${server.ws.url}\n`);
    process.stderr.write(`[cloud-code serve] ws token: ${server.ws.token}\n`);
  }
  await server.closed;
  // The transport ended (stdin EOF: the client went away). Shut the host
  // down so core-held resources (MCP child processes, timers, log handles)
  // are released and this process exits instead of lingering as an orphan.
  // Bound the wait: a wedged close must not pin the process after the
  // client is already gone.
  await Promise.race([server.close(), unrefedTimeout(SHUTDOWN_TIMEOUT_MS)]);
}

/** Bound for the post-EOF shutdown (bridge close + session teardown + log flush). */
const SHUTDOWN_TIMEOUT_MS = 5_000;

function unrefedTimeout(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(`[cloud-code serve] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

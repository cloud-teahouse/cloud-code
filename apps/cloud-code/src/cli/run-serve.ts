import { createCloudCodeDefaultHeaders } from '@cloud-code/oauth';
import { resolveCloudCodeHome } from '@cloud-code/sdk';
import { createServer } from '@cloud-code/server';

import { OptionConflictError } from './options';
import { createCloudCodeHostIdentity } from './version';

export interface ServeCommandOptions {
  readonly transport: string | undefined;
  /**
   * UI mode applied to sessions created through this server (spawn-mode
   * clients forward their own mode; see RemoteRpcClient). Hidden flag.
   */
  readonly uiMode?: string | undefined;
  /** ws transport: bind address (default 127.0.0.1, design §2.3). */
  readonly host?: string | undefined;
  /** ws transport: port string from the CLI (`0` = ephemeral). */
  readonly port?: string | undefined;
  /** ws transport: bearer token (a random one is generated when omitted). */
  readonly token?: string | undefined;
}

/**
 * `cloud-code serve [--transport stdio|ws]`.
 *
 * stdio: runs the JSON-RPC protocol server on stdin/stdout until the client
 * closes the pipe. stdout carries protocol frames only — the server's startup
 * self-check reroutes any other stdout write to stderr, and all logging goes
 * to the diagnostic file sink.
 *
 * ws: binds 127.0.0.1 by default, requires a bearer token (generated
 * and printed to stderr when `--token` is omitted), and rejects
 * Origin-carrying browser upgrades (design §2.3).
 */
export async function runServe(opts: ServeCommandOptions, version: string): Promise<void> {
  const transport = opts.transport ?? 'stdio';
  if (transport !== 'stdio' && transport !== 'ws') {
    throw new OptionConflictError(`Unsupported transport "${transport}". Expected: stdio, ws.`);
  }
  const homeDir = resolveCloudCodeHome();
  const identity = createCloudCodeHostIdentity(version);
  const server = await createServer({
    transport,
    homeDir,
    cloudCodeRequestHeaders: createCloudCodeDefaultHeaders({
      homeDir,
      ...identity,
    }),
    appVersion: version,
    uiMode: opts.uiMode ?? undefined,
    host: opts.host,
    port: parseServePort(opts.port),
    token: opts.token,
  });
  if (server.ws !== undefined) {
    // stderr, never stdout: scripts read these, and stdout stays clean.
    process.stderr.write(`cloudcode serve listening on ${server.ws.url}\n`);
    process.stderr.write(`cloudcode serve token: ${server.ws.token}\n`);
  }
  await server.closed;
}

function parseServePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const port = Number.parseInt(raw, 10);
  if (Number.isNaN(port) || port < 0 || port > 65535 || String(port) !== raw.trim()) {
    throw new OptionConflictError(`Invalid --port "${raw}". Expected an integer 0-65535.`);
  }
  return port;
}

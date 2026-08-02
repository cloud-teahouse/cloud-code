import {
  createRPC,
  ErrorCodes,
  CloudCodeError,
  parseConfigString,
  resolveConfigPath,
  type RPCMethods,
} from '@cloud-code/agent-core';
import { z } from 'zod';

export type CloudCodeConfigValidationPathSegment = string | number;

export interface CloudCodeConfigValidationIssue {
  readonly path: readonly CloudCodeConfigValidationPathSegment[];
  readonly message: string;
}

export interface ResolveCloudCodeConfigPathInput {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
}

export interface ValidateCloudCodeConfigTomlInput {
  readonly text: string;
  readonly filePath?: string | undefined;
}

export interface CloudCodeConfigRpc {
  resolveConfigPath(input?: ResolveCloudCodeConfigPathInput): Promise<string>;
  validateConfigToml(input: ValidateCloudCodeConfigTomlInput): Promise<void>;
}

interface CloudCodeConfigCoreRpc {
  resolveConfigPath(input: ResolveCloudCodeConfigPathInput): string;
  validateConfigToml(input: ValidateCloudCodeConfigTomlInput): void;
}

interface CloudCodeConfigClientRpc {}

class CloudCodeConfigCoreRpcImpl implements CloudCodeConfigCoreRpc {
  resolveConfigPath(input: ResolveCloudCodeConfigPathInput): string {
    return resolveConfigPath(input);
  }

  validateConfigToml(input: ValidateCloudCodeConfigTomlInput): void {
    try {
      parseConfigString(input.text, input.filePath);
    } catch (error) {
      const validationIssues = extractValidationIssues(error);
      if (validationIssues !== undefined) {
        throw toConfigValidationError(error, validationIssues);
      }
      throw error;
    }
  }
}

export class CloudCodeConfigRpcClient implements CloudCodeConfigRpc {
  private readonly ready: Promise<RPCMethods<CloudCodeConfigCoreRpc>>;

  constructor() {
    const [coreRpc, clientRpc] = createRPC<CloudCodeConfigCoreRpc, CloudCodeConfigClientRpc>();
    void coreRpc(new CloudCodeConfigCoreRpcImpl());
    this.ready = clientRpc({});
  }

  async resolveConfigPath(input: ResolveCloudCodeConfigPathInput = {}): Promise<string> {
    const rpc = await this.ready;
    return rpc.resolveConfigPath(input);
  }

  async validateConfigToml(input: ValidateCloudCodeConfigTomlInput): Promise<void> {
    const rpc = await this.ready;
    await rpc.validateConfigToml(input);
  }
}

export function createCloudCodeConfigRpc(): CloudCodeConfigRpc {
  return new CloudCodeConfigRpcClient();
}

function toConfigValidationError(
  error: unknown,
  validationIssues: readonly CloudCodeConfigValidationIssue[],
): CloudCodeError {
  const details =
    error instanceof CloudCodeError && error.details !== undefined
      ? { ...error.details, validationIssues }
      : { validationIssues };

  if (error instanceof CloudCodeError) {
    return new CloudCodeError(error.code, error.message, { details });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new CloudCodeError(ErrorCodes.CONFIG_INVALID, message, { details });
}

function extractValidationIssues(error: unknown): readonly CloudCodeConfigValidationIssue[] | undefined {
  const zodError = findZodError(error);
  if (zodError === undefined) return undefined;
  return zodError.issues.map((issue) => ({
    path: issue.path.map((segment) =>
      typeof segment === 'number' ? segment : String(segment),
    ),
    message: issue.message,
  }));
}

function findZodError(error: unknown): z.ZodError | undefined {
  if (error instanceof z.ZodError) return error;
  if (error instanceof Error && error.cause instanceof z.ZodError) return error.cause;
  return undefined;
}

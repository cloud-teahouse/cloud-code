export type { StatResult } from './types';
export type { KaosProcess } from './process';
export type { KaosPtyProcess, PtyExecOptions } from './pty';
export type { Kaos } from './kaos';
export type {
  Environment,
  EnvironmentDeps,
  OsKind,
  ShellName,
} from './environment';
export { detectEnvironment, detectEnvironmentFromNode } from './environment';
export {
  KaosError,
  KaosValueError,
  KaosFileExistsError,
  KaosShellNotFoundError,
} from './errors';
export { LocalKaos } from './local';
export type {
  SandboxBackend,
  SandboxBackendStatus,
  SandboxExecRequest,
  SandboxInspection,
  SandboxMode,
  SandboxNetworkMode,
  SandboxPlan,
  SandboxPlanInput,
  SandboxPolicy,
  SandboxProbeResult,
} from './sandbox/types';
export type { SandboxDenialOutput } from './sandbox/denial';
export { isLikelySandboxDenied } from './sandbox/denial';
export { BubblewrapBackend, type BubblewrapBackendOptions } from './sandbox/bubblewrap';
export {
  DEFAULT_DENY_READ_PATHS,
  SandboxManager,
  type SandboxManagerOptions,
} from './sandbox/manager';
export { SandboxedKaos, type SandboxGuardOptions } from './sandbox/sandboxed-kaos';
export {
  BARE_GIT_REPO_FILES,
  bareGitRepoGuardPaths,
  planSandboxGuard,
  scrubReplacedGuardSymlinks,
  scrubSandboxGuardPaths,
  type SandboxGuardPlan,
  type SandboxGuardPlanInput,
  type SandboxSymlinkWatch,
} from './sandbox/guard';
export {
  chdir,
  exec,
  execWithEnv,
  getCurrentKaos,
  getcwd,
  gethome,
  glob,
  iterdir,
  mkdir,
  normpath,
  pathClass,
  readBytes,
  readLines,
  readText,
  runWithKaos,
  setCurrentKaos,
  stat,
  writeBytes,
  writeText,
} from './current';

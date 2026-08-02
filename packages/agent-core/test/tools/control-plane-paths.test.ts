/**
 * Control-plane guard path matrix: every auto-loaded,
 * high-privilege surface must land in the sandbox guard — project skills /
 * agent / MCP surfaces as scrub paths (ro-bound when present, host-deleted
 * when planted), user-level surfaces as read-only paths.
 */

import { describe, expect, it } from 'vitest';

import {
  collectControlPlaneGuardPaths,
  findProjectRootForGuard,
} from '../../src/agent/tool/control-plane-paths';

const BRAND_HOME = '/home/u/.cloud-code';
const USER_HOME = '/home/u';

function noGitExists(): boolean {
  return false;
}

describe('collectControlPlaneGuardPaths', () => {
  it('covers project skills, .cloud-code, .mcp.json, and .git/hooks as scrub paths', () => {
    const paths = collectControlPlaneGuardPaths({
      cwd: '/repo',
      brandHomeDir: BRAND_HOME,
      userHomeDir: USER_HOME,
      exists: noGitExists,
    });
    expect(paths.scrubPaths).toEqual([
      '/repo/.cloud-code',
      '/repo/.agents/skills',
      '/repo/.mcp.json',
      '/repo/.git/hooks',
    ]);
  });

  it('covers user-level skills, the brand home, and .git/config as read-only paths', () => {
    const paths = collectControlPlaneGuardPaths({
      cwd: '/repo',
      brandHomeDir: BRAND_HOME,
      userHomeDir: USER_HOME,
      exists: noGitExists,
    });
    expect(paths.readOnlyPaths).toContain(BRAND_HOME);
    expect(paths.readOnlyPaths).toContain('/home/u/.agents/skills');
    // ro-bind only, never scrubbed: a legitimate `git init` writes config.
    expect(paths.readOnlyPaths).toContain('/repo/.git/config');
    expect(paths.scrubPaths).not.toContain('/repo/.git/config');
  });

  it('guards both project-root and cwd .cloud-code when they differ', () => {
    // /repo has .git; the session cwd is a subdirectory whose own
    // .cloud-code/mcp.json is also a load path (config-loader resolves it
    // against cwd, not the project root).
    const paths = collectControlPlaneGuardPaths({
      cwd: '/repo/sub',
      brandHomeDir: BRAND_HOME,
      userHomeDir: USER_HOME,
      exists: (p) => p === '/repo/.git',
    });
    expect(paths.scrubPaths).toContain('/repo/.cloud-code');
    expect(paths.scrubPaths).toContain('/repo/sub/.cloud-code');
    expect(paths.scrubPaths).toContain('/repo/.agents/skills');
    expect(paths.scrubPaths).toContain('/repo/sub/.agents/skills');
    expect(paths.scrubPaths).toContain('/repo/.mcp.json');
    expect(paths.scrubPaths).toContain('/repo/sub/.mcp.json');
    expect(paths.scrubPaths).toContain('/repo/.git/hooks');
    expect(paths.scrubPaths).toContain('/repo/sub/.git/hooks');
    expect(paths.readOnlyPaths).toContain('/repo/.git/config');
    expect(paths.readOnlyPaths).toContain('/repo/sub/.git/config');
  });

  it('includes discovered skill roots (extra / plugin dirs) as read-only paths', () => {
    const paths = collectControlPlaneGuardPaths({
      cwd: '/repo',
      brandHomeDir: BRAND_HOME,
      userHomeDir: USER_HOME,
      skillRoots: ['/opt/shared-skills', '/repo/.cloud-code/skills'],
      exists: noGitExists,
    });
    expect(paths.readOnlyPaths).toContain('/opt/shared-skills');
  });

  it('never scrubs user-level paths when the workspace IS the home directory', () => {
    // cwd = ~: the conventional project paths alias the user-level ones.
    // Scrubbing there could delete brand state or user skills the host
    // legitimately created mid-command — they must degrade to read-only.
    const paths = collectControlPlaneGuardPaths({
      cwd: USER_HOME,
      brandHomeDir: BRAND_HOME,
      userHomeDir: USER_HOME,
      exists: noGitExists,
    });
    expect(paths.scrubPaths).not.toContain(BRAND_HOME);
    expect(paths.scrubPaths).not.toContain('/home/u/.agents/skills');
    expect(paths.scrubPaths).toContain('/home/u/.mcp.json');
    expect(paths.readOnlyPaths).toContain(BRAND_HOME);
    expect(paths.readOnlyPaths).toContain('/home/u/.agents/skills');
  });

  it('never scrubs the brand home when the project root is its parent', () => {
    const paths = collectControlPlaneGuardPaths({
      cwd: '/home/u',
      brandHomeDir: BRAND_HOME,
      userHomeDir: USER_HOME,
      exists: noGitExists,
    });
    for (const candidate of paths.scrubPaths) {
      expect(candidate.startsWith(`${BRAND_HOME}/`)).toBe(false);
    }
  });
});

describe('findProjectRootForGuard', () => {
  it('walks up to the nearest ancestor containing .git', () => {
    expect(findProjectRootForGuard('/repo/a/b', (p) => p === '/repo/.git')).toBe('/repo');
  });

  it('falls back to cwd when no .git exists anywhere up', () => {
    expect(findProjectRootForGuard('/no/git/here', noGitExists)).toBe('/no/git/here');
  });
});

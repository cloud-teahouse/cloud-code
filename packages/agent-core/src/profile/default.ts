import agentYaml from './default/agent.yaml?raw';
import coderYaml from './default/coder.yaml?raw';
import exploreYaml from './default/explore.yaml?raw';
import initMd from './default/init.md?raw';
import planYaml from './default/plan.yaml?raw';
import systemMd from './default/system.md?raw';
import { loadRawAgentProfilesFromSources } from './load';
import { resolveAgentProfiles } from './resolve';
import type { RawAgentProfile, ResolvedAgentProfile } from './types';

// Keyed by the source path the profile loader expects: profile YAML files
// plus any file referenced through `systemPromptPath`.
const PROFILE_SOURCES: Record<string, string> = {
  'profile/default/agent.yaml': agentYaml,
  'profile/default/coder.yaml': coderYaml,
  'profile/default/explore.yaml': exploreYaml,
  'profile/default/plan.yaml': planYaml,
  'profile/default/system.md': systemMd,
};

const DEFAULT_PROFILE_PATHS = ['agent.yaml', 'coder.yaml', 'explore.yaml', 'plan.yaml'].map(
  (file) => `profile/default/${file}`,
);

export const DEFAULT_INIT_PROMPT = initMd;

/**
 * Resolve the bundled default profiles, optionally merged with file-based
 * custom agents. Custom profiles extend the root `agent` profile and are
 * linked into its `subagents` map so the Agent tool can dispatch them; the
 * loader is responsible for rejecting customs named like a builtin.
 */
export function resolveDefaultAgentProfiles(
  customProfiles: readonly RawAgentProfile[] = [],
): Record<string, ResolvedAgentProfile> {
  const raws = loadRawAgentProfilesFromSources(DEFAULT_PROFILE_PATHS, PROFILE_SOURCES);
  const agentRaw = raws[0];
  if (agentRaw === undefined || customProfiles.length === 0) {
    return resolveAgentProfiles(raws);
  }
  const agentWithCustoms: RawAgentProfile = {
    ...agentRaw,
    subagents: {
      ...agentRaw.subagents,
      ...Object.fromEntries(customProfiles.map((profile) => [profile.name, {}])),
    },
  };
  return resolveAgentProfiles([agentWithCustoms, ...raws.slice(1), ...customProfiles]);
}

export const DEFAULT_AGENT_PROFILES = resolveDefaultAgentProfiles();

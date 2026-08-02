import { readConfigFileForUpdate, writeConfigFile } from '#/config';

/**
 * "Approve always" write-back (B2-1): appends the approved rule patterns to
 * the user config file (`~/.cloud-code/config.toml` → `permission.rules`) as
 * `allow` rules with scope `user`, so future sessions — and, via
 * {@link PermissionManager}'s in-memory adoption, the current one — treat
 * matching calls as user-configured allows.
 *
 * The write goes through the existing config pipeline: strict read
 * (`readConfigFileForUpdate` refuses to build on a salvage-parse, so a
 * broken-but-fixable config is never clobbered), schema validation, and an
 * atomic tmp+rename write (`writeConfigFile`). Any failure throws; the caller
 * degrades the approval to session scope.
 */

export const ALWAYS_APPROVAL_RULE_REASON = 'approve always';

export interface PersistAlwaysRulesResult {
  /** Patterns newly appended to the user config. */
  readonly added: readonly string[];
  /** Patterns skipped because an identical allow rule already exists. */
  readonly alreadyPresent: readonly string[];
}

export async function persistAllowRulesToUserConfig(input: {
  readonly configPath: string;
  readonly patterns: readonly string[];
  readonly reason?: string | undefined;
}): Promise<PersistAlwaysRulesResult> {
  if (input.patterns.length === 0) {
    return { added: [], alreadyPresent: [] };
  }
  const config = readConfigFileForUpdate(input.configPath);
  const existing = config.permission?.rules ?? [];
  const knownPatterns = new Set(
    existing.filter((rule) => rule.decision === 'allow').map((rule) => rule.pattern),
  );

  const added: string[] = [];
  const alreadyPresent: string[] = [];
  const rules = [...existing];
  for (const pattern of input.patterns) {
    if (knownPatterns.has(pattern)) {
      alreadyPresent.push(pattern);
      continue;
    }
    knownPatterns.add(pattern);
    rules.push({
      decision: 'allow',
      scope: 'user',
      pattern,
      reason: input.reason ?? ALWAYS_APPROVAL_RULE_REASON,
    });
    added.push(pattern);
  }

  if (added.length > 0) {
    await writeConfigFile(input.configPath, {
      ...config,
      permission: { ...config.permission, rules },
    });
  }
  return { added, alreadyPresent };
}

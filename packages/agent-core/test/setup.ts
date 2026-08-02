/**
 * Hermetic experimental-flag state for tests: scrub ambient
 * `KIMI_CODE_EXPERIMENTAL_*` env vars inherited from the developer shell
 * (e.g. a globally exported `KIMI_CODE_EXPERIMENTAL_FLAG=1`) so flag-driven
 * behavior — including tool schemas embedded in `llm.tools_snapshot`
 * snapshots — stays deterministic and matches CI. Tests opt into flags
 * explicitly via `vi.stubEnv` or harness flag options.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith('KIMI_CODE_EXPERIMENTAL_')) {
    delete process.env[key];
  }
}

// Never sign test commits: a developer shell with global commit.gpgsign=true
// and an unavailable key would fail every git commit the suites create.
process.env['GIT_CONFIG_COUNT'] = '1';
process.env['GIT_CONFIG_KEY_0'] = 'commit.gpgsign';
process.env['GIT_CONFIG_VALUE_0'] = 'false';

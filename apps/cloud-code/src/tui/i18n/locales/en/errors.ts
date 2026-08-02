// Backend error-code → localized actionable guidance, appended after the
// engine's verbatim `[code] message` (en). Guidance strings only — the error
// message itself stays as-is.

export const errors: Record<string, string> = {
  'errors.provider.api_error': 'Check the provider status or retry later.',
  'errors.provider.rate_limit': 'Retry after a delay or reduce request frequency.',
  'errors.provider.quota_exhausted':
    'ChatGPT plan exhausted ({window}; {reset}). Check the ChatGPT tab in /status, or /login to switch accounts.',
  'errors.provider.auth_error': 'Re-authenticate with the provider (see /login).',
  'errors.provider.connection_error': 'Check the network connection and retry.',
  'errors.context.overflow':
    'Run /compact to compact manually, start a new session, or switch to a model alias with a larger context window.',
  'errors.session.closed': 'The session is closed; reopen it or start a new one.',
  'errors.session.not_found': 'The session may have been moved or deleted.',
  'errors.model.config_invalid': 'Check the model and provider entries in config.toml.',
  'errors.auth.login_required': 'Run /login for the provider before retrying.',
  'errors.loop.max_steps_exceeded':
    'Increase loop_control.max_steps_per_turn in config.toml or split the task.',
  'errors.goal.not_found': 'No active goal.',
  'errors.goal.already_exists': 'Use replace to start a new goal.',
  'errors.goal.budget_reached': 'The goal hit its configured budget limit.',
  'errors.mcp.connect_failed': 'Check the server configuration in mcp.json.',
};

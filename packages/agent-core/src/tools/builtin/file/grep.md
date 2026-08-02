Search file contents using regular expressions (powered by ripgrep).

Use Grep when the task is to find unknown content or unknown file locations. Do not use shell `grep` or `rg` directly; this tool applies workspace path policy, output limits, and sensitive-file filtering.
ALWAYS use Grep tool instead of running `grep` or `rg` from a shell — direct shell calls bypass workspace policy, output limits, and sensitive-file filtering.
If you already know a concrete file path and need to inspect its contents, use Read directly instead.

Choose `output_mode` by what you need next: `files_with_matches` (the default) to locate candidate files before reading them, `content` when you need the matching lines themselves (bound the output with `head_limit`, `-C`, or a narrower `path`), and `count_matches` to gauge how widespread a pattern is before a refactor or rename.

Patterns match within a single line by default. For cross-line patterns such as `struct \{[\s\S]*?field`, set `multiline` to `true`.

For open-ended searches that may require multiple rounds of searching, delegate to the Agent tool (for example the explore subagent) instead of running many sequential Grep calls yourself.

Write patterns in ripgrep regex syntax, which differs from POSIX `grep` syntax. For example, braces are special, so escape them as `\{` to match a literal `{`.

Hidden files (dotfiles such as `.gitlab-ci.yml` or `.eslintrc.json`) are searched by default. To also search files excluded by `.gitignore` (such as `node_modules` or build outputs), set `include_ignored` to `true`. Sensitive files (such as `.env`) are always skipped for safety, even when `include_ignored` is `true`.

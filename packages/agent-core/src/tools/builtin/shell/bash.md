Execute a `{{ SHELL_NAME }}` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.

**Translate these to a dedicated tool instead:**
- `cat` / `head` / `tail` (known path) → `Read`
- `sed` / `awk` (in-place edit) → `Edit`
- `echo > file` / `cat <<EOF` → `Write`
- `find` / recursive `ls` to locate files by name pattern → `Glob` (plain `ls <known-directory>` is fine for listing a directory)
- `grep` / `rg` (search file contents) → `Grep`
- `echo` / `printf` (talk to the user) → just output text directly

The dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.

**Output:**
The stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a `Command failed with exit code: N` line; a command killed by its timeout or interrupted by the user ends with its own message instead.

If `run_in_background=true`, the command will be started as a background task and this tool will return a task ID instead of waiting for command completion. When doing that, you must provide a short `description`. Background commands default to a {{ DEFAULT_BACKGROUND_TIMEOUT_S }}s timeout and `timeout` is capped at {{ MAX_BACKGROUND_TIMEOUT_S }}s; set `disable_timeout=true` only when the task should run without a timeout. You will be automatically notified when the task completes. After starting one, default to returning control to the user instead of immediately waiting on it. Never background a command by appending `&` or wrapping it in `nohup` — `run_in_background=true` is the only supported way, and it is what registers the task so you get notified and the output lands in the task log. Use `TaskOutput` only for a non-blocking status/output snapshot — do not wait on a task you just launched, since its completion arrives automatically. Use `TaskStop` only if the task must be cancelled. If a human user wants to inspect background tasks themselves, point them to the `/tasks` command, which opens an interactive panel; it has no subcommands.

**Guidelines for safety and security:**
- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the `cwd` argument (or use absolute paths) rather than relying on a `cd` from an earlier call.
- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running foreground commands, set the `timeout` argument in seconds. Foreground commands default to {{ DEFAULT_TIMEOUT_S }}s and allow up to {{ MAX_TIMEOUT_S }}s. When a foreground command hits its timeout it is moved to the background instead of being killed, and you will be automatically notified when it completes.
- Avoid using `..` to access files or directories outside of the working directory.
- Avoid modifying files outside of the working directory unless explicitly instructed to do so.
- Never run commands that require superuser privileges unless explicitly instructed to do so.

**Guidelines for efficiency:**
- Use `&&` to chain commands that genuinely depend on each other, e.g. `npm install && npm test`. Independent read-only commands (separate `git show`, `ls`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with `echo` separators.
- Use `;` to run commands sequentially regardless of success/failure
- Use `||` for conditional execution (run second command only if first fails)
- Use pipe operations (`|`) and redirections (`>`, `>>`) to chain input and output between commands
- Always quote file paths containing spaces with double quotes (e.g., cd "/path with spaces/")
- Compose multi-step logic in a single call with `if` / `case` / `for` / `while` control flows.
- Prefer `run_in_background=true` for long-running builds, tests, watchers, or servers when you need the conversation to continue before the command finishes.
- Do not insert `sleep` between commands that can run immediately — just run them. Never retry a failing command in a sleep loop; diagnose the root cause instead.
- If you must poll an external process (for example a CI run), use a check command such as `gh run view` rather than sleeping first; if a sleep is unavoidable, keep it short (1-5 seconds) so the user is not blocked.

**Commands available:**
The following common command categories are usually available. Availability still depends on the host, so when in doubt run `which <command>` first to confirm a command exists before relying on it.
- Navigation and inspection: `ls`, `pwd`, `cd`, `stat`, `file`, `du`, `df`, `tree`
- File and directory management: `cp`, `mv`, `rm`, `mkdir`, `touch`, `ln`, `chmod`, `chown`
- Text and data processing: `wc`, `sort`, `uniq`, `cut`, `tr`, `diff`, `xargs`
- Archives and compression: `tar`, `gzip`, `gunzip`, `zip`, `unzip`
- Networking and transfer: `curl`, `wget`, `ping`, `ssh`, `scp`
- Version control: `git`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the `gh` CLI when installed — it carries the user's GitHub auth and can return structured JSON
- Process and system: `ps`, `kill`, `top`, `env`, `date`, `uname`, `whoami`
- Language and package toolchains: `node`, `npm`, `pnpm`, `yarn`, `python`, `pip` (use whichever the project actually relies on)

**Git operations:**
- Mutating git commands (commit, push, reset, rebase, amending, …) ask for user approval by default — if one is denied, do not retry the same mutation or route around it; adjust your approach or ask the user.
- Commit only when the user explicitly asks. When asked to commit, first gather state with parallel Bash calls in one response: `git status` (never `-uall`, which can blow up on large repos), `git diff` for staged and unstaged changes, and `git log` to match the repository's commit-message style.
- Draft a short message focused on the *why*. Do not stage files that likely contain secrets (`.env`, credentials) — warn the user if they asked for those. Stage specific files by name; never `git add -A` or `git add .`, which can sweep in secrets or large binaries.
- Pass the commit message via a HEREDOC to preserve formatting:

  ```sh
  git commit -m "$(cat <<'EOF'
  Commit message here.
  EOF
  )"
  ```

  Then run `git status` after the commit to verify.
- Never update the git config, never skip hooks (`--no-verify`, `--no-gpg-sign`) unless the user explicitly asks, and never use interactive flags (`git rebase -i`, `git add -i`) — interactive input is not supported.
- If a pre-commit hook fails, the commit did NOT happen — fix the issue, re-stage, and create a NEW commit. Never `--amend` after a hook failure: it would rewrite the PREVIOUS commit and can destroy work.
- For pull requests use the `gh` CLI. Before writing the PR, gather in parallel: `git status`, `git diff`, whether the branch tracks a remote and is up to date, and `git log` plus `git diff <base>...HEAD` for the full branch history. Review ALL commits going into the PR, not just the latest. Keep the title under 70 characters and pass the body via a HEREDOC with `## Summary` and `## Test plan` sections:

  ```sh
  gh pr create --title "the pr title" --body "$(cat <<'EOF'
  ## Summary
  <1-3 bullet points>

  ## Test plan
  <bulleted checklist>
  EOF
  )"
  ```

  Return the PR URL when done.

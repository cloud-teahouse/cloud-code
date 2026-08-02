Start a persistent interactive shell session running `{{ SHELL_NAME }}` command inside a PTY (pseudo-terminal). The process keeps running after this call returns, and you drive it later with the `WriteStdin` tool.

**To keep state across calls (the whole point of this tool), start the shell itself** — e.g. `command: "bash"` — then send follow-up commands with `WriteStdin`. `cd`, `export`, activated virtualenvs, and other shell state persist between `WriteStdin` calls. Starting a one-shot command here works too, but plain `Bash` is usually the better tool for that.

Use this tool to:
- Drive interactive programs and REPLs (`python3`, `node`, `psql`, `ssh`, `gh auth login`) that wait for stdin.
- Run a long-lived process (dev server, watcher) and poll its incremental output with `WriteStdin` at your own pace.
- Keep a shell whose env/cwd you build up over many steps.

**How it works:**
- The command runs in a PTY, so programs behave as if attached to a terminal. stdout and stderr arrive merged. `TERM=dumb`, `NO_COLOR=1`, and `PAGER=cat` are set to keep output plain.
- This call waits up to `yield_time_ms` for initial output, then returns: `session_id` (while the process is alive), the output so far, or `exit_code` if the process already exited.
- Output between polls is buffered; each `WriteStdin` poll returns only what is new since the previous poll. Very large bursts are head/tail truncated with an omission marker; the complete log is written to `output_path` — page through it with `Read`.
- Sessions survive across turns but NOT across CLI restarts/resume: after a resume, old session ids are dead and `WriteStdin` on them returns an error — start a fresh session and rebuild its state.
- When you are done with a session, send `exit\n` with `WriteStdin` to close it. Idle sessions are reclaimed automatically.

**Do not** use this for commands you could run with `Bash` in one shot — a session you forget to close holds a process open.

Write input to a running `ExecSession` shell session and/or poll its new output.

- `session_id` (required): the id returned by `ExecSession`.
- `chars` (optional): bytes written to the session's stdin verbatim, then a short wait for output. Control characters work: send `"\u0003"` (Ctrl-C) to interrupt, `"\u0004"` (Ctrl-D) for EOF, `"\n"` to submit a line. Omit `chars` (or pass `""`) to poll without writing.
- `yield_time_ms`: how long to wait for output. Defaults to 250ms after a write, 5000ms for a pure poll.
- Returns the output produced since your last poll (drain semantics), plus `exit_code` once the process has exited.

**Usage notes:**
- A shell session keeps its state (`cd`, `export`, venv) between calls — send commands one per call and read the incremental output.
- If a poll returns no output and the process is still running, it is either quiet or waiting for input — consider writing to it, sending Ctrl-C, or moving on and polling later.
- Sessions do not survive a CLI restart/resume. If this returns an error that the session does not exist, start a new one with `ExecSession` and rebuild its state.

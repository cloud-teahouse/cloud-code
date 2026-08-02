# Topic — Telemetry

**This repo has no telemetry. Do not add it.**

The telemetry package and every appender/facade that upstream kimi-code ships were **deleted** from this fork. There is no `ITelemetryService`, no event registry, no cloud appender, and no telemetry endpoint in the codebase. This is a deliberate product decision, not a gap to fill.

## What this means in practice

- **Do not add event reporting, metrics beacons, usage pings, crash uploads, or a "telemetry facade"** — under any name, gated or not, opt-in or not.
- **Do not reintroduce a package** (`packages/telemetry` or similar) or a dependency whose purpose is outbound analytics.
- **Do not let ported upstream code resurrect the plumbing.** When porting from upstream, delete its telemetry calls along with the import; if a ported function's only remaining value is emitting an event, drop the event and keep the logic. If upstream code keys behavior off a telemetry flag, simplify to the non-telemetry path.
- **Logging is not telemetry.** The local pino-style root logger (`src/logging/`) writes to the user's own disk under `~/.cloud-code` — that is fine and stays. The line is: nothing leaves the machine for analytics. Log strings are also exempt from i18n (tui.md), which is another reason not to route user-facing copy through logs.
- **Diagnostic context travels over existing channels.** Prefix-drift and cache diagnostics use the local `debug.cache_diagnostics` config + `CLOUD_CODE_DEBUG_CACHE` env; resume-consistency audits are warn-only local logs. Extend those local diagnostics when you need observability — never an outbound channel.
- Code references to "telemetry" in upstream-herited comments should be cleaned up when touched; do not propagate the term into new code.

## Red lines (this topic)

- No telemetry, in any form, ever — the package was deleted deliberately.
- No outbound analytics channel, no facade "for future use", no dead-but-wired plumbing.
- Ported code arrives without its telemetry calls; simplify behavior that branched on telemetry flags.
- Observability needs are served by local logs and local debug config only.

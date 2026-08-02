---
name: loop
description: Run a prompt or slash command on a recurring interval (e.g. /loop 5m /review, /loop check the deploy every 20m — defaults to 10m). Use when the user wants to set up a recurring task, poll for status on an interval, or run something repeatedly. Do not use for one-off tasks or one-time reminders.
---

# /loop — schedule a recurring prompt

Parse the input below into `[interval] <prompt…>` and schedule it with CronCreate.

## Parsing (in priority order)

1. **Leading token**: if the first whitespace-delimited token matches `^\d+[smhd]$` (e.g. `5m`, `2h`), that's the interval; the rest is the prompt.
2. **Trailing "every" clause**: otherwise, if the input ends with `every <N><unit>` or `every <N> <unit-word>` (e.g. `every 20m`, `every 5 minutes`, `every 2 hours`), extract that as the interval and strip it from the prompt. Only match when what follows "every" is a time expression — `check every PR` has no interval.
3. **Default**: otherwise, interval is `10m` and the entire input is the prompt.

If the input is empty or the resulting prompt is empty, show this usage and stop — do not call CronCreate:

```
Usage: /loop [interval] <prompt>

Run a prompt or slash command on a recurring interval.

Intervals: Ns, Nm, Nh, Nd (e.g. 5m, 30m, 2h, 1d). Minimum granularity is 1 minute.
If no interval is specified, defaults to 10m.

Examples:
  /loop 5m /review
  /loop 30m check the deploy
  /loop check the deploy          (defaults to 10m)
  /loop check the deploy every 20m
```

Parsing examples:

- `5m /review` → interval `5m`, prompt `/review` (rule 1)
- `check the deploy every 20m` → interval `20m`, prompt `check the deploy` (rule 2)
- `run tests every 5 minutes` → interval `5m`, prompt `run tests` (rule 2)
- `check the deploy` → interval `10m`, prompt `check the deploy` (rule 3)
- `check every PR` → interval `10m`, prompt `check every PR` (rule 3 — "every" not followed by time)
- `5m` → empty prompt → show usage

## Interval → cron

Supported suffixes: `s` (seconds, rounded up to the nearest minute, min 1), `m` (minutes), `h` (hours), `d` (days). Convert:

| Interval pattern  | Cron expression          | Notes |
|-------------------|--------------------------|-------|
| `Nm` where N ≤ 59 | `*/N * * * *`            | every N minutes |
| `Nm` where N ≥ 60 | round to whole hours (H = round(N/60)), then use the `Nh` row | cron can't express 1.5h cleanly |
| `Nh` where N ≤ 23 | `<minute> */N * * *`     | every N hours |
| `Nd`              | `<minute> <hour> */N * *` | every N days; default to a morning hour (e.g. `7 9 */N * *`) unless the user named a time |
| `Ns`              | treat as `ceil(N/60)m`   | cron minimum granularity is 1 minute |

For the `<minute>` placeholder, pick a minute that is NOT 0 or 30 (herd avoidance — every naive "hourly" schedule lands on :00) unless the user named an exact mark. Same for `<hour>` when the time of day is approximate.

**If the interval doesn't cleanly divide its unit** (e.g. `7m` → `*/7 * * * *` gives uneven gaps at :56→:00; `90m` → 1.5h which cron can't express), pick the nearest clean interval and tell the user what you rounded to before scheduling.

## Action

1. Call CronCreate with:
   - `cron`: the expression from the table above
   - `prompt`: the parsed prompt from above, verbatim (slash commands are passed through unchanged)
   - `recurring`: `true`
   - `durable`: leave at the default (`false`) unless the user explicitly wants the loop to outlive this session. Durable tasks are written to the project's `.cloud-code/scheduled_tasks.json` and fire in whichever session owns the project schedule.
2. Briefly confirm: what's scheduled, the cron expression, the human-readable cadence, that recurring tasks auto-expire after 7 days (recreate to keep the loop going), and that the user can cancel sooner by asking you to CronDelete it (include the job id).
3. **Then immediately execute the parsed prompt now** — don't wait for the first cron fire. If it's a slash command, invoke it via the Skill tool; otherwise act on it directly.

## Input

$ARGUMENTS

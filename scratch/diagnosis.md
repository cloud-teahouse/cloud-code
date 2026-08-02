# Diagnosis scratch notes (not committed docs)

## Report A — "context hits 99% and auto-compaction never fires"

### Trigger path (verified end-to-end)
- Turn loop: `packages/agent-core/src/agent/turn/index.ts:1118` calls
  `graduatedCompaction.beforeStep(stepSignal)` at EVERY step boundary (per step, not per turn).
- `graduated.ts beforeStep`: arms tool-result budget at 70% of window, pinpoint clear at 78%
  (both on the EFFECTIVE count), then `fullCompaction.shouldAutoCompact(effectiveTokenCount())`
  gates `fullCompaction.beforeStep` → `checkAutoCompaction` → `beginAutoCompaction`.
- Strategy (`strategy.ts`): trigger 0.85 × effective window; `reservedContextSize` 50_000 also
  triggers when `used + 50k >= max` (skipped when max <= 50k). Window comes from
  `getEffectiveMaxContextTokens()` = `min(configured, observed-overflow)`; 0/unknown ⇒ never fires.
- Custom models MUST declare `max_context_size` (ProviderManager throws otherwise), and the
  custom-registry import defaults to 131072 — so "unknown window" is NOT the report's mechanism.
- Display: `Agent.emitStatusUpdated` (agent.ts:726) sends `contextTokens = context.tokenCount`
  and `contextUsage = tokenCount / (max_input_tokens ?? max_context_tokens)`; the footer
  (`formatContextStatus`, footer.ts:211) recomputes the percent from those counts.

### Root causes found
1. **Unit mismatch / double subtraction in `effectiveTokenCount()`** (the real trigger bug).
   - `context.tokenCount` is REPLACED by provider-reported usage at every `step.end`
     (context/index.ts ~994: `_tokenCount = totalUsage`). That number is net of the graduated
     rewrites because the request was built from the rewritten projection.
   - `effectiveTokenCount()` then subtracts `saved` (raw-estimate − projected-estimate) a SECOND
     time ⇒ effective count is systematically too low once layers arm.
   - Consequences: (a) layer EXTENSION stalls (`tryArm*` requires effective >= 70%/78%, so the
     armed cutoff freezes; new big tool results stay verbatim in the projection);
     (b) full-compaction escalation needs `raw >= trigger + saved`, which can exceed the window
     itself ⇒ proactive auto-compact NEVER fires; only the reactive PTL-drain/overflow path
     rescues the session. Display (provider-reported projection) climbs to ~99% meanwhile.
   - Fix: `realizedSavingsBaseline` — when provider usage replaces the covered count
     (step.end with totalUsage > 0), snapshot current savings; subtract only savings accrued
     after that. Estimate-based counts (usage-blind providers) keep baseline 0 = today's math.
2. **Display shows a different number than the trigger uses.**
   - Usage-blind providers (third-party OpenAI-compatible proxies that strip `usage`, e.g. the
     user's "GPT-5.6-Luna" setup): `tokenCount` accumulates RAW estimates (context/index.ts
     step.end totalUsage==0 branch adds `estimateTokensForMessages`), so the footer shows
     raw-stored/window while the trigger sees raw−saved (the projection the model actually gets).
     Footer 99% with trigger at 40% is reachable in tool-heavy sessions.
   - Fix: `emitStatusUpdated` reports the graduated-aware effective count (public
     `effectiveTokenCount()`), so the footer percent IS the compaction trigger's percent.

### Tests (server-level, real wire path — packages/server/test/auto-compact.e2e.test.ts)
- A1: usage-reporting mock provider, text-heavy, window 40000: compaction.started(auto) fires
  when crossing 85%; mock sees the compaction instruction; tokenCount drops. PASSES (pre- and post-fix).
- A2: usage-reporting, tool-heavy (Bash 25KB outputs, window 80000): layers keep extending,
  request sizes stay < 68k, status stays < 85%. FAILS pre-fix (requests blow past the window,
  status 1.58), PASSES post-fix.
- A3: usage-blind mock (no usage in responses): footer follows effective count (< 85%) while
  stored raw > 99% — the user's exact symptom. FAILS pre-fix (status 1.58), PASSES post-fix.
- Unit test in graduated.test.ts for the realized-savings baseline: PASSES.

### Fixes landed
- graduated.ts: `realizedSavingsBaseline` + public `onProviderUsageRealized()` +
  public `effectiveTokenCount()` (raw − (saved − baseline)); savings scan extracted to
  private `currentSavings()` (memo unchanged); `reset()` zeroes the baseline.
- context/index.ts step.end usage branch (totalUsage > 0): calls `onProviderUsageRealized()`.
- agent.ts `emitStatusUpdated`: reports `graduatedCompaction.effectiveTokenCount()` so the
  footer percent IS the trigger's percent. Snapshot fallout (9 files, pending-inclusive
  counts 444→452 etc.) updated via `vitest -u`; teammate-mailbox failure was parallelism flakiness.
- AGENTS.md graduated-compaction line documents the new accounting + status semantics.
- Deliberately NOT changed: REST `sessionService.getStatus` (public protocol surface; still
  reports stored counts — flagged as follow-up).

### Third finding (not fixed, by-design gap worth noting)
- Full trigger = min(0.85×max, max − reservedContextSize 50_000). Budget arm = 0.70×max.
  For windows ≤ ~166.6k (e.g. the 131072 custom-registry default) the reserved term makes
  full compaction fire at ~62% — BEFORE the cheap layers can arm. Inverted layering vs the
  documented "cheapest first" intent; symptom is compaction firing EARLY, not never.

## Report B — "output style has no obvious change"

### Path (verified)
- TUI `/output-style` (apps/cloud-code/src/tui/commands/output-style.ts):
  `session.setOutputStyle(name)` (live) + `harness.setConfig({ outputStyle: name })` (persist).
- Live: SDK → wire `setOutputStyle` → core-impl → SessionAPIImpl → `Session.setOutputStyle`
  → validates against loaded styles, moves session runtimeConfig, `agent.setOutputStyle`
  → latches + `refreshSystemPrompt` → assembly replaces ONLY the two style-surface sections
  (`communicating-with-user`, `delivering-work`) + appends `Output style: <name>` marker
  (system-prompt-assembly.ts:313).
- Persist: `setCloudCodeConfig` → mergeConfigPatch → config.toml `output_style` → reload.
  New sessions: core-impl passes config into `new Session`; Agent ctor seeds `outputStyleName`
  from `options.config.outputStyle` (agent.ts:270). Prior fix e7198342a covers post-switch
  subagent spawns; e2e exists at test/session/output-style-effectiveness.e2e.test.ts.
- The two replaceable sections are ~2 of 17 headings in profile/default/system.md (~10-15% of
  prompt bytes) — behavior shift on casual questions is inherently subtle (by design).

### Verification plan (packages/server/test/output-style.e2e.test.ts, real RPC + real wire)
- prompt → loopback mock captures system prompt bytes (stock anchors, no marker).
- wire `setOutputStyle` 'concise' → next prompt has concise body + marker, stock body gone.
- switch 'reviewer' → different bytes again (reviewer body, concise body gone).
- wire `setCloudCodeConfig({outputStyle:'reviewer'})` → config.toml contains output_style;
  a NEW session's first request already carries the reviewer style (persistence round-trip).

### Results — ALL PASS, no bug found in the switch/persist/fan-out path
- Bytes reach the wire on the very next request via the exact RPCs the TUI uses
  (`setOutputStyle` live + `setCloudCodeConfig` persist); different styles → different bytes;
  persisted `output_style = "reviewer"` in config.toml seeds new sessions.
- Note: concise only replaces `communicating-with-user` (its .md has no `# Delivering work`
  split), reviewer replaces both — per-style body coverage is a property of each style file.
- "No obvious change" assessment: the replaceable surface is 2 of 17 template sections
  (~5.8KB of ~37KB ≈ 16% of prompt bytes), and the deltas are prose-tone guidance, so casual
  Q&A barely shifts visible behavior — works as designed; the model-side compliance cannot be
  tested locally, but the instruction bytes provably reach the wire (and the
  `Output style: <name>` marker lets the model self-report).
- Prior fix e7198342a (post-switch subagent spawns) already covered by
  test/session/output-style-effectiveness.e2e.test.ts (passes unchanged).

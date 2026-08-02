# Topic — Compaction layers

How context pressure is relieved in `agent-core`. This subsystem is **ours** — `agent/compaction/graduated.ts` replaced upstream's `micro.ts`. Read this before touching context projection, token accounting, or overflow recovery.

## The graduated model

Three layers with **independent thresholds, counters, and failure isolation**, orchestrated per step by `GraduatedCompaction.beforeStep`:

```text
pressure (effective count / window)
  0.70 ── Layer 1: tool_result_budget   lossless offload, projection-only rewrite
  0.78 ── Layer 2: pinpoint_clear       marker replacement, keyed by tool_call id
  0.85 ── Full compaction (FullCompaction)  LLM summarization of the whole history
  overflow ─ Layer 3: ptl_drain         reactive only, armed by APIContextOverflowError
```

### Layer 1 — tool_result_budget (armed at 0.70)

Old oversized tool results (>16 KB / 400 lines, outside the last 20 messages) are persisted to `<agentDir>/tool-results/` and replaced **in the outgoing projection only** with a head/tail preview plus the file path. Lossless: stored history keeps the full facts. (The related execution-time budget — a single fresh result >50 KB / 2000 lines — is handled by `agent/turn/tool-result-budget.ts` and is tunable via `loopControl.toolResultMaxBytes/MaxLines`.)

### Layer 2 — pinpoint_clear (at 0.78)

Older tool results are swapped for the `[Old tool result content cleared]` marker, keyed by tool_call id so call/result pairing survives. Legacy upstream `micro_compaction.apply` records restore into this layer.

### Full compaction (at 0.85 or `reservedContextSize` 50 000 headroom)

`FullCompaction` (`compaction/full.ts`) runs LLM summarization, triggered by `DefaultCompactionStrategy` (`compaction/strategy.ts`; ratio tunable via `loopControl.compactionTriggerRatio`). The summarizer receives history minus the pinned prefix; `ContextMemory.applyCompaction` rewrites live context to:

```text
[pinned prior summaries verbatim]
[kept real user messages — head 2k + tail of a 20k budget with elision marker]
[summary with COMPACTION_SUMMARY_PREFIX]
```

Keep/drop is decided by `compactionUserMessageDisposition` on `PromptOrigin` (`compaction/handoff.ts`). Everything is recorded (`full_compaction.begin/complete`, `context.apply_compaction` with kept/pinned/dropped counts), so resume reproduces the fold exactly while the wire log retains the full unfolded history. The summarizer's own input overflow is tracked (`droppedCount`); up to 5 retry attempts.

### Layer 3 — ptl_drain (reactive, overflow only)

Armed by the turn's overflow chain on `APIContextOverflowError` (`agent/turn/`): L0 force-arms layers 1–2 ignoring ratios; L1 drops leading whole API rounds sized to the provider-reported token gap (×1.1, else 20% of the request estimate); L2 escalates to full compaction; L3 throws after 3 consecutive overflow recoveries.

## The effective-count rule (do not freeze the layers)

Layers are projection-side rewrites applied in `ContextMemory.project`, keyed by tool-call id, monotonically extended, `reset()` on undo/clear/compaction, and logged as `graduated_compaction.apply` records.

Token accounting must not double-count: when provider-reported usage covers `tokenCount`, the savings from rewrites *already in effect* at that moment fold into the realized baseline; only savings applied *after* are deducted separately. The `agent.status.updated` event and the compaction trigger share this single effective count — the footer percentage is exactly what the trigger sees. If you change the accounting, keep those two consumers on the same number or the UI will lie about pressure.

## Working on compaction — rules

- Each layer has its own threshold, its own counters, and its own failure isolation — a failing layer must not block or corrupt the others.
- Layers 1–2 rewrite the **projection**, never the stored history; full compaction is the only layer that rewrites live context, and even it leaves the wire log unfolded.
- Every applied rewrite is recorded so resume reproduces it; never mutate history outside the record/mutator path (persistence.md).
- Compaction-adjacent behavior reminders are re-injected after compaction (`agent/injection/behavior-reminders.ts`) via the history-tail `injection` origin — not through the system-prompt append bus, and never perturbing `systemHash` (cache-first discipline).

## Red lines (this topic)

- Do not reintroduce a single-threshold "micro compaction" — the three-layer graduated model is the design.
- Projection rewrites stay projection-side; stored history is sacred.
- The effective count is one number shared by trigger and footer — no parallel accounting.
- Layers are independently armed and failure-isolated.
- Overflow recovery (ptl_drain) is reactive only; never arm it from ratios.
- Every compaction effect is a wire record; resume must reproduce the fold exactly.

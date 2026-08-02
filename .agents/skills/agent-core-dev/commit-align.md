# Subskill — Commit align (triage an `upstream/main` commit)

Context: you are catching the fork up to **new commits that landed on `upstream/main`** (the `upstream` remote, MoonshotAI/kimi-code). The job is to decide, for one commit at a time, whether we already have the corresponding logic — and if not, what the minimal fix is.

Use this when the user hands you **one upstream commit hash plus a short description** ("look at `<commit>` — it fixed the steering race"). It is the small, per-commit sibling of [align.md](align.md): `align.md` ports a whole upstream feature/domain; this file triages a single commit and says *port / adapt / skip*. If the triage reveals a whole missing domain, stop and switch to [align.md](align.md).

## The one-paragraph mental model

An upstream commit edits upstream's tree. The same behavior here lives behind our architecture (graduated compaction, guardian, teammate/coordinator runtime, sandbox, central registries, deleted telemetry, Cloud Code brand). A commit therefore lands in one of four buckets: **already-aligned** (we have it, possibly by construction), **partial** (we have a nearby version whose semantics drifted), **missing** (we have nothing), or **not-applicable** (our architecture removed the very problem the commit fixes — or it touches something we deleted, like telemetry or kap-server). Your output is a bucket assignment plus evidence, then a fix sized to that bucket — never a blind port of the diff.

## The workflow

```text
Read the commit + the user's note → Locate the upstream logic → Map to our domain
→ Check our tree for a corresponding implementation → Bucket it → Recommend a fix → Verify
```

### 1. Read the commit and the note

Know exactly what changed upstream and *why*. The user's one-liner gives the intent; the diff gives the facts.

- Inspect the change: `git show <commit> --stat` for the blast radius, then `git show <commit>` (the objects are local — no fetch needed).
- List: touched files, changed functions, and the observable behavior delta (before → after).
- Reconcile with the note: bugfix, semantic correction, new behavior, or refactor? The *why* decides whether we even need it.

Do not skim the user's sentence and guess — the diff is the spec for what "aligned" means here.

### 2. Locate the upstream logic

Pin the change to a place upstream: the contract + impl, the helper, the policy, the config key. Note which state it reads/writes and what it calls — the same inventory as [align.md](align.md) §1, scoped to the commit's footprint.

### 3. Map to our domain

Use the mapping table in [align.md](align.md) §3 as a starting point, then **verify against our current tree** — `packages/agent-core/src/` and `apps/cloud-code/src/` are the source of truth. Check the divergence map first: if the commit touches compaction, telemetry, permission ordering, the TUI, or wire records, our counterpart is not where upstream's is.

### 4. Check our tree and assign a bucket

Search the candidate domain (Grep the method name, the state field, the error code, the record type). For each piece of the commit's behavior delta:

- **Already-aligned** — we produce the same observable result (sometimes for free: our design never had the bug, e.g. a race our serialized metadata writes already prevent). Cite our `path:line`.
- **Partial** — we have a near miss: same method, different guard/ordering/threshold; or the state lives with a different owner. Name the exact drift.
- **Missing** — nothing here owns this behavior. Confirm it is a single-unit gap, not a whole-domain gap (latter → [align.md](align.md)).
- **Not-applicable** — our architecture removed the condition the commit fixes (the graduated layers already cover it; the sandbox makes it moot), or the commit touches something we deleted (telemetry, kap-server, v2-only code). Explain why, so a reviewer trusts the skip.

Every claim needs a citation (`path:line`) on both sides; "I couldn't find it" is a finding only after you name where you looked.

### 5. Recommend a fix (sized to the bucket)

- **Already-aligned** — say so and stop; reference our location. No code change.
- **Partial** — propose the smallest edit that closes the drift: which file, which method, which guard. Stay inside our rules — owner/lifetime placement, chain precedence, no telemetry, brand contract (align.md red lines).
- **Missing** — sketch the port at commit granularity: target domain and owner, the method/record/policy to add or extend, dependency direction, and which [align.md](align.md) §5 conversions apply (strip telemetry, central registries, brand, i18n). If it needs a wire-record change or a new RPC, flag it.
- **Not-applicable** — recommend no change, but call out any test worth adding so the gap stays closed.

Keep the recommendation to the commit's footprint. If it keeps growing, that is the signal to hand off to [align.md](align.md).

### 6. Verify

Point at the checks that cover the fix, per [verify.md](verify.md): `pnpm build`, `pnpm test` (scoped package first), `pnpm lint`. Note the expected outcome rather than asserting you ran it if you did not.

## Output shape

Answer in this order so the user can act directly:

1. **Commit + intent** — one line restating what it changed and why (note + diff).
2. **Upstream location** — file(s) and the behavior delta.
3. **Our status** — one of the four buckets, with `path:line` evidence on both sides.
4. **Recommendation** — the concrete fix (or the justified skip), scoped to the commit; name the target owner and dependency direction.
5. **Verify** — which checks should pass, and whether to escalate to [align.md](align.md).

## Red lines (this subskill)

- Read the diff and the note before judging; never infer "aligned" from the description alone.
- Do not copy an upstream diff into our tree. Decide the bucket first; a bugfix commit often maps to **not-applicable** because our design already removed the defect.
- Commits touching deleted subsystems (telemetry, kap-server, agent-core-v2) are not-applicable by construction — say so and stop.
- Cite `path:line` on both sides. A recommendation without evidence is a guess.
- Stay in the commit's footprint. Growing scope means "switch to [align.md](align.md)", not "keep porting here".
- Do not break our invariants to chase upstream parity — chain precedence, brand contract, no telemetry, and the boundary rules still hold.

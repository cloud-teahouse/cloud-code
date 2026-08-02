---
name: review
description: Review code changes — the uncommitted diff by default, or a PR number, branch, or commit range passed as an argument — and report findings sorted by severity with file:line references. Use when the user asks to review their changes, a pull request, or a branch.
---

# Review changes (review)

Act as an expert code reviewer. Review the changes the user cares about and report concrete problems, ordered by severity.

Review target (from the arguments): $ARGUMENTS

## Step 1 — Collect the diff

Pick the source of truth from the arguments above:

- **No arguments** — review the uncommitted changes in the working tree. Run `git status --short` and `git diff HEAD` with the Bash tool. Files listed as untracked (`??`) have no diff output; Read them in full.
- **A PR number or PR URL** — review that pull request. Run `gh pr view <number>` for context (title, body, base branch) and `gh pr diff <number>` for the diff.
- **A branch name** — diff it against its merge base with the current HEAD: run `git merge-base HEAD <branch>` and then `git diff <merge-base>...<branch>` (or `git diff <branch>...` from the branch's upstream when one exists).
- **A commit range** (anything containing `..`, or a ref such as `HEAD~3`) — run `git diff <range>`.

If the diff is empty, say so and stop. If `gh` fails (not installed, not authenticated, no PR found), report the error and suggest the local-diff fallback.

## Step 2 — Read for context

Do not review diff hunks in isolation. For each changed file, Read enough of the surrounding code to judge the change: the full function, the callers you can find with Grep, and the tests that cover the file. Check the project's conventions (existing patterns, lint config, AGENTS.md) before calling something unconventional.

## Step 3 — Analyze

Focus on what matters, in this order:

1. **Correctness** — logic errors, off-by-one mistakes, wrong conditionals, unhandled error paths, race conditions, broken edge cases (empty input, null, unicode, large payloads).
2. **Regressions** — changed behavior for existing callers, removed validation, altered public APIs without updated call sites, missing test updates.
3. **Security** — only obvious, newly introduced issues (injection, leaked secrets, missing authz checks). For a deep security pass, point the user at the `security-review` skill instead of expanding this section.
4. **Performance** — new N+1 queries, unbounded loops or allocations, missing indexes implied by new queries, needless re-computation in hot paths.
5. **Conventions & tests** — deviation from the codebase's established patterns, missing or weakened test coverage for the new behavior.

Skip: pure style preferences, pre-existing issues outside the diff, and speculative "could be cleaner" notes. Every finding must be something you would confidently raise in a real PR review.

## Output format

Report in markdown, findings **sorted by severity** (Critical first, then High, Medium, Low). For each finding:

```
### [Severity] file.ts:42 — one-line title
What is wrong and why it matters (one or two sentences).
Suggested fix: concrete change, with a short code sketch when it helps.
```

Severity guide:

- **Critical** — will break in production, lose data, or open a security hole.
- **High** — likely bug or regression on a realistic path.
- **Medium** — bug under specific conditions, missing coverage for risky logic.
- **Low** — worth fixing but not urgent.

Close with a one-paragraph overall assessment (what the change does, whether it is safe to merge, what must be fixed first). If there are no findings, say that plainly — do not invent issues to fill the report.

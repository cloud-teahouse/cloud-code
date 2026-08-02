---
name: pr_comments
description: Fetch comments on a GitHub pull request with the gh CLI and work through them one by one — classify each thread, apply the actionable code feedback, and report how every comment was handled. Use when the user asks to check, triage, or address PR review comments.
---

# Handle PR comments (pr_comments)

Fetch the review comments on a GitHub pull request and work through them, one thread at a time.

Target PR (from the arguments): $ARGUMENTS

## Step 1 — Resolve the PR

- If the arguments contain a PR number or URL, use it.
- Otherwise resolve the PR for the current branch: run `gh pr view --json number,headRepository,headRefName,title`. If there is no PR for this branch, say so and stop.

Get the repository coordinates with `gh repo view --json nameWithOwner --jq .nameWithOwner` (or take them from the PR JSON above).

## Step 2 — Fetch all comments

Use the `gh` CLI with the Bash tool, and `jq` to parse:

- PR-level conversation: `gh api /repos/{owner}/{repo}/issues/{number}/comments`
- Inline review comments: `gh api /repos/{owner}/{repo}/pulls/{number}/comments`

For inline comments, pay attention to `body`, `diff_hunk`, `path`, `line`, and `in_reply_to_id` so threads stay grouped. When a comment refers to code and the hunk is not enough, Read the referenced file locally (the branch is usually checked out) instead of fetching contents from the API.

If both endpoints return empty, report "No comments found." and stop.

## Step 3 — Classify each thread

Go through every comment thread and assign exactly one category:

- **change** — actionable code feedback (bug, correctness, missing handling, test request). Includes a clear request to modify code.
- **question** — the reviewer asks for an explanation; no code change needed.
- **nitpick** — style, naming, or preference suggestions with no functional impact.
- **noise** — praise, acknowledgements, resolved or obsolete threads.

## Step 4 — Handle them one by one

- **change** — Read the relevant code, apply the fix, and note what you changed and where. If you disagree with the feedback, say why instead of changing the code.
- **question** — answer it from the code you can read; quote the relevant lines.
- **nitpick** — apply it when trivial and clearly aligned with the codebase's conventions; otherwise list it as skipped.
- **noise** — no action.

Stay on the current working tree; do not commit, push, or post replies to GitHub unless the user explicitly asks.

## Output format

First a compact inventory of the threads, then the actions:

```
## Comments on PR #<number> (<title>)

- @author `path/to/file.ts:42` [change]: one-line summary of the feedback
  ```diff
  <diff_hunk, when the comment is inline>
  ```
- @author (PR-level) [question]: summary
  > quoted comment text

## Actions taken

1. `file.ts:42` — fixed: what changed and why.
2. Question from @author — answered: short version of the answer.
3. Nitpick from @author — skipped: reason.
```

Every fetched thread must appear in the inventory, and every `change`/`question` thread must have a matching entry under "Actions taken".

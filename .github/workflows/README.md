# Workflows

| Workflow | File | Trigger | Manual run |
|---|---|---|---|
| CI | `ci.yml` | push to `dev`, every PR | yes |
| Release | `release.yml` | pushing a `v*` tag | no (tag-only, see below) |
| Publish to npm | `publish-npm.yml` | GitHub Release published | yes |

## CI (`ci.yml`)

Two jobs:

- **build-test-lint** — installs with `pnpm install --frozen-lockfile`, then runs
  `pnpm build`, `pnpm test`, and `pnpm lint` on Ubuntu.
- **bun-binary** — builds the single-file binaries for Linux (x64/arm64), macOS
  (x64/arm64), and Windows (x64), and uploads them as Actions artifacts. The
  injected version is `<short-sha8>-beta` (e.g. `6c7ebe6a-beta`). Artifacts are
  kept for 14 days. No GitHub Release is created.

**Run manually:** Actions → CI → Run workflow. Useful for getting beta binaries
from a branch without opening a PR.

## Release (`release.yml`)

Builds the same five platform binaries, smoke-checks the Linux x64 one against
the tag version, packages them as `.tar.gz`/`.zip` with a `sha256sums.txt`
(raw binaries *and* archives are summed — the `/update` client verifies against
this file), generates bilingual (en/zh-CN) release notes from
`apps/cloud-code/CHANGELOG.md` (falling back to the commit list since the
previous tag), and creates the GitHub Release. Tags containing `-` are marked
as prereleases.

**No `workflow_dispatch` on purpose.** Re-running a tag publish halfway through
can leave a partially-uploaded release, so concurrency is set to never cancel.
To re-run a failed release, use "Re-run failed jobs" in the Actions UI; to redo
one from scratch, delete the GitHub Release, re-push the tag.

## Publish to npm (`publish-npm.yml`)

Publishes the `cloudcode-cli` package (from `apps/cloud-code`) to npm with
provenance. The published package's postinstall downloads the platform binary
from the GitHub Release assets of the same tag and verifies it against
`sha256sums.txt`, so the GitHub Release must exist first.

Runs automatically when a GitHub Release is published.

**Run manually:** Actions → Publish to npm → Run workflow, then enter the tag
to publish (e.g. `v0.2.1`). Use this to re-publish (or publish for the first
time) a tag whose Release already exists.

## Secrets

| Secret | Used by | Status |
|---|---|---|
| `GITHUB_TOKEN` | `release.yml` (creates the Release) | automatic, no setup needed |
| `NPM_TOKEN` | `publish-npm.yml` (npm authentication) | **not yet configured** — create a granular access token on npmjs.com with publish rights for `cloudcode-cli` and add it under Settings → Secrets and variables → Actions |
| `AUR_SSH_KEY` | none yet — planned for pushing the `cloudcode-bin` AUR package from the release flow (see `docs/open-source-plan.md`) | **not yet configured** — no workflow consumes it today; add the AUR account's SSH private key here when that step lands |

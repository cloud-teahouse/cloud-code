#!/usr/bin/env bash
# Replay dev commits onto public-main as curated public commits, one per
# logical change, then print the push command. Replaces the old single
# mega-snapshot so the public history reads like real development.
#
#   scripts/public-sync.sh                 # replay everything since the last sync
#   scripts/public-sync.sh --dry-run       # print the plan, touch nothing
#   scripts/public-sync.sh <base>..<end>   # explicit range
#
# What the public tree must never carry is enforced per commit (paths are
# stripped from every replayed change) and by a final housekeeping pass:
#   docs/  release-channel/  .github/workflows/dev-ci.yml  .public-export
# Commit messages are scrubbed by the replacement table below and then
# hard-fail on any leftover blocked token, so a leaky message stops the run
# instead of slipping through.
set -euo pipefail

EXPORT_DIR=".public-export"
REMOTE_URL="https://github.com/cloud-teahouse/cloud-code.git"
FORBIDDEN_PATHS=(docs release-channel .github/workflows/dev-ci.yml .public-export)
WELCOME_TS="apps/cloud-code/src/tui/components/chrome/welcome.ts"

# sed -E rules applied to every commit message.
SCRUB_RULES=(
  's|yspbwx2010/cloud-code|cloud-teahouse/cloud-code|g'
  's|yspbwx2010|cloud-teahouse|g'
)
# After scrubbing, any of these in a message aborts the run (leak guard).
BLOCKED_TOKENS=('CL4R1T4S' 'claude-code-analysis' 'claude-code-system-prompts' 'docs/state.md' 'docs/phase' '批次' '收官' 'yspbwx2010')

DRY_RUN=0
RANGE=''
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *..*) RANGE="$arg" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"
# Note: the range end is the `dev` ref — uncommitted changes are simply not
# replayed; the main worktree is never touched.

# The last sync point is recorded in public-main's own history (Source: dev@…).
last_sync_sha() {
  git log public-main --format='%B' -20 | grep -oE 'dev@[0-9a-f]{9,40}' | head -1 | cut -c5-
}
if [ -z "$RANGE" ]; then
  base="$(last_sync_sha || true)"
  [ -n "${base:-}" ] || { echo "no previous sync marker found; pass an explicit range" >&2; exit 1; }
  RANGE="${base}..dev"
fi

commits="$(git rev-list --reverse --no-merges "$RANGE")"
[ -n "$commits" ] || { echo "nothing to replay for $RANGE"; exit 0; }

git worktree prune
if [ ! -d "$EXPORT_DIR" ]; then
  git worktree add "$EXPORT_DIR" public-main >/dev/null
else
  git -C "$EXPORT_DIR" checkout -q public-main
fi

# Public-only deltas the replay would otherwise wash out of any touched file.
housekeeping() {
  local changed=0
  if ! grep -q 'CloudCode Contributors' "$EXPORT_DIR/LICENSE"; then
    sed -i 's|^Copyright (c) 2026 Moonshot AI$|&\nCopyright (c) 2026 CloudCode Contributors|' "$EXPORT_DIR/LICENSE"
    changed=1
  fi
  if ! grep -qF "[' ▐█▛█▛█▌', ' ▐█████▌', '']" "$EXPORT_DIR/$WELCOME_TS"; then
    sed -i "s|const logo = \[.*\] as const;|const logo = [' ▐█▛█▛█▌', ' ▐█████▌', ''] as const;|" "$EXPORT_DIR/$WELCOME_TS"
    changed=1
  fi
  if [ "$changed" = 1 ] && [ "$DRY_RUN" != 1 ]; then
    git -C "$EXPORT_DIR" add LICENSE "$WELCOME_TS"
    git -C "$EXPORT_DIR" commit -q -m "chore: public packaging deltas (LICENSE copyright, upstream mascot)"
    echo "housekeeping: packaging deltas committed"
  fi
}

planned=0
skipped=0
for sha in $commits; do
  subject="$(git log -1 --format=%s "$sha")"
  # Upfront skip: a commit touching only forbidden paths would conflict on
  # replay (public lacks the files, so a modify looks like delete-vs-edit).
  touches_public=0
  while IFS= read -r path; do
    case "$path" in
      docs/*|release-channel/*|.github/workflows/dev-ci.yml|.public-export/*) ;;
      *) touches_public=1; break ;;
    esac
  done < <(git diff-tree --no-commit-id --name-only -r "$sha")
  if [ "$touches_public" = 0 ]; then
    echo "skip  ${sha:0:9}  (forbidden paths only)  $subject"
    skipped=$((skipped + 1))
    continue
  fi
  # Replay into the export index without committing, strip forbidden paths,
  # then see what is left. -X theirs: a mixed commit (public + forbidden
  # paths) conflicts on the forbidden files (public lacks them); taking the
  # dev side is safe because forbidden paths are stripped right after, and
  # the two packaging files (LICENSE, mascot) are re-asserted by
  # housekeeping at the end.
  if ! git -C "$EXPORT_DIR" cherry-pick -n -X theirs "$sha" >/dev/null 2>&1; then
    echo "CONFLICT replaying $sha ($subject) — resolve inside $EXPORT_DIR, then re-run; already-replayed commits come out empty and are skipped" >&2
    exit 1
  fi
  for p in "${FORBIDDEN_PATHS[@]}"; do
    git -C "$EXPORT_DIR" rm -r -q --cached --ignore-unmatch "$p" 2>/dev/null || true
    rm -rf "${EXPORT_DIR:?}/$p"
  done
  if git -C "$EXPORT_DIR" diff --cached --quiet; then
    echo "skip  ${sha:0:9}  (empty after path filter)  $subject"
    skipped=$((skipped + 1))
    git -C "$EXPORT_DIR" reset -q --hard
    continue
  fi
  message="$(git log -1 --format=%B "$sha")"
  for rule in "${SCRUB_RULES[@]}"; do
    message="$(printf '%s' "$message" | sed -E "$rule")"
  done
  for token in "${BLOCKED_TOKENS[@]}"; do
    if printf '%s' "$message" | grep -qF "$token"; then
      echo "BLOCKED token '$token' in scrubbed message of $sha — reword the dev commit or extend the scrub rules" >&2
      git -C "$EXPORT_DIR" reset -q --hard
      exit 1
    fi
  done
  echo "pick  ${sha:0:9}  $subject  ($(git -C "$EXPORT_DIR" diff --cached --stat | tail -1 | tr -s ' ' | sed 's/^ //'))"
  planned=$((planned + 1))
  if [ "$DRY_RUN" = 1 ]; then
    git -C "$EXPORT_DIR" reset -q --hard
    continue
  fi
  git -C "$EXPORT_DIR" commit -q -m "$message

Source: dev@${sha}"
done

housekeeping

if [ "$DRY_RUN" = 1 ]; then
  echo "dry-run: $planned commit(s) would replay, $skipped skipped for $RANGE"
  exit 0
fi

echo "replayed $planned commit(s), skipped $skipped (empty after filter)"
echo "public-main is now: $(git -C "$EXPORT_DIR" log --oneline -1)"
echo "verify the log, then push with:"
echo "  git -C $EXPORT_DIR push $REMOTE_URL public-main:main --force-with-lease"

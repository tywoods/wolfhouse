#!/usr/bin/env bash
# Captain — run at the START of every Lunabox session.
set -euo pipefail
REPO=/opt/wolfhouse/WH
cd "$REPO"

# Integration branch = origin's default (falls back to master).
BASE=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@' || true)
BASE=${BASE:-master}

echo "[captain] git fetch (so we see what Cursor/laptop pushed)..."
git fetch --prune origin

branch=$(git branch --show-current)
if [ "$branch" = "$BASE" ]; then
  # On the integration branch: fast-forward to remote.
  echo "[captain] git pull (ff-only) on $BASE..."
  git pull --ff-only
else
  # On a feature branch: don't touch it, just report how far behind base it is.
  behind=$(git rev-list --count "HEAD..origin/$BASE" 2>/dev/null || echo 0)
  echo "[captain] On feature branch '$branch' (base origin/$BASE is $behind commit(s) ahead)."
  [ "${behind:-0}" -gt 0 ] && echo "[captain]   Rebase onto latest base when ready:  git rebase origin/$BASE"
fi

echo "[captain] $(git log -1 --oneline)"
git status -sb

if [ "$branch" = "$BASE" ]; then
  echo "[captain] ⚠ You are on '$BASE'. Before durable edits, branch:  git switch -c captain/<short-name>"
fi
echo "[captain] Ready. Durable edits: docker/hermes-staging/ on a captain/* branch (base: $BASE)."

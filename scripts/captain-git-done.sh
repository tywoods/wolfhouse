#!/usr/bin/env bash
# Captain — run before ENDING a Lunabox session (or when calling work "done").
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# Integration branch = origin's default (falls back to master).
BASE=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@' || true)
BASE=${BASE:-master}

# 1) Hard gate: nothing uncommitted.
dirty=$(git status --porcelain)
if [ -n "$dirty" ]; then
  echo "[captain] FAIL — uncommitted changes. Commit on captain/* then push:"
  git status -sb
  exit 1
fi

# 2) Refresh remote state so drift/push checks are accurate.
if git fetch --prune origin >/dev/null 2>&1; then :; else
  echo "[captain] WARN — git fetch failed (offline?). Drift checks skipped; verify before merging."
fi

branch=$(git branch --show-current)

# 3) Drift: did base move under me while I worked? (caveat: laptop/Cursor pushed)
if git rev-parse --verify --quiet "origin/$BASE" >/dev/null && [ "$branch" != "$BASE" ]; then
  behind=$(git rev-list --count "HEAD..origin/$BASE" 2>/dev/null || echo 0)
  if [ "${behind:-0}" -gt 0 ]; then
    echo "[captain] ⚠ DRIFT — origin/$BASE has $behind new commit(s) not in '$branch'."
    echo "[captain]   Rebase before merging/PR:  git rebase origin/$BASE"
  fi
fi

# 4) Push reminders for captain/* work.
if [[ "$branch" == captain/* ]]; then
  if git rev-parse --verify --quiet "origin/$branch" >/dev/null; then
    ahead=$(git rev-list --count "origin/$branch..HEAD" 2>/dev/null || echo 0)
    [ "${ahead:-0}" -gt 0 ] && echo "[captain] REMINDER — push $ahead commit(s):  git push"
  else
    echo "[captain] REMINDER — branch not on remote yet:  git push -u origin $branch"
  fi
fi

echo "[captain] OK — nothing left uncommitted locally."

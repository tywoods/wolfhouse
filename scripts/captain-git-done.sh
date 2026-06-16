#!/usr/bin/env bash
# Captain — run before ENDING a Lunabox session (or when calling work "done").
set -euo pipefail
REPO=/opt/wolfhouse/WH
cd "$REPO"
dirty=$(git status --porcelain)
if [ -n "$dirty" ]; then
  echo "[captain] FAIL — uncommitted changes. Commit on captain/* then push:"
  git status -sb
  exit 1
fi
branch=$(git branch --show-current)
if [[ "$branch" == captain/* ]]; then
  if git status -sb | grep -qE '\[ahead'; then
    echo "[captain] REMINDER — push your branch: git push -u origin $branch"
  fi
fi
echo "[captain] OK — nothing left uncommitted locally."

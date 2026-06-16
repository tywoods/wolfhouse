#!/usr/bin/env bash
# Captain — run at the START of every Lunabox session.
set -euo pipefail
REPO=/opt/wolfhouse/WH
cd "$REPO"
echo "[captain] git pull..."
git pull --ff-only
echo "[captain] $(git log -1 --oneline)"
git status -sb
echo "[captain] Ready. Durable edits: docker/hermes-staging/ on branch captain/short-name."

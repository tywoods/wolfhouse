#!/bin/sh
set -eu
mode=${1:---dry-run}
case "$mode" in --dry-run) prune='worktree prune --dry-run';; --apply) prune='worktree prune';; *) echo 'usage: worktree-prune-dry-run.sh [--dry-run|--apply]' >&2; exit 2;; esac
# Never run host `git worktree prune`: gitdir paths are container-relative.
for item in 'hermes-captain:/opt/data/workspace/sandbox-repos/WH-captain' 'hermes-orchestrator:/opt/data/workspace/sandbox-repos/WH-orchestrator' 'hermes-deckhand:/opt/data/workspace/sandbox-repos/WH-deckhand' 'hermes-seadog:/opt/data/workspace/sandbox-repos/WH-seadog'; do
 container=${item%%:*}; repo=${item#*:}
 docker exec "$container" sh -lc "test -d '$repo/.git' && git -C '$repo' $prune" || true
done

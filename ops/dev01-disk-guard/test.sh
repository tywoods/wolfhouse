#!/bin/sh
set -eu
cd "$(dirname "$0")"
python3 -m unittest discover -s tests -v
python3 -m py_compile cleanup.py daemon_config.py disk_alert.py
sh -n build-cache-prune.sh worktree-prune-dry-run.sh test.sh

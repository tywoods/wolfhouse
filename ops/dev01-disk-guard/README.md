# Dev-01 disk guard

Server-side, fail-closed housekeeping for the `/data` disk. Nothing here is installed or activated automatically.

## Safety model

* `cleanup.py` is **report-only** and emits JSON lines. `--apply` is refused because plain Linux pathname/descriptor checks cannot provide an enforceable writer/rename exclusion through removal. Repeated snapshots do not close that final race.
* Candidates are restricted to known bot scratch roots. Main repos, `/data/shared`, `/data/releases`, Docker/containerd stores, bot state/home, secrets and protected names are never candidates.
* A candidate needs both an old top-level mtime and no descendant newer than its cutoff. Captain artifacts use 3 days; other scratch uses 7 days. The newest three workspace releases are retained.
* `/proc/*/{cwd,fd/*}` references are checked in both host and `/opt/data` container path forms.
* Git candidates fail closed on broken gitdirs, dirty state, stashes, absent upstream, unpushed commits, or unknown ancestry. Nested repositories are checked too.
* `review-prNNNN-*` requires an explicit `CLOSED` or `MERGED` entry in a supplied JSON map. Missing/unknown/open states are skipped.
* Worktree metadata pruning is only performed by `docker exec` in the owning bot container. The checked-in service invokes dry-run pruning only.

## Local tests (fixtures only)

```sh
./ops/dev01-disk-guard/test.sh
```

Tests create tiny temporary trees; they never inspect or alter real `/data`.

## Chief's later real-disk dry run

After review, from the repo root on Dev-01:

```sh
python3 ops/dev01-disk-guard/cleanup.py \
  --pr-states-json /run/dev01-disk-guard/pr-states.json
```

The PR-state file is an operator-produced object such as `{"1365":"OPEN","1405":"MERGED"}`. Output is diagnostic only: cleanup apply remains unavailable until a separately reviewed mechanism can hold an enforceable writer/rename exclusion through removal. Never run host `git worktree prune`.

## Docker log configuration (prepare only)

```sh
python3 daemon_config.py /etc/docker/daemon.json /tmp/daemon.json.dev01
python3 -m json.tool /tmp/daemon.json.dev01 >/dev/null
```

This preserves unrelated keys and sets `json-file`, `max-size=20m`, `max-file=3`. Diff and approve it separately. This package does **not** copy it into place or restart Docker.

## Timers

Units under `systemd/` provide:

* cleaner dry run nightly at 03:30 Europe/Madrid with `nice`/`ionice`;
* buildx cache-only pruning weekly, retaining 2 GB for `zeroazure-builder` and `default`;
* disk checks every five minutes: yellow at 85%, red at 90% or less than 15 GiB available.

The alert posts to Chief of Staff thread `1537017482748100678`, deduplicating by level. Supply the Discord token only through `DISCORD_BOT_TOKEN` or `DISCORD_BOT_TOKEN_FILE`; the example unit references `/etc/dev01-disk-guard/discord-token`. Installation, token creation, `daemon-reload`, enablement, and starts are intentionally left for Chief's approved host phase.

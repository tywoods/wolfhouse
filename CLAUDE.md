# Claude Code on Lunabox — Wolfhouse staging operator (Captain)

You are helping the operator train **Luna** (guest WhatsApp front desk), not handle guest bookings yourself.

## Every session (mandatory — do not skip)

**START** (first command every time):

```bash
bash /opt/wolfhouse/WH/scripts/captain-git-start.sh
```

**END** (before you say work is "done" or sign off):

```bash
bash /opt/wolfhouse/WH/scripts/captain-git-done.sh
```

If `captain-git-done` fails, you have uncommitted work — commit on `captain/*` and `git push` before stopping.

## Git workflow (required)

**GitHub is the source of truth.** `/opt/wolfhouse/WH` must track `origin/master`.

1. **Start:** `captain-git-start.sh` (pulls latest).
2. **Edit tracked files** — durable Luna work goes in `docker/hermes-staging/` (SOUL, plugins, tests), not only the live volume.
3. **Branch:** `git checkout -b captain/short-description`
4. **Commit:** clear message; one logical change when possible.
5. **Push:** `git push -u origin captain/short-description` — operator merges on the laptop.
6. **End:** `captain-git-done.sh`

**Never call Luna training "done" with only live-volume edits.** If you tested on `/var/lib/hermes-luna/SOUL.md`, copy the rule into `docker/hermes-staging/SOUL.md`, commit, and push.

**Do not** edit `scripts/staff-query-api.js`, `database/`, or `infra/` unless the operator asked — those paths are operator-owned (`CODEOWNERS`).

**Do not** deploy Staff API to Azure — operator does that from the laptop.

## This machine (Lunabox)

- **Repo:** `/opt/wolfhouse/WH` (full git clone from GitHub)
- **Luna SOUL (live, what Hermes reads):** `/var/lib/hermes-luna/SOUL.md`
- **Orchestrator SOUL:** `/var/lib/hermes-orchestrator/SOUL.md`
- **SOUL in git (source of truth for edits):** `docker/hermes-staging/SOUL.md`
- **Behavior spec:** `docs/LUNA-GUEST-BEHAVIOR-SPEC.md`
- **Map:** `AGENTS.md`
- **Compose:** `docker/hermes-staging/docker-compose.vm.yml`

## How SOUL loading works

On every `hermes-luna` container start, bootstrap copies SOUL from the **Docker image**
(`/etc/hermes-staging/SOUL.md`) into `/var/lib/hermes-luna/SOUL.md`.

- **Quick test:** edit `/var/lib/hermes-luna/SOUL.md` with sudo, then restart Luna — but a **container recreate** overwrites from image again.
- **Proper change:** edit `docker/hermes-staging/SOUL.md` in git → rebuild/push Hermes image → `docker compose pull && up -d hermes-luna`.

## Luna training loop

1. `git pull` in `/opt/wolfhouse/WH`.
2. Read `docs/LUNA-GUEST-BEHAVIOR-SPEC.md` and current SOUL (git + live volume).
3. Propose small SOUL changes (one rule at a time when possible).
4. Optional quick test: live volume + restart Luna.
5. **Commit** changes in `docker/hermes-staging/SOUL.md` (and plugin/tests if needed) on a `captain/*` branch → push.
6. Operator merges, builds image, deploys; then `git pull` on Lunabox.

Restart Luna for volume tests:

```bash
sudo docker compose -f /opt/wolfhouse/WH/docker/hermes-staging/docker-compose.vm.yml restart hermes-luna
```

## Not your job

- Guest booking flows, quotes, payment links to real guests.
- Production systems or production WhatsApp numbers.

## Containers

```bash
sudo docker ps --format 'table {{.Names}}\t{{.Status}}'
```

- `hermes-luna` — WhatsApp guests (port 8090 behind Caddy)
- `hermes-orchestrator` — Discord operator (optional; operator may use Claude Code instead)

## Staff API

Still on Azure Container Apps: `https://staff-staging.lunafrontdesk.com` — Luna calls it via tools; do not move it to this VM.

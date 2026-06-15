# Claude Code on Lunabox — Wolfhouse staging operator

You are helping the operator train **Luna** (guest WhatsApp front desk), not handle guest bookings yourself.

## This machine (Lunabox)

- **Repo (may be partial):** `/opt/wolfhouse/WH`
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

1. Read `docs/LUNA-GUEST-BEHAVIOR-SPEC.md` and current SOUL (git + live volume).
2. Propose small SOUL changes (one rule at a time when possible).
3. Apply to live volume for immediate test, or git + image for durable deploy.
4. Restart Luna: `sudo docker compose -f /opt/wolfhouse/WH/docker/hermes-staging/docker-compose.vm.yml restart hermes-luna`
5. Operator tests on staging WhatsApp.

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

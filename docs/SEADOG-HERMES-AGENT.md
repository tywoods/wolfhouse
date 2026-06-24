# Seadog — Hermes Discord agent

**Seadog** is a dedicated Hermes container on Lunabox for operator chat on **Discord**, separate from **Skipper** (`hermes-orchestrator`) and **Luna** (`hermes-luna`).

```
Operator (Discord) → hermes-seadog → ChatGPT 5.5 OAuth (shared auth.json); Anthropic fallback
Guests (WhatsApp)  → hermes-luna  → Luna guest front desk
Skipper (Discord)  → hermes-orchestrator → Luna training / Hermes ops
```

## VM layout

| Path | Purpose |
|------|---------|
| `/var/lib/hermes-seadog` | Seadog `HERMES_HOME` |
| `/etc/hermes-seadog.env` | Discord bot token + allowlist |
| `docker/hermes-staging/seadog-SOUL.md` | Git source for Seadog identity (baked into image on rebuild) |

Compose service: `hermes-seadog` in `docker/hermes-staging/docker-compose.vm.yml`.

Port **8644** — Seadog API server (Discord gateway). Skipper stays on **8642**; Luna WhatsApp webhook on **8090**.

## Bootstrap role

Set `HERMES_ROLE=seadog`. Bootstrap (`docker/hermes-staging/bootstrap.sh`) then:

- Writes a Discord-only config (no WhatsApp, no Luna plugins)
- Sets terminal cwd to `/opt/wolfhouse/WH`
- Copies `seadog-SOUL.md` → `$HERMES_HOME/SOUL.md`
- Links shared OAuth from `/var/lib/hermes-shared/auth.json`

## First-time VM setup (operator)

After merging this branch and rebuilding the Hermes staging image:

```bash
sudo mkdir -p /var/lib/hermes-seadog
sudo chown 10000:10000 /var/lib/hermes-seadog

# Use a dedicated Discord bot (recommended) — copy orchestrator env as template:
sudo cp /etc/hermes-orchestrator.env /etc/hermes-seadog.env
# Edit DISCORD_BOT_TOKEN / DISCORD_ALLOWED_USERS for Seadog

cd /opt/wolfhouse/WH
sudo docker compose -f docker/hermes-staging/docker-compose.vm.yml pull
sudo docker compose -f docker/hermes-staging/docker-compose.vm.yml up -d hermes-seadog
```

## Verification

```bash
bash -n docker/hermes-staging/bootstrap.sh
```

Image rebuild must include `COPY seadog-SOUL.md` in `docker/hermes-staging/Dockerfile` (follow-up if not yet on the branch).

See also: [`HERMES-AZURE-VM.md`](./HERMES-AZURE-VM.md).

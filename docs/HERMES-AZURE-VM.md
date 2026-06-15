# Hermes on Lunabox (Azure Linux VM, staging)

Hermes staging runs on **Lunabox** — an Azure Linux VM — so `/var/lib/hermes-shared/auth.json` (Anthropic + ChatGPT OAuth) survives restarts. Staff API, Postgres, and the staff portal stay on existing Container Apps.

```
You (Discord)     → hermes-orchestrator → Anthropic OAuth (shared auth.json)
Guests (WhatsApp) → hermes-luna         → ChatGPT 5.5 OAuth → Anthropic OAuth fallback
                         ↓
              Staff API (wh-staging-staff-api on ACA) → Postgres
```

**Hostname:** `lunabox.lunafrontdesk.com` (or IP-only for the first week — use `http://<public-ip>:8090/whatsapp/webhook` for Meta until Caddy TLS is live).

Hermes recommends **one Docker container per profile**. Lunabox runs two containers with separate data dirs and a shared read-only `auth.json`.

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| VM name | `lunabox` |
| DNS | `lunabox.lunafrontdesk.com` (optional week 1) |
| Luna WhatsApp model | **gpt-5.5** via **openai-codex** OAuth; fallback **anthropic/claude-sonnet-4-6** OAuth |
| API keys in Luna `.env` | No — OAuth only in shared `auth.json` |
| ACA `wh-staging-hermes` | Keep running until VM is fully cut over and stable; then scale to 0 |
| Discord | Token already available — set `DISCORD_BOT_TOKEN` (KV or env) before `write-env-files` |

## Prerequisites

- Azure CLI (`az login`)
- Resource group `wh-staging-rg`
- ACR `whstagingacr` with staging Hermes image
- Key Vault secrets: WhatsApp, Luna bot token, Discord bot token (optional in KV)
- DNS A record: `lunabox.lunafrontdesk.com` → Lunabox public IP (when ready)

## Quick start (from dev machine)

```bash
# Discord token (if not in Key Vault yet)
$env:DISCORD_BOT_TOKEN="..."   # PowerShell
$env:DISCORD_ALLOWED_USERS="your-discord-user-id"

node scripts/deploy-staging-hermes-vm.js status
node scripts/deploy-staging-hermes-vm.js build-image
node scripts/deploy-staging-hermes-vm.js create-vm
node scripts/deploy-staging-hermes-vm.js write-env-files
node scripts/deploy-staging-hermes-vm.js bootstrap-remote
node scripts/deploy-staging-hermes-vm.js verify
```

## VM layout

| Path | Purpose |
|------|---------|
| `/var/lib/hermes-orchestrator` | Orchestrator `HERMES_HOME` (Discord, repo cwd) |
| `/var/lib/hermes-luna` | Luna `HERMES_HOME` (WhatsApp, sessions) |
| `/var/lib/hermes-shared/auth.json` | Shared OAuth credential pool (ChatGPT + Anthropic) |
| `/opt/wolfhouse/WH` | Wolfhouse git repo |
| `/etc/hermes-orchestrator.env` | Discord token + allowlist |
| `/etc/hermes-luna.env` | WhatsApp + Staff API secrets (no model API keys) |

Compose: `docker/hermes-staging/docker-compose.vm.yml`

Ports: **8642** orchestrator, **8090** Luna WhatsApp webhook.

## One-time OAuth (shared auth.json)

On Lunabox after first boot:

```bash
IMAGE=whstagingacr.azurecr.io/wh-hermes-staging:latest
AUTH=/var/lib/hermes-shared/auth.json

# ChatGPT / Codex OAuth (Luna primary — gpt-5.5)
docker run --rm -it -v "$AUTH:/opt/data/auth.json" "$IMAGE" hermes auth add openai-codex

# Anthropic OAuth (Luna fallback + orchestrator primary)
docker run --rm -it -v "$AUTH:/opt/data/auth.json" "$IMAGE" hermes auth add anthropic --type oauth
```

Both containers mount the same file read-only. Re-run only if OAuth expires.

## Discord (orchestrator)

You already have the bot token. Either:

1. Store in Key Vault as `discord-bot-token`, or
2. Pass when generating env files: `$env:DISCORD_BOT_TOKEN="..."` then `write-env-files`

Restart after update:

```bash
docker compose -f /opt/wolfhouse/WH/docker/hermes-staging/docker-compose.vm.yml restart hermes-orchestrator
```

## TLS + Meta webhook

After DNS points to Lunabox, uncomment Caddy block in `/etc/caddy/hermes-staging.caddy`:

```caddy
lunabox.lunafrontdesk.com {
  reverse_proxy /whatsapp/* localhost:8090
  reverse_proxy localhost:8642
}
```

Meta webhook URL:

```
https://lunabox.lunafrontdesk.com/whatsapp/webhook
```

Or: `node scripts/cutover-meta-whatsapp-to-hermes.js apply` (defaults to Lunabox URL).

## Cutover from Container Apps

**Do not scale down ACA until:**

1. Lunabox WhatsApp webhook verified (guest message round-trip)
2. Staff portal inbox mirror working
3. You are no longer using ACA Hermes for testing

Then:

```bash
az containerapp update -g wh-staging-rg -n wh-staging-hermes --min-replicas 0 --max-replicas 0
```

## Related

- ACA legacy: `docs/HERMES-AZURE-CONTAINER-APPS.md`
- Luna behavior: `docs/LUNA-GUEST-BEHAVIOR-SPEC.md`

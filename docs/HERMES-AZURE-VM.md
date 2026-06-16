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

## Wolfhouse repo on Lunabox (OpenClaw + Hermes compose)

Lunabox has a **full git clone** at `/opt/wolfhouse/WH` synced via **private GitHub** (laptop + Captain both push/pull). Setup once: **`docs/GITHUB-REPO-SETUP.md`**.

**Daily sync:**

```bash
# Laptop — before push or deploy
node scripts/check-repo-sync.js

# Lunabox — after operator pushes
ssh lunabox
cd /opt/wolfhouse/WH && git pull
```

**Legacy (no GitHub):** one-way laptop → VM bundle — only if GitHub is down; run `check-repo-sync` first so you do not clobber Captain commits:

```bash
node scripts/deploy-staging-hermes-vm.js sync-repo
```

**Point OpenClaw (Captain) at the repo** (on Lunabox, after clone):

```bash
openclaw config set agents.defaults.workspace /opt/wolfhouse/WH
openclaw onboard --auth-choice anthropic-cli   # Claude Max already logged in
# Skip WhatsApp channel — hermes-luna owns the Meta number
openclaw gateway install   # optional: systemd gateway on loopback :18789
```

Do not attach OpenClaw WhatsApp to the same Meta number as `hermes-luna`.

Disk: Lunabox was tight (~89% used). After `sync-repo`, run `docker system prune` if needed before large pulls.

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

## Model failover & the Anthropic usage 400

Luna's `config.yaml` is written by `bootstrap.sh` (baked into the image at
`/etc/cont-init.d/99-wh-staging-bootstrap`), which sets primary **gpt-5.5
openai-codex**, fallback **anthropic/claude-sonnet-4-6** — the locked decision
above. The VM overlay `99z-wh-vm-post-bootstrap.sh`
(`/etc/cont-init.d/99z-wh-vm-post-bootstrap`, mounted via the compose volume)
runs after it and now **only** symlinks `auth.json` to the shared OAuth pool — it
no longer writes `config.yaml`. So the model config is single-sourced in the
image and can't silently revert if the overlay is dropped.

> Earlier this was split: `bootstrap.sh` baked Anthropic-primary and the `99z`
> overlay flipped it to Codex-primary at boot, relying on s6 lexicographic order
> (`99-…` before `99z-…`). That silent-revert hazard is gone now that the image
> itself is Codex-primary. **A rebuild + redeploy is required for the change to
> take effect** (`node scripts/deploy-staging-hermes-vm.js build-image`).

**Why a guest turn can dead-end.** A staging run hit a non-retryable Anthropic `400`:

> "Third-party apps now draw from your extra usage, not your plan limits."

That is an Anthropic **Claude-Max-via-OAuth quota** signal (the shared `auth.json` token's extra-usage allowance is exhausted), delivered as a `400`. Two ways it dead-ends:

1. **Codex (primary) also failing/exhausted** → Hermes falls through to Anthropic (fallback) → Anthropic `400` → no third provider → the guest turn ends with no reply.
2. **Overlay not yet deployed** → Luna runs the baked Anthropic-primary config; on a `400`, failover to the Codex fallback may not trigger (Hermes treats most `4xx` as non-retryable, non-failover client errors), so it dead-ends before reaching Codex.

**Keep guest turns alive:**

- Confirm the overlay is active: `docker compose -f docker-compose.vm.yml config | grep 99z` and, in the container, `cat $HERMES_HOME/config.yaml` should show `default: gpt-5.5`. If it shows `claude-sonnet`, the overlay didn't apply — recreate the container.
- Keep **both** OAuth credentials fresh in the shared `auth.json` (`hermes auth add openai-codex`, `hermes auth add anthropic --type oauth`). The failover only helps if the fallback provider is authed.
- Watch Anthropic OAuth usage at <https://claude.ai/settings/usage>. The extra-usage `400` is a billing/quota state, not a code bug — top up or wait for the window to reset.
- Reconciliation TODO (operator decision): fold the overlay into the image so `bootstrap.sh` itself writes Codex-primary, removing the silent-revert hazard if the overlay volume is dropped. Left as a deploy-config decision because it changes the baked image.

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

- **Git sync (laptop + Lunabox):** `docs/GITHUB-REPO-SETUP.md`
- ACA legacy: `docs/HERMES-AZURE-CONTAINER-APPS.md`
- Luna behavior: `docs/LUNA-GUEST-BEHAVIOR-SPEC.md`

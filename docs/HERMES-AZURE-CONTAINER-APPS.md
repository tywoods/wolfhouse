# Hermes Agent on Azure Container Apps (staging)

Hermes replaces n8n/Luna as the **guest-facing WhatsApp layer**. Staff API, Postgres, and the staff portal stay as the booking brain.

```
Meta WhatsApp Cloud  →  Hermes (wh-staging-hermes)
                         →  Azure OpenAI
                         →  Staff API (wh-staging-staff-api)
```

No Linux VM — Hermes runs as a **Container App** beside `wh-staging-staff-api` in `wh-staging-rg`.

## Prerequisites

- Azure CLI logged in (`az login`)
- Resource group `wh-staging-rg` with Container Apps environment `wh-staging-env` (already present)
- Meta WhatsApp Cloud app (for production webhook cutover later)

## Quick start

```bash
node scripts/deploy-staging-hermes.js status
node scripts/deploy-staging-hermes.js prepare-storage
node scripts/deploy-staging-hermes.js deploy
node scripts/deploy-staging-hermes.js verify
```

Or via npm:

```bash
npm run deploy:hermes-staging -- prepare-storage
npm run deploy:hermes-staging -- deploy
npm run deploy:hermes-staging -- verify
```

## What the deploy script creates

| Resource | Name | Purpose |
|----------|------|---------|
| Storage account | `whstaginghermes` | Azure Files backing |
| File share | `hermes-data` | Persist `/opt/data` (Hermes config, sessions) |
| Env storage mount | `hermes-data` | Links share to `wh-staging-env` |
| Container App | `wh-staging-hermes` | Official image `nousresearch/hermes-agent:latest` |

Container settings:

- **Command:** `gateway run` (two args — not `gateway-run`)
- **Ingress:** external HTTPS, target port **8642** (gateway API + health)
- **Data:** ephemeral `/opt/data` by default (SQLite-safe). Azure Files SMB breaks Hermes WAL — use `--persist-data` only after NFS share is available.
- **Dashboard:** disabled in staging profile (`HERMES_DASHBOARD=0`) to avoid extra SQLite writers on ACA

## Persistence note (important)

Hermes stores `state.db` with SQLite WAL. **Do not mount Azure Files SMB at `/opt/data`** — the gateway crashes with `database is locked`. The `prepare-storage` step still creates a share for a future NFS cutover or config export. Pass API keys via Container App secret refs until persistence is solved.

## One-time Hermes setup (after deploy)

Config lives on the mounted volume. Run the setup wizard inside the running container:

```bash
az containerapp exec -g wh-staging-rg -n wh-staging-hermes --command "hermes setup"
```

WhatsApp Cloud (staging test number):

```bash
az containerapp exec -g wh-staging-rg -n wh-staging-hermes --command "hermes whatsapp-cloud"
```

Verify gateway health:

```bash
node scripts/deploy-staging-hermes.js verify
```

Expected: HTTP 200 on `https://<fqdn>/health`.

Meta webhook URL (after WhatsApp Cloud is configured):

```
https://<wh-staging-hermes-fqdn>/whatsapp/cloud/webhook
```

**Do not** point production Meta webhook here until staging smoke passes.

## Secrets (Key Vault → Container App)

Add via portal or CLI as **secret refs** (not plain env vars in git):

| Secret | Used for |
|--------|----------|
| `API_SERVER_KEY` | Gateway API auth |
| `AZURE_OPENAI_API_KEY` or managed identity | Model calls |
| `WHATSAPP_CLOUD_*` | Meta tokens (if not only in `/opt/data`) |
| `LUNA_BOT_INTERNAL_TOKEN` | Staff API tool calls (later) |

Staging profile non-secrets live in `scripts/lib/hermes-staging-profile.js`.

## Custom domain (optional)

After FQDN works:

1. Add CNAME `hermes-staging.lunafrontdesk.com` → ACA FQDN
2. Bind certificate in Container App → Custom domains
3. Update Meta webhook to custom domain URL

## Staff API integration (next phase)

Hermes tools will call:

- Base: `https://staff-staging.lunafrontdesk.com`
- Open-demo / bot endpoints (same contract Luna used)

Wire after gateway + WhatsApp Cloud staging path is green.

## Troubleshooting

| Symptom | Check |
|---------|--------|
| App not Running | `az containerapp logs show -g wh-staging-rg -n wh-staging-hermes --tail 80` |
| `/health` not 200 | Wrong args — must be `gateway run`; port 8642 |
| Config lost on restart | Volume mount missing — re-run `deploy` (patches YAML volume) |
| WhatsApp no inbound | Meta webhook URL + verify token; `hermes whatsapp-cloud` config on `/opt/data` |

## Cost note

Container App (1 vCPU, 2 GiB, min 1 replica) + small storage account ≈ low fixed monthly vs a dedicated VM. Scale `max-replicas` when load grows.

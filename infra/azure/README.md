# Azure deployment — Wolfhouse + n8n

This folder documents production hosting on Microsoft Azure. Implementation is infrastructure-as-code ready; provision via Azure Portal or Bicep/Terraform in a follow-up step.

## Recommended Azure resources

| Resource | Purpose |
|----------|---------|
| **Azure Container Apps Environment** | Host n8n main + worker containers (queue mode) |
| **Azure Cache for Redis** | n8n Bull queue |
| **Azure Database for PostgreSQL Flexible Server** (instance 1) | n8n internal DB |
| **Azure Database for PostgreSQL Flexible Server** (instance 2) *or* second database on same server | Wolfhouse app DB `wolfhouse` |
| **Azure Key Vault** | Secrets (Stripe, WhatsApp, DB passwords, `N8N_ENCRYPTION_KEY`) |
| **Azure Container Registry** | Optional custom n8n image |
| **Application Insights** | Logs + alerts |
| **Static Web App or existing site** | Stripe redirect URLs only if needed |

### Why Container Apps (not App Service alone)

- Native scale rules for **n8n workers** independent of main UI container
- Built-in ingress + custom domain for webhooks (`booking-assistant`, `stripe-webhook`)
- Fits queue mode pattern from [n8n queue docs](https://docs.n8n.io/hosting/scaling/queue-mode/)

Alternative: **Azure Kubernetes Service** if you already operate k8s — higher ops burden for Ale/Cami’s team.

## Architecture

```
Internet
   ├── Meta WhatsApp → Container App (n8n) /webhook/booking-assistant
   ├── Stripe → Container App /webhook/stripe-webhook
   └── Staff Apps Script → Container App /webhook/wolfhouse-manual-entries-queue

Container Apps
   ├── n8n (main) — UI + webhook ingress
   └── n8n-worker (replicas: 2+)

Azure Cache for Redis  ←→  queue
PostgreSQL (n8n)     ←→  executions
PostgreSQL (wolfhouse) ←→  Postgres nodes / future API
```

## Secrets (Key Vault → Container Apps secrets)

| Secret name | Used by |
|-------------|---------|
| `n8n-encryption-key` | n8n main + worker (must never change after credentials stored) |
| `n8n-db-url` | n8n Postgres connection |
| `wolfhouse-db-url` | App Postgres connection |
| `redis-url` | Queue |
| `stripe-secret-key` | Payment session workflow |
| `stripe-webhook-secret` | Webhook verification |
| `whatsapp-token` | Graph API |
| `anthropic-api-key` | LLM nodes |
| `airtable-token` | Dual-write phase only |
| `webhook-shared-secret` | Custom header validation |

## Deployment steps (summary)

1. Create resource group `rg-wolfhouse-prod` in **West Europe** (close to Somo / Spain).
2. Deploy PostgreSQL flexible servers with:
   - Private networking / firewall allowlist
   - Separate databases: `n8n`, `wolfhouse`
   - TLS required
3. Deploy Azure Cache for Redis (Standard tier minimum for production).
4. Store secrets in Key Vault; grant Container Apps managed identity access.
5. Create Container Apps Environment + Log Analytics workspace.
6. Deploy **n8n** container with env vars from `docs/azure-n8n-hosting-plan.md`.
7. Deploy **n8n-worker** with `command: worker`, scale 2–5 replicas based on queue depth.
8. Run DB migration: `psql $WOLFHOUSE_DATABASE_URL -f database/migrations/001_init.sql`
9. Run seed: `psql … -f database/seeds/001_wolfhouse_seed.sql`
10. Import workflows from `n8n/*.json`; update webhook base URL env.
11. Configure custom domain + HTTPS (required for WhatsApp/Stripe).
12. Smoke test per `docs/regression-test-plan.md`.

## Local dev alignment

Use `infra/docker-compose.local.yml` — same env var names as Azure, different hosts.

## Cost control (starter)

- Postgres: Burstable B1ms for staging; scale before season peak
- Container Apps: min replicas 1 main + 1 worker; scale max on queue depth
- Redis: C0 staging, C1+ production

## Handoff for non-technical owners

They should **not** access Azure. Provide:

- Single “support” contact when `automation_errors` alerts fire
- Printed runbook: Manual Entries sync button, when to call you

See full checklist: `docs/azure-n8n-hosting-plan.md`

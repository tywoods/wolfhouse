# Stage 7.3b — Azure Staging Resource Scaffold

**Status:** SCAFFOLD CREATED (2026-05-31) — local IaC files only. **No Azure resources created. No DNS changed. No secrets set. Not deployed.**
**Parent plan:** [`PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md`](PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md) — Workstream C (TLS/deployment).
**Design basis:** [`PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md`](PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md)
**IaC location:** `infra/azure/staging/`
**Runbook:** `infra/azure/staging/README.md`

> **Deployment blocked.** No resource deployment is permitted until all relevant go/no-go gates in [`PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md`](PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md) — specifically sections A (env/secrets), B (auth), and C (staging/TLS) — are recorded PASS. Live operation, real WhatsApp, and live Stripe are separately gated (sections H/I/J).

---

## 1. Resource inventory

All resources in a single resource group (`wh-staging-rg`). Environment-prefixed names prevent collision with future production (`wh-prod-rg`).

| Resource | Azure type | Name pattern | Purpose |
|---|---|---|---|
| Resource group | `Microsoft.Resources/resourceGroups` | `wh-staging-rg` | Staging isolation boundary — delete to teardown all staging resources |
| Log Analytics workspace | `Microsoft.OperationalInsights/workspaces` | `wh-staging-logs` | Centralised logs for all apps + Container Apps environment; retention 30 days |
| Application Insights | `Microsoft.Insights/components` | `wh-staging-appinsights` | Performance + error telemetry wired to Log Analytics |
| User-assigned managed identity | `Microsoft.ManagedIdentity/userAssignedIdentities` | `wh-staging-identity` | Used by all Container Apps to pull secrets from Key Vault; no credential stored in config |
| Key Vault | `Microsoft.KeyVault/vaults` | `wh-staging-kv` | Single source of truth for all secrets; soft-delete enabled; managed identity granted `Key Vault Secrets User` |
| Container Apps environment | `Microsoft.App/managedEnvironments` | `wh-staging-env` | Shared Container Apps environment; linked to Log Analytics |
| Container App — staff API | `Microsoft.App/containerApps` | `wh-staging-staff-api` | Staff query API + UI; HTTPS ingress; `scripts/staff-query-api.js` |
| Container App — n8n main | `Microsoft.App/containerApps` | `wh-staging-n8n-main` | n8n editor/webhook receiver; HTTPS ingress; queue-mode main |
| Container App — n8n worker | `Microsoft.App/containerApps` | `wh-staging-n8n-worker` | n8n queue worker; **no public ingress**; shares DB + Redis |
| Postgres Flexible Server — app | `Microsoft.DBforPostgreSQL/flexibleServers` | `wh-staging-pg-app` | Wolfhouse app DB (`wolfhouse_staging`); private access; SSL required |
| Postgres Flexible Server — n8n | `Microsoft.DBforPostgreSQL/flexibleServers` | `wh-staging-pg-n8n` | n8n system DB (`n8n_staging`); private access; SSL required |
| Azure Cache for Redis | `Microsoft.Cache/redis` | `wh-staging-redis` | n8n queue mode; TLS port 6380; `noeviction` policy |
| Container Registry | `Microsoft.ContainerRegistry/registries` | `whstagingacr` | Stores staff API + custom n8n images; Basic SKU for staging |

### What is NOT created by this scaffold

- Production resource group, Postgres, Key Vault (separate `wh-prod-*` stack, built only after staging soak)
- Azure Front Door / CDN (not needed for a 2–3 person pilot)
- VNet / private endpoint (acceptable for staging to keep cost low; **required for production**)
- Monitoring alert rules (defined in design; wired separately after first deploy — Stage 7.5)

---

## 2. Environment separation rules

| Rule | Enforcement |
|---|---|
| Staging never uses prod data | Separate Postgres servers, no shared connection strings |
| Staging never uses prod secrets | Separate Key Vault (`wh-staging-kv` vs `wh-prod-kv`) |
| Staging uses `sk_test_*` Stripe keys only | `STRIPE_SECRET_KEY` placeholder in Key Vault references `sk_test_*`-format secret |
| `WHATSAPP_DRY_RUN=true` in staging | Hardcoded in Container App env; cannot be overridden at runtime without a new revision |
| `STAFF_ACTIONS_ENABLED=false` at first deploy | Default false; must be explicitly set true with a new revision + approval |
| `STAFF_AUTH_REQUIRED=true` in staging | Session auth enforced; operator token not valid |
| All n8n workflows inactive on first deploy | Workflows imported from repo are inactive; no activation without Stage 7.6 gate pass |
| `STRIPE_WEBHOOK_SKIP_VERIFY=false` | Enforced in Container App env |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` | Prevents code nodes from reading environment variables at runtime |

---

## 3. Networking assumptions (staging)

For staging cost and simplicity, public Container Apps FQDNs are used (Azure-managed `*.azurecontainerapps.io` domains) with optional custom domain + managed cert. No VNet injection for staging.

- Staff API: public HTTPS FQDN; restricted in production by IP allowlist (if needed)
- n8n main: public HTTPS FQDN (needed for webhook ingress from WhatsApp/Stripe during test)
- n8n worker: **internal only** — no ingress, talks only to Redis + Postgres
- Postgres: public access disabled; connection from Container Apps env via service connector or firewall allow-listing Container Apps outbound IPs
- Redis: TLS 6380; access key injected via Key Vault reference

---

## 4. Key Vault secret references (staging)

All secrets stored as Key Vault secrets; Container Apps reference them via the managed identity. **No secret values appear in IaC files.**

| Secret name (in KV) | Used by | Description |
|---|---|---|
| `wolfhouse-database-url` | staff-api | Full Postgres URL for `wolfhouse_staging` DB |
| `n8n-database-url` | n8n-main, n8n-worker | Postgres URL for `n8n_staging` DB |
| `n8n-encryption-key` | n8n-main, n8n-worker | n8n credential encryption key (≥ 32 chars, unique per env) |
| `redis-connection-string` | n8n-main, n8n-worker | `rediss://:password@hostname:6380` |
| `stripe-secret-key` | staff-api | `sk_test_*` only in staging |
| `stripe-webhook-secret` | staff-api / n8n | Webhook signing secret (test) |
| `meta-whatsapp-token` | n8n-main | WhatsApp token (dry-run only; `WHATSAPP_DRY_RUN=true`) |
| `meta-whatsapp-phone-id` | n8n-main | Phone number ID |
| `staff-session-secret` | staff-api | Reserved for future CSRF secret (if added in 7.2d) |
| `wolfhouse-airtable-token` | n8n-main | Airtable PAT (read-only during transition) |

---

## 5. IaC files

| File | Purpose |
|---|---|
| `infra/azure/staging/main.bicep` | Bicep template defining all staging resources |
| `infra/azure/staging/parameters.example.json` | Example parameter values (no real secrets, no real IDs) |
| `infra/azure/staging/README.md` | Deployment runbook: prerequisites, dry-run, deploy, verify, rollback |

---

## 6. Deployment gates (must all pass before `az deployment` runs)

From [`PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md`](PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md):

| Gate | Section | Status |
|---|---|---|
| Azure subscription selected + billing confirmed | A1 | NOT_STARTED |
| Key Vault provisioned + secrets set | A3, A4 | NOT_STARTED |
| Staging Postgres provisioned + migration 001–009 applied | C3 | NOT_STARTED |
| All workflows inactive at first deploy | C7 | NOT_STARTED |
| HTTPS confirmed before auth cookie enabled | C2 | NOT_STARTED |
| Backup configured before first real data | D1 | NOT_STARTED |
| Auth migration 009 applied to staging DB | B1 | NOT_STARTED |
| Staff accounts created (Cami, Ale) | B4 | NOT_STARTED |

**Current status: ALL NOT_STARTED — deployment blocked.**

---

## 7. Implementation log

### 7.3b — IaC scaffold created (2026-05-31)

- `infra/azure/staging/main.bicep` — Bicep template: all resources, KV references, safety defaults
- `infra/azure/staging/parameters.example.json` — placeholder parameter file
- `infra/azure/staging/README.md` — deployment runbook with DO NOT RUN warnings
- `scripts/verify-azure-staging-scaffold.js` — static verifier (no Azure API calls)
- **NOT done:** Azure resources not created; DNS not configured; TLS not active; secrets not set; staging not deployed

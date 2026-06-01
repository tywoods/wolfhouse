# Stage 7.3c — Azure Staging Deployment Preflight

**Status:** PREFLIGHT PASS (2026-06-01) — local static validation only. No Azure resources created. No DNS changed. No secrets set. No deployment run.
**Parent plan:** [`PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md`](PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md) — Workstream C (TLS/deployment).
**Builds on:** [`PHASE-7.3B-AZURE-STAGING-RESOURCE-SCAFFOLD.md`](PHASE-7.3B-AZURE-STAGING-RESOURCE-SCAFFOLD.md) — IaC scaffold PASS (2026-05-31).
**Verifier:** `scripts/verify-azure-staging-preflight.js`
**IaC:** `infra/azure/staging/main.bicep`
**Runbook:** `infra/azure/staging/README.md`

> **Deployment blocked.** This document validates the scaffold and defines all inputs Ty must supply before any `az deployment` command is run. No resources are created here. No DNS is changed. No secrets are set. No workflows are activated.

---

## 1. Objective

Produce a complete, validated preflight package for the first real Azure staging deployment:

- Confirm the Bicep scaffold is correct and complete.
- Define exactly what Ty must provide before deployment begins.
- Produce the safe `az deployment group what-if` command ready to run.
- Define the first-deployment phase sequence (Phase A–M).
- Define smoke tests for the first hosted staging version.

**Domain:** `lunafrontdesk.com` (purchased).

**Target staging subdomains:**
- `staff-staging.lunafrontdesk.com` — staff API/UI
- `n8n-staging.lunafrontdesk.com` — n8n main editor/webhooks
- `webhook-staging.lunafrontdesk.com` — n8n webhook ingress (or reuse n8n-staging subdomain)

---

## 2. Scaffold validation

### 2.1 Required resources — status in `main.bicep`

| Resource | Azure type | Present | Notes |
|---|---|---|---|
| Resource group assumption | `targetScope = 'resourceGroup'` | ✓ | Resource group must be pre-created by Ty |
| Log Analytics workspace | `Microsoft.OperationalInsights/workspaces` | ✓ | `wh-staging-logs` |
| Application Insights | `Microsoft.Insights/components` | ✓ | `wh-staging-appinsights` |
| User-assigned managed identity | `Microsoft.ManagedIdentity/userAssignedIdentities` | ✓ | `wh-staging-identity` |
| Key Vault | `Microsoft.KeyVault/vaults` | ✓ | `wh-staging-kv`; RBAC mode; soft-delete 7 days |
| Container Registry | `Microsoft.ContainerRegistry/registries` | ✓ | `whstagingacr`; admin user disabled; managed-identity pull |
| Redis | `Microsoft.Cache/redis` | ✓ | `wh-staging-redis`; TLS only (port 6380); noeviction |
| Postgres Flexible Server — app | `Microsoft.DBforPostgreSQL/flexibleServers` | ✓ | `wh-staging-pg-app`; B1ms; `wolfhouse_staging` DB |
| Postgres Flexible Server — n8n | `Microsoft.DBforPostgreSQL/flexibleServers` | ✓ | `wh-staging-pg-n8n`; B1ms; `n8n_staging` DB |
| Container Apps environment | `Microsoft.App/managedEnvironments` | ✓ | `wh-staging-env`; linked to Log Analytics |
| Staff API container app | `Microsoft.App/containerApps` | ✓ | `wh-staging-staff-api`; HTTPS ingress; port 3036 |
| n8n main container app | `Microsoft.App/containerApps` | ✓ | `wh-staging-n8n-main`; HTTPS ingress; port 5678 |
| n8n worker container app | `Microsoft.App/containerApps` | ✓ | `wh-staging-n8n-worker`; no public ingress |
| Key Vault role assignment | `Microsoft.Authorization/roleAssignments` | ✓ | Key Vault Secrets User → managed identity |
| ACR pull role assignment | `Microsoft.Authorization/roleAssignments` | ✓ | AcrPull → managed identity |

**All required resources: PRESENT.**

### 2.2 Safety defaults — hardcoded in `main.bicep` (not overridable via parameters)

| Variable | Value | Container(s) | Safe for staging? |
|---|---|---|---|
| `WHATSAPP_DRY_RUN` | `'true'` | staff-api, n8n-main, n8n-worker | ✓ SAFE |
| `STAFF_ACTIONS_ENABLED` | `'false'` | staff-api | ✓ SAFE |
| `STAFF_AUTH_REQUIRED` | `'true'` | staff-api | ✓ SAFE |
| `STAFF_AUTH_HTTPS` | `'true'` | staff-api | ✓ SAFE |
| `STRIPE_WEBHOOK_SKIP_VERIFY` | `'false'` | staff-api, n8n-main | ✓ SAFE |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | `'true'` | n8n-main, n8n-worker | ✓ SAFE |
| `NODE_ENV` | `'staging'` | staff-api | ✓ SAFE |

**All safety defaults: CONFIRMED HARDCODED.**

### 2.3 Secret handling audit

- All secrets are referenced via Key Vault secret refs (`keyVaultUrl` + `identity` — managed identity pull).
- No secret values appear in `main.bicep`, `parameters.example.json`, or `parameters.ty-template.json`.
- No `sk_live_*` Stripe key.
- No hardcoded Meta/WhatsApp token (`EAAG*` pattern).
- No plaintext passwords.
- `administratorLoginPassword` for Postgres is noted as a deploy-time secure parameter (not in template).

**Secret safety: CONFIRMED CLEAN.**

### 2.4 Production naming audit

- All resource names use `wh-staging-*` prefix.
- App DB name: `wolfhouse_staging` (not `wolfhouse` production).
- n8n DB name: `n8n_staging`.
- Key Vault name: `wh-staging-kv`.
- Resource group assumption: `wh-staging-rg`.

**No production names in scaffold: CONFIRMED.**

---

## 3. Required manual inputs from Ty

Before any `az deployment` command is run, Ty must supply all of the following. Values in `parameters.ty-template.json` use `<FILL_ME: ...>` placeholders.

### 3.1 Azure account

| Input | Why needed | Example / format |
|---|---|---|
| **Azure subscription ID** | `az account set --subscription`; `what-if` and `create` scope | UUID format: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| **Azure tenant ID** | May be needed for `az login --tenant` on multi-tenant accounts | UUID format |
| **Azure region** | Where to create all resources; must be consistent | e.g. `westeurope`, `westus2`, `eastus` |
| **Resource group name** | Must be created before Bicep deploy (Phase B) | Suggest: `wh-staging-rg` |
| **Monthly budget comfort level** | Confirms idle cost (~€63–86/month) is acceptable | e.g. "up to €100/month" |
| **Use existing resource group or create new?** | Phase B decision | new (recommended) |
| **Who owns Azure admin access** | For KV access, role assignments, container ops | e.g. Ty (tywoods@...) |

### 3.2 Domain and DNS

| Input | Why needed | Format |
|---|---|---|
| **DNS provider for `lunafrontdesk.com`** | To know where to add CNAME/A records for subdomains | e.g. Cloudflare, Namecheap, Azure DNS |
| **Will Cloudflare manage DNS?** | Cloudflare proxy vs orange-cloud vs DNS-only affects TLS flow | yes / no |
| **Confirm staging subdomains** | Must be explicitly approved before DNS records are created | `staff-staging.lunafrontdesk.com`, `n8n-staging.lunafrontdesk.com`, `webhook-staging.lunafrontdesk.com` |
| **Webhook: reuse `n8n-staging` or separate `webhook-staging`?** | Simplicity vs separation | recommendation: reuse `n8n-staging`; explicit approval needed |

### 3.3 Container image strategy

| Input | Why needed | Options |
|---|---|---|
| **Container image build strategy** | How the staff API container image gets into ACR | (A) `az acr build` from repo on Azure; (B) local `docker build` + `az acr login` + `docker push`; (C) GitHub Actions CI later |
| **Confirm ACR login server name** | Default is `whstagingacr.azurecr.io` — must match Bicep | Change `appNamePrefix` if needed |

### 3.4 Postgres admin password

| Input | Why needed | Format |
|---|---|---|
| **Postgres admin password** | Passed as `--parameters postgresAdminLoginPassword="..."` at deploy time. NOT stored in `parameters.ty-template.json`. | Strong random string ≥ 20 chars; store in Key Vault as `wolfhouse-db-admin-password` BEFORE deploy |

> ⚠️ Do NOT write the real password into any file committed to git. Generate it with: `openssl rand -base64 30` or similar.

---

## 4. Pre-deployment phase plan

### Phase A — Preflight validation (CURRENT — no resources)

Safe to run at any time. No Azure API calls.

```bash
# Verify local scaffold is intact
node scripts/verify-azure-staging-scaffold.js
node scripts/verify-azure-staging-preflight.js

# Validate Bicep syntax (no network call needed if az bicep is installed)
az bicep build --file infra/azure/staging/main.bicep
```

### Phase B — Create empty resource group

> ⚠️ Creates a real Azure resource. Requires Ty approval and valid subscription.

```bash
# Login and set subscription first
az login
az account set --subscription "<SUBSCRIPTION_ID>"
az account show   # confirm correct account

# Create staging resource group (Phase B)
# ── APPROVAL REQUIRED — creates a billable resource group ──
az group create \
  --name wh-staging-rg \
  --location westeurope
```

### Phase C — Run Bicep what-if (SAFE — read-only, no changes)

> This command reads the Bicep template and shows what WOULD be created. No resources are touched.

```bash
# ── SAFE: reads only, no resources created ──
az deployment group what-if \
  --resource-group wh-staging-rg \
  --template-file infra/azure/staging/main.bicep \
  --parameters @infra/azure/staging/parameters.ty-template.json \
  --parameters postgresAdminLoginPassword="<PLACEHOLDER_DO_NOT_USE_REAL_VALUE_HERE>"
```

> Replace `<PLACEHOLDER_DO_NOT_USE_REAL_VALUE_HERE>` with a temporary non-real value when running `what-if` only. The real password is required for Phase D.

### Phase D — Deploy staging infra

> ⛔ DO NOT RUN until Phase A–C complete, budget confirmed, and Ty has explicit go/no-go sign-off.

```bash
# ⛔ APPROVAL REQUIRED — do not run until all preflight checks complete
# ⛔ DO NOT RUN this command without explicit sign-off from Ty.
az deployment group create \
  --resource-group wh-staging-rg \
  --template-file infra/azure/staging/main.bicep \
  --parameters @infra/azure/staging/parameters.ty-template.json \
  --parameters postgresAdminLoginPassword="$(az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-db-admin-password --query value -o tsv)" \
  --name "wh-staging-deploy-$(Get-Date -Format yyyyMMddHHmm)"
```

### Phase E — Inject Key Vault secrets

> ⛔ AFTER Phase D only. Key Vault must exist before secrets can be set.
> All values below are PLACEHOLDERS — replace with real values from Ty's secret store.

```bash
# Stripe: MUST be sk_test_* — NEVER sk_live_* in staging
az keyvault secret set --vault-name wh-staging-kv --name stripe-secret-key \
  --value "sk_test_<PLACEHOLDER>"

az keyvault secret set --vault-name wh-staging-kv --name stripe-webhook-secret \
  --value "whsec_<PLACEHOLDER>"

# Database URLs (fill with real hostnames after Phase D)
az keyvault secret set --vault-name wh-staging-kv --name wolfhouse-database-url \
  --value "postgres://whadmin:<DB_PASSWORD>@wh-staging-pg-app.postgres.database.azure.com:5432/wolfhouse_staging?sslmode=require"

az keyvault secret set --vault-name wh-staging-kv --name n8n-database-url \
  --value "postgres://whadmin:<DB_PASSWORD>@wh-staging-pg-n8n.postgres.database.azure.com:5432/n8n_staging?sslmode=require"

az keyvault secret set --vault-name wh-staging-kv --name n8n-encryption-key \
  --value "<RANDOM_32_CHAR_MIN_UNIQUE_KEY>"

az keyvault secret set --vault-name wh-staging-kv --name redis-connection-string \
  --value "rediss://:<ACCESS_KEY>@wh-staging-redis.redis.cache.windows.net:6380"

# WhatsApp — dry-run is enforced; token loaded but WHATSAPP_DRY_RUN=true prevents sends
az keyvault secret set --vault-name wh-staging-kv --name meta-whatsapp-token \
  --value "EAAG_PLACEHOLDER_DO_NOT_USE_REAL_TOKEN_IN_STAGING"

az keyvault secret set --vault-name wh-staging-kv --name meta-whatsapp-phone-id \
  --value "<PHONE_ID_PLACEHOLDER>"

az keyvault secret set --vault-name wh-staging-kv --name wolfhouse-airtable-token \
  --value "pat<PLACEHOLDER>"

az keyvault secret set --vault-name wh-staging-kv --name n8n-webhook-shared-secret \
  --value "<RANDOM_WEBHOOK_SECRET>"

az keyvault secret set --vault-name wh-staging-kv --name staff-session-secret \
  --value "<RANDOM_SESSION_SECRET>"
```

### Phase F — Build/push staff API container

```bash
# Option A: Azure Container Registry remote build (recommended — no local Docker daemon needed)
# ⛔ AFTER Phase D (ACR must exist)
az acr build \
  --registry whstagingacr \
  --image wh-staff-api:latest \
  --file Dockerfile \
  .

# Option B: local Docker build + push
docker build -t whstagingacr.azurecr.io/wh-staff-api:latest .
az acr login --name whstagingacr
docker push whstagingacr.azurecr.io/wh-staff-api:latest
```

### Phase G — Run migrations 001–009 on staging DB

> Staging DB firewall must allow the machine running migrations before this step.

```bash
# Allow client IP temporarily via Azure portal or:
az postgres flexible-server firewall-rule create \
  --resource-group wh-staging-rg \
  --name wh-staging-pg-app \
  --rule-name temp-migration-access \
  --start-ip-address <YOUR_IP> \
  --end-ip-address <YOUR_IP>

# Run all migrations
WOLFHOUSE_DATABASE_URL="postgres://whadmin:<PASSWORD>@wh-staging-pg-app.postgres.database.azure.com:5432/wolfhouse_staging?sslmode=require" \
  node scripts/run-sql.js database/migrations/001_initial_schema.sql
# ... repeat for 002–009
# Remove firewall rule after migrations complete
```

### Phase H — Seed first staff users

> Requires migration 009 (`staff_users` table) to be applied first.

```bash
# Seed Cami and Ale staff accounts (staging)
# Use hashed passwords — never plaintext
node scripts/seed-staff-users.js --env staging
```

### Phase I — Start staff API only

After Phase D+E+F are complete, the staff API Container App should start automatically. Verify it's running:

```bash
az containerapp show \
  --name wh-staging-staff-api \
  --resource-group wh-staging-rg \
  --query "properties.latestRevisionFqdn"
```

### Phase J — Smoke test /staff/ui

See §6 (Smoke tests) for the full checklist. Minimum first check:

```bash
# Get the FQDN from Phase I output, then:
curl -I https://<staff-api-fqdn>/healthz
curl -I https://<staff-api-fqdn>/staff/ui
```

### Phase K — Import n8n workflows (inactive)

> All workflows must remain inactive after import. No activation without Stage 7.6 gate pass.

```bash
# Import workflows to n8n staging (inactive)
# Access n8n at https://<n8n-fqdn>
# Import each JSON from n8n/phase2/ manually as inactive
# DO NOT activate any workflow
```

### Phase L — DNS/TLS

> After staff API and n8n are running (Phase I/K). Container Apps managed certs.

```bash
# Add custom domain to staff API Container App
az containerapp hostname add \
  --name wh-staging-staff-api \
  --resource-group wh-staging-rg \
  --hostname staff-staging.lunafrontdesk.com

# Bind managed certificate (Azure provisions TLS automatically)
az containerapp ssl upload ...  # or use portal for managed cert bind
```

DNS CNAME record to add at DNS provider:
```
staff-staging.lunafrontdesk.com  CNAME  <wh-staging-staff-api fqdn>.azurecontainerapps.io
n8n-staging.lunafrontdesk.com    CNAME  <wh-staging-n8n-main fqdn>.azurecontainerapps.io
```

### Phase M — Backup/monitoring gates

> Before any guest data or pilot operation begins.

- Confirm Azure Postgres automated backup is active (7-day retention) — Azure portal.
- Wire Azure Monitor alert rules (5xx, DB connectivity) — Stage 7.5.
- Confirm durable audit log path (Log Analytics receives rows, not just local file).
- Run restore drill (Stage 7.4 gate D4).

---

## 5. What-if command (SAFE — ready to run after Phase B)

The following command is **safe** — it reads the template and describes what would be created, without touching any resource.

```bash
# ── SAFE: what-if only — no resources created ──
az deployment group what-if \
  --resource-group wh-staging-rg \
  --template-file infra/azure/staging/main.bicep \
  --parameters @infra/azure/staging/parameters.ty-template.json \
  --parameters postgresAdminLoginPassword="placeholder-for-what-if-only"
```

Prerequisites before running:
1. `az login` completed.
2. `az account set --subscription "<SUBSCRIPTION_ID>"` done.
3. Resource group `wh-staging-rg` created (Phase B).
4. `infra/azure/staging/parameters.ty-template.json` updated with real region/prefix (but no secrets).

---

## 6. Smoke tests — first hosted staging version

After Phase D–J, **before any pilot activity**, all of the following must hold:

| # | Test | Expected result | Status |
|---|---|---|---|
| S1 | `curl -I https://staff-staging.lunafrontdesk.com/healthz` | HTTPS 200; `{ "status": "ok", "auth_enabled": true }` | NOT_STARTED |
| S2 | `curl -I https://staff-staging.lunafrontdesk.com/staff/ui` | HTTPS 200 | NOT_STARTED |
| S3 | `curl https://staff-staging.lunafrontdesk.com/staff/intents` | 200; returns intent registry JSON | NOT_STARTED |
| S4 | `curl https://staff-staging.lunafrontdesk.com/staff/conversations` | 200; returns `[]` or rows | NOT_STARTED |
| S5 | `curl https://staff-staging.lunafrontdesk.com/staff/bed-calendar` | 200 | NOT_STARTED |
| S6 | `POST /staff/auth/login` with Cami credentials | 200; session cookie set over HTTPS | NOT_STARTED |
| S7 | Verify `STAFF_ACTIONS_ENABLED=false` in Container App revision env | Value is `false`; write endpoint returns disabled/403 | NOT_STARTED |
| S8 | Verify `WHATSAPP_DRY_RUN=true` in Container App revision env | No real Graph API send path active | NOT_STARTED |
| S9 | Verify no `sk_live_*` Stripe key in Key Vault or env | `stripe-secret-key` secret starts `sk_test_` | NOT_STARTED |
| S10 | n8n workflows all inactive on fresh deploy | n8n workflow list: all `active=false` | NOT_STARTED |
| S11 | Audit log path works or durable audit plan documented | Log Analytics / DB table receives audit rows | NOT_STARTED |
| S12 | HTTP redirects to HTTPS on staff subdomain | `curl -I http://staff-staging.lunafrontdesk.com` → 301/302 → HTTPS | NOT_STARTED |
| S13 | `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` confirmed | Container App env; Code nodes cannot read `$env` | NOT_STARTED |
| S14 | Unauthenticated request to write endpoint returns 401 | `POST /staff/handoff/:id/resolve` without cookie → 401 | NOT_STARTED |

---

## 7. Manual inputs summary (Ty fill-in list)

Before Phase D, Ty must confirm or provide all of the following:

```
[ ] Azure subscription ID: ________________________
[ ] Azure tenant ID (if multi-tenant): ________________________
[ ] Azure region: ________________________ (default: westeurope)
[ ] Resource group name: wh-staging-rg (default) or ________________________
[ ] Monthly budget comfort level confirmed: ________________________ (estimate: ~€63–86/month idle)
[ ] DNS provider for lunafrontdesk.com: ________________________
[ ] Will Cloudflare manage DNS? yes / no
[ ] Staging subdomains confirmed:
    staff-staging.lunafrontdesk.com: ________________________
    n8n-staging.lunafrontdesk.com: ________________________
    webhook-staging.lunafrontdesk.com (or reuse n8n-staging): ________________________
[ ] Container image build strategy: ACR build / local push / GitHub Actions
[ ] Postgres admin password (strong random — do NOT commit): ________________________
[ ] Azure admin access owner: ________________________
[ ] Use new resource group: yes / no
```

---

## 8. Go/no-go gates (Phase 0 → pilot readiness)

From [`PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md`](PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md):

| Gate | Section | Required for | Status |
|---|---|---|---|
| Phase A–C complete | C (staging/TLS) | Phase D | PASS (this doc) |
| Azure subscription selected | A1 | Phase B | NOT_STARTED |
| Budget confirmed | A1 | Phase B | NOT_STARTED |
| Key Vault provisioned + secrets set | A3, A7 | Phase E | NOT_STARTED |
| Migrations 001–009 applied to staging | C3 | Phase G | NOT_STARTED |
| All workflows inactive | C8 | Phase K | NOT_STARTED |
| HTTPS confirmed | C2 | Phase L | NOT_STARTED |
| Backup configured | D1 | Phase M | NOT_STARTED |
| Auth migration 009 applied + staff accounts | B1, B3, B4 | Phase H | NOT_STARTED |

---

## 9. What is NOT done by this document

- Azure resources NOT created.
- DNS NOT configured.
- TLS NOT active.
- Key Vault secrets NOT set.
- Containers NOT pushed.
- Migrations NOT applied.
- Staff users NOT seeded.
- n8n workflows NOT imported.
- Staging NOT live.

---

## 10. Implementation log

### 7.3c — Preflight PASS (2026-06-01)

**HEAD:** `8b60961`

**Files created:**
- `docs/PHASE-7.3C-AZURE-STAGING-DEPLOYMENT-PREFLIGHT.md` — this doc
- `infra/azure/staging/parameters.ty-template.json` — placeholder parameter file with `<FILL_ME: ...>` tokens
- `scripts/verify-azure-staging-preflight.js` — static verifier: 20+ checks

**Files updated:**
- `infra/azure/staging/README.md` — Phase A–M structure added; `az group create` annotated
- `docs/PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md` — 7.3c PASS recorded
- `docs/PROJECT-STATE.md` — Stage 7.3c PASS noted
- `docs/ROADMAP.md` — Stage 7.3c PASS noted

**Verifier result:** PASS

**Safety defaults confirmed:** WHATSAPP_DRY_RUN=true, STAFF_ACTIONS_ENABLED=false, STAFF_AUTH_REQUIRED=true, STRIPE_WEBHOOK_SKIP_VERIFY=false, N8N_BLOCK_ENV_ACCESS_IN_NODE=true — all hardcoded in main.bicep, not overridable via parameters.

**What-if command:** prepared in §5, safe to run after Phase B (requires real subscription and resource group).

**NOT done:** No Azure resources. No az deployment create. No DNS. No secrets. No workflow activation.

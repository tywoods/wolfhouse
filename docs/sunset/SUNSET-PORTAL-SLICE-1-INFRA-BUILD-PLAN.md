# Sunset Portal Slice 1 — Isolated Staging Infra Build Plan

**Status:** PLAN ONLY — no provisioning, no deploy, no seed  
**Date:** 2026-06-19  
**Branch:** `feat/sunset-multitenant-luna`  
**Portal code SHA:** `25518554bcf635b59c594dae8f930c0190609209`  
**Parent:** `SUNSET-PORTAL-SLICE-1-STAGING-APPROVAL-PACKET.md` (v2.0 — Captain approved)  
**Merge:** Held until isolated Sunset staging smoke passes.  
**IaC:** Reviewable Bicep draft at [`infra/azure/sunset-staging/`](../../infra/azure/sunset-staging/) (`main.bicep`, `parameters.example.json`, `README.md`). Captain reviews Bicep before signing infra-creation checkbox.

---

## Captain ruling (locked)

- **Do NOT** deploy Sunset to `wh-staging-staff-api` or `staff-staging.lunafrontdesk.com`
- Wolfhouse staging is **read-only / hands-off** for Sunset work
- Sunset gets **dedicated** infra in `luna-sunset-staging-rg`
- Every real-environment step requires its own §11 checkbox in the approval packet
- **No `az` commands in this doc are executed** — proposed only

---

## 1. Target resources

| Resource | Proposed name | Notes |
|----------|---------------|-------|
| **Resource group** | `luna-sunset-staging-rg` | Sunset-only; never `wh-staging-rg` |
| **Region** | `westeurope` (primary) | Match Wolfhouse staging; fallback `northeurope` if capacity pressure (per existing Bicep guidance) |
| **Container Apps environment** | `luna-sunset-staging-env` | Dedicated; no shared env with Wolfhouse |
| **Container App (Staff API)** | `luna-sunset-staging-staff-api` | Captain-confirmed app name |
| **Portal URL** | `https://sunset-staging.lunafrontdesk.com` | Custom domain on Staff API ingress |
| **Health endpoint** | `GET https://sunset-staging.lunafrontdesk.com/healthz` | Expect `{ "status": "ok", ... }` |
| **Postgres Flexible Server** | `luna-sunset-staging-pg-app` | Dedicated Sunset DB server |
| **Database name** | `sunset_staging` | **Not** `wolfhouse_staging` |
| **Key Vault** | `luna-sunset-staging-kv` | Sunset secrets only |
| **Managed identity** | `luna-sunset-staging-identity` | KV + ACR pull for Container App |
| **Log Analytics** | `luna-sunset-staging-logs` | Optional App Insights sibling |
| **ACR** | See §1.1 | Image repository strategy |
| **Redis** | **Defer Slice 1** | Staff API portal demo does not require Redis for Slice 1 |
| **n8n** | **Not in scope** | Sunset isolated staging = Staff API + DB only |

### 1.1 ACR strategy — reuse vs dedicated

| Option | Registry | Image repo | Pros | Cons | Recommendation |
|--------|----------|------------|------|------|----------------|
| **A. Reuse existing ACR** | `whstagingacr.azurecr.io` | `luna-sunset-staff-api:<tag>` | Fastest path; no new ACR billing; proven build pipeline | Shared registry with Wolfhouse (weaker isolation at artifact layer) | **Acceptable for Slice 1** if Captain approves shared ACR with **separate image repo only** |
| **B. Dedicated ACR** | `lunasunsetstagingacr.azurecr.io` | `luna-sunset-staff-api:<tag>` | Full artifact isolation; aligns with dedicated RG | Extra ACR setup + cost; new RBAC wiring | **Preferred long-term** if budget allows |

**Image tag pattern (both options):**

```
luna-sunset-staff-api:25518554bcf635b59c594dae8f930c0190609209
# or short: luna-sunset-staff-api:2551855-sunset-slice1
```

**Anti-pattern (forbidden):** pushing Sunset image as `wh-staff-api:*` or updating Wolfhouse Staff API image tags.

### 1.2 DNS / TLS

| Record | Value |
|--------|-------|
| CNAME | `sunset-staging.lunafrontdesk.com` → Container App ingress FQDN |
| TLS | Azure managed certificate on `luna-sunset-staging-staff-api` custom domain |
| Verification | HTTP→HTTPS redirect; cert bound before portal smoke |

---

## 2. Proposed infrastructure commands (NOT EXECUTED)

All commands are **illustrative**. Replace `<SUBSCRIPTION_ID>`, `<REGION>`, `<DB_PASSWORD>`, and secrets before any real run. **Abort** if any command targets `wh-staging-rg`, `wh-staging-staff-api`, or `staff-staging.lunafrontdesk.com`.

### Phase 0 — Preflight (code only, no Azure)

```bash
cd /opt/luna/Luna-Sunset
git checkout 25518554bcf635b59c594dae8f930c0190609209
npm run verify:sunset-all
node scripts/fixtures/sunset-portal-slice1-seed.js   # dry-run
```

### Phase 1 — Resource group (checkbox §11 #1)

```bash
# PROPOSED ONLY — do not run without Captain sign-off
az account set --subscription "<SUBSCRIPTION_ID>"
az group create \
  --name luna-sunset-staging-rg \
  --location westeurope \
  --tags purpose=sunset-staging tenant=sunset slice=portal-1
```

### Phase 2 — Bicep outline (recommended path)

Bicep draft (review only): [`infra/azure/sunset-staging/main.bicep`](../../infra/azure/sunset-staging/main.bicep)  
Forked from Wolfhouse `infra/azure/staging/main.bicep` with these parameter overrides:

| Parameter | Wolfhouse value | Sunset value |
|-----------|-----------------|--------------|
| `appNamePrefix` | `wh-staging` | `luna-sunset-staging` |
| `appDbName` | `wolfhouse_staging` | `sunset_staging` |
| `staffApiImage` | `whstagingacr.../wh-staff-api:...` | `<ACR>/luna-sunset-staff-api:2551855...` |
| `deployN8nApps` | optional | **`false`** (Slice 1) |
| Redis | included | **omit or disable** (Slice 1) |

```bash
# PROPOSED ONLY — what-if before create
az deployment group what-if \
  --resource-group luna-sunset-staging-rg \
  --template-file infra/azure/sunset-staging/main.bicep \
  --parameters @infra/azure/sunset-staging/parameters.example.json \
  --parameters postgresAdminPassword="<DB_PASSWORD_PLACEHOLDER>"
```

```bash
# PROPOSED ONLY — deploy base infra (KV, PG, CAE, identity, ACR if Option B)
az deployment group create \
  --resource-group luna-sunset-staging-rg \
  --template-file infra/azure/sunset-staging/main.bicep \
  --parameters @infra/azure/sunset-staging/parameters.example.json \
  --parameters postgresAdminPassword="<DB_PASSWORD>" \
  --name "luna-sunset-staging-deploy-YYYYMMDD"
```

### Phase 3 — Key Vault secrets (Sunset only)

```bash
# PROPOSED ONLY — after KV exists in luna-sunset-staging-rg
az keyvault secret set --vault-name luna-sunset-staging-kv \
  --name sunset-database-url \
  --value "postgres://sunsetadmin:<DB_PASSWORD>@luna-sunset-staging-pg-app.postgres.database.azure.com:5432/sunset_staging?sslmode=require"

az keyvault secret set --vault-name luna-sunset-staging-kv \
  --name staff-session-secret \
  --value "<RANDOM_SESSION_SECRET>"

# Stripe: sk_test_* only — or omit until payments demo needed
az keyvault secret set --vault-name luna-sunset-staging-kv \
  --name stripe-secret-key \
  --value "sk_test_<PLACEHOLDER>"

# WhatsApp: dry-run enforced in app env; token optional placeholder
az keyvault secret set --vault-name luna-sunset-staging-kv \
  --name meta-whatsapp-token \
  --value "EAAG_PLACEHOLDER_DRY_RUN_ONLY"
```

**Forbidden:** writing `wolfhouse-database-url` pointing at `wh-staging-pg-app` into Sunset KV for Sunset app use.

### Phase 4 — Build Staff API image (checkbox §11 #2)

```bash
# PROPOSED ONLY — from repo root @ pinned SHA
git checkout 25518554bcf635b59c594dae8f930c0190609209

# Option A — shared ACR, dedicated image repo
az acr build --registry whstagingacr \
  --image luna-sunset-staff-api:25518554bcf635b59c594dae8f930c0190609209 \
  --file Dockerfile .

# Option B — dedicated ACR
az acr build --registry lunasunsetstagingacr \
  --image luna-sunset-staff-api:25518554bcf635b59c594dae8f930c0190609209 \
  --file Dockerfile .
```

**Image must include:** `config/clients/sunset.baseline.json`, `staff-portal-access.json` (Sunset-scoped), root `Dockerfile` layout (`scripts/`, `config/`, `database/`).

### Phase 5 — Deploy Container App (checkbox §11 #2)

```bash
# PROPOSED ONLY — verify RG and app name before run
az containerapp update \
  --resource-group luna-sunset-staging-rg \
  --name luna-sunset-staging-staff-api \
  --image <ACR>.azurecr.io/luna-sunset-staff-api:25518554bcf635b59c594dae8f930c0190609209
```

### Phase 6 — DNS + custom domain (checkbox §11 #3)

```bash
# PROPOSED ONLY
az containerapp hostname add \
  --resource-group luna-sunset-staging-rg \
  --name luna-sunset-staging-staff-api \
  --hostname sunset-staging.lunafrontdesk.com

# Bind managed cert (exact command varies by Azure CLI version)
# Then CNAME at DNS provider: sunset-staging.lunafrontdesk.com → <app ingress FQDN>
```

### Phase 7 — DB migrations + tenant row (checkbox §11 #4)

```bash
# PROPOSED ONLY — against Sunset DB only
export WOLFHOUSE_DATABASE_URL="postgres://...@luna-sunset-staging-pg-app.../sunset_staging?sslmode=require"
# Apply migrations (Captain approval; resolve migration-015 gap per VERIFY-LUNA-GOLDEN-DB-NOTE.md)
# npm run db:migrate  # or per-migration scripts when Sunset runbook exists

# Verify clients.slug=sunset exists before seed
```

### Phase 8 — Health check

```bash
curl -s https://sunset-staging.lunafrontdesk.com/healthz
curl -s -o /dev/null -w "%{http_code}" https://sunset-staging.lunafrontdesk.com/staff/ui
```

---

## 3. Isolation guarantees

| Guarantee | Mechanism |
|-----------|-----------|
| No `wh-staging-rg` deploy | All resources in `luna-sunset-staging-rg` only; pre-flight name check |
| No `wh-staging-staff-api` | Container App name lock: `luna-sunset-staging-staff-api` |
| No `staff-staging.lunafrontdesk.com` | Smoke/seed URLs hardcoded to `sunset-staging.lunafrontdesk.com` |
| No Wolfhouse staging DB | DB host `luna-sunset-staging-pg-app`; database `sunset_staging` |
| No production DB | Fail-closed seed guards; separate KV secrets |
| Dedicated Sunset DB only | Single-tenant DB; expect zero `wolfhouse-somo` rows post-migrate |
| Separate env vars/secrets | `luna-sunset-staging-kv` secrets; no reuse of Wolfhouse `wolfhouse-database-url` in Sunset app |
| No Wolfhouse image overwrite | Image repo `luna-sunset-staff-api`, never `wh-staff-api` tag mutation for Sunset |

**Ops pre-flight script (recommended before any `az` command):**

```bash
# Abort if these appear in target RG/app/URL/DB URL
FORBIDDEN_RG=wh-staging-rg
FORBIDDEN_APP=wh-staging-staff-api
FORBIDDEN_URL=staff-staging.lunafrontdesk.com
FORBIDDEN_DB_HOST=wh-staging-pg-app
FORBIDDEN_DB_NAME=wolfhouse_staging
```

---

## 4. Staff API config / env requirements

Mirror Wolfhouse staging **safety defaults** from `infra/azure/staging/main.bicep` (hardcoded, not overridable):

| Variable | Value | Purpose |
|----------|-------|---------|
| `NODE_ENV` | `staging` | Not `production` |
| `WHATSAPP_DRY_RUN` | `true` | **No live WhatsApp sends** |
| `STAFF_ACTIONS_ENABLED` | `false` | **Read-only portal Slice 1** — keep false |
| `STAFF_AUTH_REQUIRED` | `true` | Login required |
| `STAFF_AUTH_HTTPS` | `true` | Secure cookies |
| `STRIPE_WEBHOOK_SKIP_VERIFY` | `false` | Unless test harness requires otherwise |
| `STAFF_QUERY_API_PORT` | `3036` | Match Dockerfile |
| `STAFF_QUERY_API_HOST` | `0.0.0.0` | Container bind |

### DB URL / secret handling

| Secret (KV) | Env in Container App | Notes |
|-------------|----------------------|-------|
| `sunset-database-url` | `WOLFHOUSE_DATABASE_URL` (secretRef) | App reads `WOLFHOUSE_DATABASE_URL` or `DATABASE_URL` via `pg-connect.js`; value must be **Sunset DB only** |

**Naming note:** Code uses `WOLFHOUSE_DATABASE_URL` as generic PG connection env — the **value** must point to `sunset_staging`, not Wolfhouse.

### Auth / session

| Variable | Value |
|----------|-------|
| `STAFF_SESSION_SECRET` | From KV `staff-session-secret` |
| `STAFF_SESSION_COOKIE_NAME` | `luna_staff_session` |
| `STAFF_SESSION_TTL_HOURS` | `12` |

Configure `config/clients/staff-portal-access.json` for Sunset demo users (Sunset-scoped `client_access` recommended over `all_clients_emails` on isolated env).

### WhatsApp / Stripe for demo

| Service | Slice 1 behavior |
|---------|------------------|
| WhatsApp | `WHATSAPP_DRY_RUN=true`; Meta token can be placeholder; **no inbound webhook required** for portal tab gating demo |
| Stripe | `sk_test_*` only if payment UI needed; Slice 1 read-only — **no live payment links**; seed manifest has `payment_link: null` |

### `STAFF_ACTIONS_ENABLED`

**Keep `false` for Slice 1.** Portal is read-only (Day Schedule, inbox browse). Re-enable only in a future slice with explicit Captain approval.

---

## 5. Seed allowlist impact (separate approval — do not implement now)

### Current behavior (`2551855`)

`scripts/fixtures/sunset-portal-slice1-guards.js`:

- `--execute` requires `ALLOW_SUNSET_DEMO_SEED=1`
- **Allows:** `localhost`, `127.0.0.1`, `*.test` only
- **Rejects:** any hostname matching `staging`, `azure`, `lunafrontdesk`, `wolfhouse`, etc.

Therefore seed **cannot** target Sunset staging DB today, even after infra exists.

### Future allowlist change (checkbox §11 #5 — code change later)

**Option A (recommended):** Add exact host allowlist entry:

```javascript
// PROPOSED FUTURE PATCH — not implemented now
const SUNSET_STAGING_DB_HOSTS = [
  /^luna-sunset-staging-pg-app\.postgres\.database\.azure\.com$/i,
];
```

**Option B:** Env-gated override:

```bash
SUNSET_DEMO_SEED_STAGING_DB_ALLOW=1
# + hostname must match luna-sunset-staging-pg-app exactly
```

**Must still reject:**

- `wh-staging-pg-app.postgres.database.azure.com`
- `wolfhouse_staging` database name in connection string used for seed (validate in script)

**Execute command shape (after allowlist + checkbox #6):**

```bash
export ALLOW_SUNSET_DEMO_SEED=1
export WOLFHOUSE_DATABASE_URL='postgres://<user>:<pass>@luna-sunset-staging-pg-app.postgres.database.azure.com:5432/sunset_staging?sslmode=require'
node scripts/fixtures/sunset-portal-slice1-seed.js --execute
```

---

## 6. Smoke test plan

### A. Pre-deploy (code)

- [ ] `npm run verify:sunset-all` — 7/7
- [ ] `node scripts/fixtures/sunset-portal-slice1-seed.js` — dry-run, planned counts
- [ ] `npm run verify:sunset-portal-slice1-seed-runner` — 37/37

### B. Post-infra / post-deploy (Sunset URL only)

| Step | Check |
|------|-------|
| Health | `curl https://sunset-staging.lunafrontdesk.com/healthz` → ok |
| Portal UI | `GET /staff/ui` → 200 |
| Login | `https://sunset-staging.lunafrontdesk.com/staff/login` |
| Sunset tenant | Client selector shows Sunset; **no Wolfhouse bed-calendar default** |
| Tab gating | Booking Calendar **hidden**; Tour Operator **hidden**; Day Schedule **visible** |
| Default tab | WhatsApp (`conversations`) |
| Day Schedule tiles | Config `portal_demo.lesson_slots` visible (e.g. `2026-07-10`) |
| No Wolfhouse data | No R1–R7, no `wolfhouse-somo` leakage on Sunset URL |
| Seed dry-run | Run from CI/worktree (not against prod); no `--execute` |

### C. Post-seed (only after checkbox #6 — later)

- [ ] Inbox: Alex + Maria demo conversations
- [ ] Day Schedule tables populated on `2026-07-10`–`12`
- [ ] SQL: zero `wolfhouse-somo` rows on Sunset DB
- [ ] Tag `sunset_demo_slice1` only

**Wolfhouse staging smoke:** Not required on Sunset URL. Verify `staff-staging.lunafrontdesk.com` unchanged separately if desired.

---

## 7. Rollback / delete plan (Sunset resources only)

### Disable traffic

```bash
# PROPOSED ONLY
az containerapp ingress disable \
  --resource-group luna-sunset-staging-rg \
  --name luna-sunset-staging-staff-api
```

Or set ingress traffic to 0% on current revision.

### Revert image

```bash
# PROPOSED ONLY
az containerapp revision list \
  --resource-group luna-sunset-staging-rg \
  --name luna-sunset-staging-staff-api -o table

az containerapp ingress traffic set \
  --resource-group luna-sunset-staging-rg \
  --name luna-sunset-staging-staff-api \
  --revision-weight <previous-revision>=100
```

### Delete Sunset staging only (destructive — Captain approval)

```bash
# PROPOSED ONLY — deletes ALL resources in Sunset RG; NEVER wh-staging-rg
az group delete --name luna-sunset-staging-rg --yes --no-wait
```

### Seed cleanup (Sunset DB only, after allowlist)

```bash
node scripts/fixtures/sunset-portal-slice1-cleanup.js --execute
# tag sunset_demo_slice1 only
```

**Wolfhouse staging:** No rollback action. **Production:** No action.

---

## 8. Approval checklist (maps to approval packet §11)

Captain signs each before Ops proceeds:

```
[ ] 1. APPROVE INFRA CREATION
    Create luna-sunset-staging-rg, luna-sunset-staging-env,
    luna-sunset-staging-kv, luna-sunset-staging-pg-app (sunset_staging),
    luna-sunset-staging-identity, ACR strategy (A or B).
    MUST NOT touch wh-staging-rg or wh-staging-staff-api.

[ ] 2. APPROVE FIRST IMAGE DEPLOY
    Build luna-sunset-staff-api:25518554bcf635b59c594dae8f930c0190609209
    Deploy to luna-sunset-staging-staff-api only.

[ ] 3. APPROVE DNS / CERT BINDING
    sunset-staging.lunafrontdesk.com → luna-sunset-staging-staff-api
    TLS managed cert valid.

[ ] 4. APPROVE DB CREATION + MIGRATIONS
    sunset_staging schema + clients.slug=sunset row.
    MUST NOT use wolfhouse_staging.

[ ] 5. APPROVE SEED ALLOWLIST CHANGE (code PR separate)
    Allow luna-sunset-staging-pg-app host only in seed guards.
    MUST NOT allowlist wh-staging-pg-app.

[ ] 6. APPROVE SEED --execute (later)
    After §6 config smoke on sunset-staging.lunafrontdesk.com.
    ALLOW_SUNSET_DEMO_SEED=1 + Sunset DB URL only.

[ ] 7. PROCEED TO MERGE (approval packet §11 #6)
    Only after isolated staging smoke passes.
```

---

## 9. Open decisions for Captain

| # | Decision | Options | Deckhand recommendation |
|---|----------|---------|-------------------------|
| 1 | ACR strategy | Reuse `whstagingacr` vs new `lunasunsetstagingacr` | Dedicated ACR in `luna-sunset-staging-rg` for strongest isolation; shared ACR acceptable for Slice 1 speed |
| 2 | Azure subscription / budget owner | Confirm sub + monthly cap | Required before Phase 1 |
| 3 | Postgres SKU | `Standard_B1ms` (match Wolfhouse) | Sufficient for demo |
| 4 | Staff portal access on isolated env | Sunset-only user vs `all_clients_emails` | Sunset-only `client_access` entry recommended |
| 5 | Redis in Sunset RG | Include vs defer | **Defer** Slice 1 |
| 6 | Bicep location | New `infra/azure/sunset-staging/` vs one-off CLI | New Bicep module (future commit) for repeatability |
| 7 | Migration runbook | Who runs migrations on `sunset_staging` | Ops after checkbox #4; resolve migration-015 gap first |

---

## 10. Summary

Sunset Portal Slice 1 needs **new isolated Azure infra** in `luna-sunset-staging-rg` before any deploy. The Staff API runs at `https://sunset-staging.lunafrontdesk.com` on `luna-sunset-staging-staff-api` with a **dedicated `sunset_staging` database**. Wolfhouse staging (`wh-staging-*`, `staff-staging.lunafrontdesk.com`) must never be targeted. Seed remains dry-run / localhost-only until a separate allowlist code change and checkbox #5–#6. Merge stays held until config (+ optional seed) smoke passes on the isolated URL.

---

*Plan version: 1.0 — 2026-06-19 — proposed commands not executed*

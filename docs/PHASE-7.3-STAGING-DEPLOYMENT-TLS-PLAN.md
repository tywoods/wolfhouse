# Stage 7.3 — Staging Deployment + TLS Plan

**Status:** DESIGN DONE + 7.3b IaC scaffold PASS (2026-05-31) + 7.3c deployment preflight PASS (2026-06-01) + 7.3d Azure staging deployed + login proven (2026-06-01) + 7.3e Luna Front Desk login page implemented + Azure PROOF PASS (2026-06-02) + **7.3f custom domain + TLS DONE (2026-06-02)**. `staff-staging.lunafrontdesk.com` bound with Azure managed cert (`SniEnabled`); all smoke tests PASS on clean URL. DNS/custom TLS on lunafrontdesk.com now configured for staging Staff API.
**Parent plan:** [`PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md`](PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md) — Workstream C (TLS/deployment).
**Depends on:** [`PHASE-7.1-ENV-SECRETS-INVENTORY.md`](PHASE-7.1-ENV-SECRETS-INVENTORY.md) (env separation, secrets), [`PHASE-7.2-AUTH-STAFF-ACCOUNTS-PLAN.md`](PHASE-7.2-AUTH-STAFF-ACCOUNTS-PLAN.md) (auth before write surface).
**Aligns with:** [`azure-n8n-hosting-plan.md`](azure-n8n-hosting-plan.md) (existing Container Apps + Key Vault topology).
**Scope:** Define how to stand up a safe **staging** environment — HTTPS, domains/subdomains, staff UI/API, n8n webhook URLs, secrets injection, inactive workflows by default, and deployment gates.

> This is a design document only. It creates no Azure resources, changes no DNS, builds no TLS or auth, and approves no live operation. All dangerous live paths (real WhatsApp, live Stripe, staff writes) remain disabled by default.

---

## 1. Objective

- Produce the plan for a safe **Azure staging** deployment of the proven local/dev system.
- **Staging is isolated** from local and from future production — separate data, secrets, n8n, DB, and domains (per [`PHASE-7.1`](PHASE-7.1-ENV-SECRETS-INVENTORY.md)).
- **HTTPS is required before** any auth cookie or staff write surface is enabled.
- All dangerous live paths remain **disabled by default**: `WHATSAPP_DRY_RUN=true`, `STAFF_ACTIONS_ENABLED=false`, Stripe **test** keys only, `STRIPE_WEBHOOK_SKIP_VERIFY=false`, all workflows inactive.

Staging's job: prove the system runs over HTTPS with isolated infra and per-user auth, so the pilot soak (Stage 7.6/7.7) and the live gates (7.8/7.9) have a safe home — **without** turning anything live.

---

## 2. Deployment target options

| Option | Summary | Cost | Ops complexity | TLS | Secrets | Workers | Webhooks | Verdict |
|---|---|---|---|---|---|---|---|---|
| **A. Azure Container Apps** | Managed serverless containers; per-service ingress | Low–med (scale-to-low) | Low | Managed certs + HTTPS ingress built-in | Key Vault refs / secret refs | First-class (n8n worker as separate app, no ingress) | Per-app HTTPS FQDN | **RECOMMENDED** |
| **B. Azure App Service (containers)** | Managed web app for containers | Med | Low–med | Managed certs built-in | App settings / Key Vault refs | Multi-container/sidecar is clunky; worker awkward | HTTPS FQDN | Viable; weaker for the queue worker |
| **C. Azure VM + Docker Compose** | Lift-and-shift the existing compose file | Low (1 VM) but you patch/secure it | **High** (OS patching, TLS via nginx/Caddy, backups manual) | DIY (Caddy/nginx + Let's Encrypt) | DIY (.env on box = worse) | Trivial (same compose) | DIY reverse proxy | Fastest to start, worst to operate safely — not recommended for a pilot we must trust |
| **D. Azure Kubernetes Service** | Full k8s | Med–high | **Very high** | Ingress + cert-manager | CSI/secret store | Native | Ingress | **Overkill** for a 2–3 person pilot |
| **E. Keep n8n Cloud + deploy staff API separately** | n8n stays on `tywoods.app.n8n.cloud`; only the staff API/UI is deployed | Low (reuse cloud) | Low for n8n; split-brain risk | Cloud TLS + Container App for API | Mixed (two secret homes) | n8n Cloud handles workers | n8n Cloud webhook URLs | Useful **interim**, but splits env separation and complicates the Stage 7.1 isolation story |

### Recommendation — **Option A: Azure Container Apps**

Simplest safe path for the Wolfhouse pilot, and it matches the **existing** [`azure-n8n-hosting-plan.md`](azure-n8n-hosting-plan.md) (Container Apps + Key Vault + queue mode worker). Reasons:
- **Managed HTTPS** ingress with automatic certificates — satisfies the TLS-before-cookies gate with no DIY proxy.
- **Secret refs / Key Vault** integration — no secrets on disk, satisfies [`PHASE-7.1`](PHASE-7.1-ENV-SECRETS-INVENTORY.md).
- **Worker model** maps cleanly to n8n queue mode (main app with ingress + worker app without ingress).
- **Scale-to-low** keeps staging cheap when idle.
- **Multi-client scaling later** is straightforward (more apps / more revisions) without re-architecting.

**Interim option:** if standing up self-hosted n8n on Container Apps is not ready, Option E (keep n8n Cloud, deploy only the staff API/UI to a Container App) is acceptable **for the staff-surface part of staging only** — but the env-isolation story (separate staging DB, no prod data) still applies, and n8n Cloud must keep all Wolfhouse workflows **inactive**.

---

## 3. Proposed staging topology

```
                         Internet (HTTPS only)
                                  │
        ┌─────────────────────────┼──────────────────────────┐
        │                         │                          │
  staff-staging.<domain>   n8n-staging.<domain>     webhook-staging.<domain>
        │                         │                          │
   ┌────▼─────┐            ┌───────▼────────┐        (same n8n ingress;
   │ Staff    │            │ n8n main app    │         WEBHOOK_URL routes
   │ API/UI   │            │ (Container App, │         /webhook/* paths)
   │ (Container│           │  HTTPS ingress) │
   │  App)    │            └───────┬────────┘
   └────┬─────┘                    │
        │                   ┌──────▼───────┐      ┌──────────────┐
        │                   │ n8n worker   │      │ Azure Cache  │
        │                   │ (no ingress) │◄────►│ for Redis    │
        │                   └──────┬───────┘      │ (TLS 6380)   │
        │                          │              └──────────────┘
   ┌────▼──────────────┐    ┌──────▼───────────┐
   │ Wolfhouse app DB  │    │ n8n system DB     │
   │ (Postgres staging,│    │ (Postgres staging,│
   │  private, SSL)    │    │  private, SSL)    │
   └───────────────────┘    └───────────────────┘

   Secrets: Azure Key Vault  ──(secret refs)──►  all apps
   Logs/metrics: Azure Monitor / Application Insights / Log Analytics
```

| Component | Staging choice |
|---|---|
| **Staff API/UI service** | Container App, HTTPS ingress, image built from repo (`scripts/staff-query-api.js`, deps `dotenv`+`pg`). Min replicas 1; scale-to-low allowed in staging. |
| **n8n service** | Self-hosted n8n main (Container App, HTTPS ingress) **or** interim n8n Cloud (Option E). Self-host preferred for env isolation. |
| **n8n worker** | Separate Container App, command `worker`, **no public ingress** (queue mode). |
| **Wolfhouse app DB** | Azure Database for PostgreSQL Flexible Server — `wolfhouse_staging` DB, private access, `DB_POSTGRESDB_SSL=true`. **No prod/local data.** |
| **n8n system DB** | Separate Postgres DB (`n8n_staging`) — workflows, encrypted credentials, executions. |
| **Redis** | Azure Cache for Redis, TLS (6380), `noeviction` (queue integrity). |
| **Secrets store** | Azure Key Vault; apps reference secrets, never inline. |
| **DNS/subdomains** | `*-staging.<domain>` records (placeholders below). |
| **TLS termination** | At Container Apps ingress (managed certs). HTTPS only. |
| **Logs/monitoring** | Azure Monitor + Application Insights / Log Analytics (durable audit + execution failures — feeds Stage 7.5). |

---

## 4. Domains / subdomains

Placeholders — `<domain>` is the operator's chosen domain; **do not** hardcode a real domain here (the only real domain referenced in repo is the marketing site `wolf-house.com` and the example `automation.wolf-house.com` in the Azure plan).

| Purpose | Staging (placeholder) | Production (placeholder, later) |
|---|---|---|
| Staff UI + API | `staff-staging.<domain>` | `staff.<domain>` |
| Staff API (if split from UI) | `api-staging.<domain>` *(or reuse `staff-staging.<domain>/staff/*`)* | `api.<domain>` |
| n8n editor/UI | `n8n-staging.<domain>` | `n8n.<domain>` |
| n8n webhooks (WhatsApp/Stripe/Apps Script) | `webhook-staging.<domain>` *(or `n8n-staging.<domain>/webhook/*`)* | `webhook.<domain>` / `automation.<domain>` |

**Decision:** for the pilot, the staff API and UI are the **same service/host** (`staff-staging.<domain>`, paths `/staff/ui`, `/staff/query`, `/staff/intents`, `/staff/handoff/:id/resolve`) — no need to split API onto its own subdomain yet. n8n webhooks may share the n8n ingress host (`WEBHOOK_URL=https://n8n-staging.<domain>/`) rather than a separate subdomain, to keep DNS minimal.

---

## 5. TLS / auth-cookie requirements

| Requirement | Rule |
|---|---|
| **HTTPS before cookies** | Secure session cookies (Stage 7.2) require HTTPS. No auth cookie is issued over plaintext. TLS must be live and verified before login is enabled. |
| **Cookie flags** | `HttpOnly` (no JS access), `Secure` (HTTPS only), `SameSite=Lax`. State-changing POSTs additionally require CSRF protection (per [`PHASE-7.2 §5`](PHASE-7.2-AUTH-STAFF-ACCOUNTS-PLAN.md)). |
| **SameSite strategy** | `Lax` for the session cookie (staff UI and API on the same site/host). `None` only if a cross-site embed is ever needed (not for pilot) — and only with `Secure`. |
| **No write endpoint without TLS + auth** | `POST /staff/handoff/:id/resolve` (and any future write) stays **unreachable/disabled** in staging until both TLS **and** the auth middleware (Stage 7.2 implementation) exist. |
| **Operator token disabled outside local/dev** | `STAFF_OPERATOR_TOKEN` must be rejected in staging/production. Staging deploy sets it unset/empty and the app must treat the token path as local-dev-only (env-gated). |
| **HSTS / redirects** | HTTP → HTTPS redirect; HSTS header on the staff host once stable. |

---

## 6. Workflow deployment rules (staging)

- **All imported n8n workflows are inactive by default.** Activation is manual, per approved test window only.
- **Webhook URLs must not point to localhost.** `WEBHOOK_URL` / `N8N_WEBHOOK_URL` and `N8N_CREATE_PAYMENT_SESSION_URL` use the staging HTTPS host, never `localhost`/`127.0.0.1` (a Stage 7.1 hard block).
- **Only one explicitly approved workflow** is active during any test window; deactivate after.
- **`WHATSAPP_DRY_RUN=true`** in staging until the Stage 7.8 live-send gate passes.
- **`STAFF_ACTIONS_ENABLED=false`** by default; enabled only after auth + TLS exist (Stage 7.2/7.3) and only for the handoff-resolve scope.
- **Stripe test keys only** (`sk_test_*`/`pk_test_*`); `sk_live_*` in staging is a Stage 7.1 hard block.
- **`STRIPE_WEBHOOK_SKIP_VERIFY=false`** in staging always (signature verification on).
- **`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`** in staging (Code nodes must not read raw `$env`) — differs from local where it is `false`.
- **`N8N_ENCRYPTION_KEY`** is a unique random ≥32-char value from Key Vault, **set once**; losing/rotating it invalidates stored credentials.

---

## 7. Secrets injection

| Environment | Mechanism | Owner |
|---|---|---|
| **local** | `infra/.env` (gitignored) + Docker env; `.env.example` placeholders only | Dev |
| **staging** | **Azure Key Vault** → Container Apps secret refs / app settings. No `.env` on the host. | Dev/ops |
| **production** | **Separate** Key Vault / secret store (distinct from staging). No shared secrets across envs. | Dev/ops + owner |

**Rules:**
- **No secrets in repo** — `.env.example` carries placeholders only.
- Each app references secrets by name; values live only in Key Vault.
- Deploy pipeline (and only it) has read access to the relevant vault.

### Environment variable ownership (staging-critical)

| Variable | Secret? | Source of truth (staging) | Owner | Staging value rule |
|---|---|---|---|---|
| `WOLFHOUSE_DATABASE_URL` | Yes | Key Vault | Dev/ops | staging DB FQDN, SSL on, never localhost |
| `N8N_ENCRYPTION_KEY` | Yes | Key Vault | Dev | unique ≥32 chars, set once |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Yes | Key Vault | Dev | `sk_test_*` / test `whsec_*` only |
| `WHATSAPP_ACCESS_TOKEN` / `_PHONE_NUMBER_ID` / `_APP_SECRET` / `_VERIFY_TOKEN` | Yes | Key Vault | Dev/owner | test/sandbox number only |
| `STAFF_OPERATOR_TOKEN` | n/a | — | — | **unset** in staging (local/dev only) |
| `STAFF_ACTIONS_ENABLED` | No | app setting | Dev | `false` default |
| `WHATSAPP_DRY_RUN` | No | app setting | Owner | `true` until 7.8 gate |
| `STRIPE_WEBHOOK_SKIP_VERIFY` | No | app setting | Dev | `false` always |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | No | app setting | Dev | `true` |
| `WEBHOOK_URL` / `N8N_WEBHOOK_URL` | No | app setting | Dev/ops | staging HTTPS host, never localhost |
| (future) `STAFF_SESSION_SECRET` / `STAFF_JWT_SECRET` | Yes | Key Vault | Dev | rotation per env |

### Rotation / revoke
- DB passwords: rotate on first deploy + periodically; revoke = change password + redeploy.
- `N8N_ENCRYPTION_KEY`: rotate only on compromise (destructive — re-enter credentials).
- Stripe/WhatsApp tokens: revoke in their consoles; update Key Vault.
- Per full policy see [`PHASE-7.1 §ROTATION`](PHASE-7.1-ENV-SECRETS-INVENTORY.md).

---

## 8. Deployment artifact plan

### Deployed
| Artifact | Notes |
|---|---|
| **Staff query API/UI** | `scripts/staff-query-api.js` + `scripts/lib/*` it requires + `package.json` deps (`dotenv`, `pg`). Containerized. |
| **n8n generated workflow JSONs** | `n8n/phase2/*.json` (and other approved forks), imported **inactive**. Never the hosted originals casually. |
| **Migrations** | `database/migrations/*.sql` applied via the existing `scripts/run-sql.js` pattern (same as `db:migrate:*` scripts). |
| **Client config** | `config/clients/*.baseline.json` (committed, no secrets). Secret files (`*.secrets.json`) injected via Key Vault, never from repo. |

### NOT deployed
- Test fixtures (`scripts/fixtures/*`, `test-payloads/*`).
- `_tmp*.js` / `_tmp*.sql` scratch scripts.
- Local `.env` files / any secret file.
- Dev-only seed/test data and disposable bookings.

### Migration apply process (staging)
1. **Backup the staging DB first** (snapshot / `pg_dump`).
2. Apply migrations **on staging before production**, one at a time, reviewed.
3. Each migration has a **rollback plan** (down script or documented forward-fix) — per [`PHASE-7 §E`](PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md).
4. **No auto-run of destructive migrations** in the deploy pipeline; destructive changes are manual, gated, and backed up.
5. Migrations are **idempotent** where possible (existing `CREATE ... IF NOT EXISTS` style) to make re-runs safe.

---

## 9. Staging verification gates

After deployment, **before any pilot activity**, all must hold:

- [ ] **HTTPS reachable** on `staff-staging.<domain>` (valid cert; HTTP redirects to HTTPS).
- [ ] **Staff UI loads** (`GET /staff/ui`) over HTTPS.
- [ ] **`GET /staff/intents`** returns the registry list.
- [ ] **Read-only query works** (`GET /staff/query` against staging DB returns rows; zero writes).
- [ ] **Auth/login works** once Stage 7.2 auth is implemented (session cookie issued over HTTPS; logout invalidates).
- [ ] **`STAFF_ACTIONS_ENABLED=false`** verified (write endpoint returns disabled/forbidden).
- [ ] **`WHATSAPP_DRY_RUN=true`** verified (no real Graph API send path).
- [ ] **Stripe test keys only** verified (`sk_test_*`; no live key present).
- [ ] **`STRIPE_WEBHOOK_SKIP_VERIFY=false`** verified.
- [ ] **All n8n workflows inactive** by default.
- [ ] **Backup configured** for the staging app DB (and n8n DB); a restore drill is planned (Stage 7.4).
- [ ] **Audit log durable** (writes to Azure Monitor / a durable store, not just a container-local file).
- [ ] **`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`** verified.
- [ ] **Webhook URLs** are the staging HTTPS host (no localhost).

These verification gates can later be partially automated by the planned `scripts/verify-env-safety.js` (designed in [`PHASE-7.1`](PHASE-7.1-ENV-SECRETS-INVENTORY.md), not implemented).

---

## 10. Implementation slices (future — gated, not started)

| Slice | Name | Scope | Status |
|---|---|---|---|
| 7.3a | Deployment target decision | Confirm Container Apps (Option A) vs interim Option E; record decision | **DONE (this doc recommends A)** |
| 7.3b | Azure resource plan | Resource list (Container Apps env, 2× Postgres, Redis, Key Vault, Log Analytics); sizing; private networking | **DONE** — IaC scaffold PASS (2026-05-31) |
| 7.3c | DNS / TLS plan | Subdomain records, managed certs, HTTPS-only ingress, HSTS/redirects | **DONE** — Preflight PASS (2026-06-01): scaffold validated, manual inputs defined, Phase A–M plan, what-if command prepared, smoke tests defined |
| 7.3d | Staging secrets plan | Key Vault entries, secret refs per app, ownership + rotation wiring | **DONE** — Azure staging deployed + login proven (2026-06-01): Staff API + n8n live over Azure HTTPS FQDNs; Ty owner login confirmed; 11 workflows imported inactive; all safety flags confirmed |
| 7.3e | Staging deploy scaffold | Real staff login page for Azure `/staff/ui` (first login currently via API POST) | **DONE** — Luna Front Desk login page implemented (2026-06-01): `GET /staff/login` serves branded HTML form; browser redirect from `/staff/ui`; logout button wired; 30-check verifier PASS |
| 7.3f | Staging smoke checklist | DNS/custom domain plan for `staff-staging.lunafrontdesk.com` | PENDING |
| 7.3g | n8n staging workflow import policy | Convert + import remaining 3 active-source workflows as inactive | PENDING |

Each slice is a separate approved task with its own proof. None are started here. Nothing is deployed.

---

## 11. Go / No-Go summary

**Stage 7.3 (design) PASS criteria — met by this doc:**
- Deployment target options evaluated; recommendation chosen (Azure Container Apps, aligned with existing Azure plan).
- Staging topology defined (staff API/UI, n8n main+worker, 2× Postgres, Redis, Key Vault, monitoring).
- Domain/subdomain placeholders + TLS termination defined.
- TLS/auth-cookie requirements defined (HTTPS before cookies; no write without TLS+auth; operator token disabled outside local/dev).
- Workflow safety rules defined (inactive by default; dry-run; flags off; test keys; verify-on).
- Secrets injection + ownership + rotation defined (Key Vault; no secrets in repo).
- Deployment artifact plan (deploy / do-not-deploy / migration process) defined.
- Staging verification gates enumerated.
- Implementation slices enumerated (not started).

**NOT claimed:** staging is not deployed; no Azure resources created; no DNS changed; TLS/auth not implemented; live operation not approved.

---

## 12. Implementation log

### 7.3b — IaC scaffold PASS (2026-05-31)

**Files created:**
- `docs/PHASE-7.3B-AZURE-STAGING-RESOURCE-SCAFFOLD.md` — resource inventory, KV secret map, networking assumptions, deployment gates
- `infra/azure/staging/main.bicep` — Bicep template: Log Analytics, App Insights, managed identity, Key Vault, ACR, Redis, 2× Postgres Flexible Server, Container Apps environment, staff-api + n8n-main + n8n-worker Container Apps, KV role assignments, ACR pull role assignment
- `infra/azure/staging/parameters.example.json` — example parameters (no secrets, no real IDs)
- `infra/azure/staging/README.md` — runbook: prerequisites, KV secret-set commands, dry-run (`what-if`), deploy (marked DO NOT RUN), post-deploy checklist, rollback/teardown (marked DESTRUCTIVE)
- `scripts/verify-azure-staging-scaffold.js` — 57 static checks: file existence, no real secrets, required resource types, safety env defaults (WHATSAPP_DRY_RUN/STAFF_ACTIONS_ENABLED/STAFF_AUTH_REQUIRED/STRIPE_WEBHOOK_SKIP_VERIFY/N8N_BLOCK_ENV_ACCESS_IN_NODE), KV secret refs, no worker ingress, DO NOT RUN warning, destructive rollback label

**Verifier result:** PASS — 57/57 checks green (0 failures)

**What is still NOT done:** No Azure resources created. No deployment run. No DNS configured. No TLS active. Staging not live.

### 7.3c — Deployment preflight PASS (2026-06-01)

**HEAD:** `8b60961`

**Files created:**
- `docs/PHASE-7.3C-AZURE-STAGING-DEPLOYMENT-PREFLIGHT.md` — preflight doc: scaffold validation, manual inputs, Phase A–M plan, what-if command, smoke tests, go/no-go summary
- `infra/azure/staging/parameters.ty-template.json` — Ty's fill-in template with `<FILL_ME: ...>` placeholder tokens
- `scripts/verify-azure-staging-preflight.js` — 26-check preflight verifier (no Azure API calls)

**Files updated:**
- `infra/azure/staging/README.md` — Phase A–M table added; `az group create` annotated with APPROVAL REQUIRED; what-if updated to reference `parameters.ty-template.json`; post-deploy checklist includes lunafrontdesk.com subdomains
- `scripts/verify-staff-conversation-ui.js` — "Cami Dashboard" check updated to "Luna Front Desk or Cami Dashboard" (UI renamed in stage 7.7k)
- `docs/PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md` — 7.3c PASS recorded

**Verifier results:**
- `verify-azure-staging-preflight.js`: PASS — 26/26 checks
- `verify-azure-staging-scaffold.js`: PASS — 57/57 checks
- `verify-staff-auth-api.js`: PASS
- `verify-staff-query-api.js`: PASS
- `verify-staff-conversation-ui.js`: PASS — 52/52 checks
- `verify-staff-bed-calendar-ui.js`: PASS — 40/40 checks
- `build-main-local-stripe.js --verify-targets`: PASS
- `node --check scripts/run-stage4-autonomous-dry-run.js`: PASS

**Safety defaults confirmed:** WHATSAPP_DRY_RUN=true, STAFF_ACTIONS_ENABLED=false, STAFF_AUTH_REQUIRED=true, STRIPE_WEBHOOK_SKIP_VERIFY=false, N8N_BLOCK_ENV_ACCESS_IN_NODE=true — all hardcoded in main.bicep.

**What-if command:** prepared and ready in `docs/PHASE-7.3C-AZURE-STAGING-DEPLOYMENT-PREFLIGHT.md §5` and `infra/azure/staging/README.md Phase C`.

**Required manual inputs:** subscription ID, region, resource group name, budget confirmation, DNS provider for lunafrontdesk.com, staging subdomains, Postgres admin password, container image strategy.

**What is still NOT done:** No Azure resources created. No deployment run. No DNS configured. No TLS active. Staging not live. Key Vault secrets not set. Containers not built/pushed. Migrations not applied. Staff users not seeded.

### 7.3d — Azure Staging Deployed + Login Proven (2026-06-01)

**HEAD at proof:** `df475f9`

**Deployment commits (chronological):**
- `4e81a4d` — Deploy Azure staging staff API
- `2be6ef0` — Reduce staging container app scale
- `49e2950` — Wire Redis password for n8n queue mode
- `0118ebc` — Use split Postgres env for n8n
- `abbee49` — Configure n8n public URL
- `df475f9` — Configure n8n proxy hops

**Files changed during deployment:**
- `Dockerfile`, `.dockerignore`, `infra/azure/staging/main.bicep`, `scripts/staff-query-api.js`

**Azure URLs:**
- Staff API/UI: `https://wh-staging-staff-api.braveplant-5c685569.northeurope.azurecontainerapps.io`
- n8n: `https://wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io/home`

**Proof doc:** [`docs/PHASE-7.3D-AZURE-STAGING-DEPLOYMENT-LOGIN-PROOF.md`](PHASE-7.3D-AZURE-STAGING-DEPLOYMENT-LOGIN-PROOF.md)

**Proof results:**
- Staff API live over HTTPS: ✓
- Ty owner login confirmed: ✓
- `/staff/ui` accessible after login: ✓
- `/staff/intents` returns `total: 35`: ✓
- n8n live over HTTPS: ✓
- n8n worker healthy: ✓
- 11 workflows imported, all `active=false`: ✓
- No credentials imported: ✓
- Safety flags confirmed: STAFF_AUTH_REQUIRED=true, STAFF_ACTIONS_ENABLED=false, WHATSAPP_DRY_RUN=true: ✓
- No live WhatsApp, no live Stripe, no webhook POSTs: ✓

**What is still NOT done:** DNS/custom domain not configured. No custom TLS on lunafrontdesk.com. No real login page (first login via API POST). 3 workflows not yet imported. No backup/restore drill. No monitoring/alerting. No Cami/Ale accounts. No pilot approved. No live operation.

### 7.3e — Luna Front Desk Login Page Implemented (2026-06-01)

**HEAD at implementation:** `dc8c86c`

**Files changed:**
- `scripts/staff-query-api.js` — added `buildLoginHtml()`, `handleLoginPage()`, `browserLoginRedirect()`, `GET /staff/login` route, browser redirect for `/staff/ui`, logout button + `doLogout()` in UI
- `scripts/verify-staff-login-ui.js` — new 30-check static verifier
- `package.json` — added `verify:staff-login-ui` script

**Verifier result:** PASS — 30/30 checks green

**Local proof:**
- `GET /staff/login` → 200 HTML; contains "Luna Front Desk", "wolfhouse-somo", "Sign in", "Staging / shadow mode"
- `GET /staff/ui` (auth disabled) → 200 HTML; loads correctly
- `GET /staff/intents` → 200; `total: 35`

**Azure proof (2026-06-02):** PASS — image `wh-staff-api:dc8c86c` built/pushed to ACR (`cb1`); Container App revision `0000002` active; smoke tests over HTTPS all pass (see `docs/PHASE-7.3D-AZURE-STAGING-DEPLOYMENT-LOGIN-PROOF.md §6`). Manual login test script at `scripts/test-azure-login-proof.ps1`.

**What is still NOT done:** DNS/custom domain not configured. No custom TLS on lunafrontdesk.com. 3 workflows not yet imported. No backup/restore drill. No monitoring/alerting. No Cami/Ale accounts. No pilot approved.

### 7.3f — Custom Domain + TLS Bound (2026-06-02)

**DNS provider:** GoDaddy (`lunafrontdesk.com`)

**DNS records added:**
- `CNAME staff-staging` → `wh-staging-staff-api.braveplant-5c685569.northeurope.azurecontainerapps.io`
- `TXT asuid.staff-staging` → `1DEB80678001394FE24D1DE93E59732E3892D2BBD58D753027C21276DB40CE92`

**Azure binding:** `az containerapp hostname bind` with `--validation-method CNAME`; managed cert `mc-wh-staging-env-staff-staging-lu-5595`; `bindingType: SniEnabled`; cert provisioned in ~5 min.

**Final staging URL:** `https://staff-staging.lunafrontdesk.com`

**Smoke tests:** PASS — all checks on clean URL (see `docs/PHASE-7.3F-DNS-CUSTOM-DOMAIN-STAGING.md §4`).

**What is still NOT done:** n8n custom domain not configured. Webhook URL update in workflows not done. 3 workflows not yet imported. No backup/restore drill. No monitoring/alerting. No Cami/Ale accounts. No pilot approved.


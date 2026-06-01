# Stage 7.3d — Azure Staging Deployment + Login Proof

**Status:** DEPLOYMENT PROVEN (2026-06-01) + **7.3e LOGIN PAGE DEPLOYED + AZURE PROOF PASS (2026-06-02)** — Luna Front Desk staging is live on Azure. Staff API, staff UI, and n8n are reachable over HTTPS. Owner login confirmed. Real login page (`/staff/login`) deployed, verified over HTTPS. 11 Wolfhouse workflows imported inactive. All safety flags confirmed. No live WhatsApp. No live Stripe. No production deployment. Not a pilot approval.
**Parent plan:** [`PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md`](PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md) — Workstream C (TLS/deployment).
**Builds on:** [`PHASE-7.3C-AZURE-STAGING-DEPLOYMENT-PREFLIGHT.md`](PHASE-7.3C-AZURE-STAGING-DEPLOYMENT-PREFLIGHT.md) — preflight PASS (2026-06-01).
**IaC:** `infra/azure/staging/main.bicep`
**Runbook:** `infra/azure/staging/README.md`

> **Safety scope.** This document records proof of a staging deployment and first login. It does not approve live operation, pilot begin, WhatsApp live-send, Stripe live keys, workflow activation, or any write-surface use. All dangerous live paths remain disabled by hardcoded safety flags.

---

## 1. Azure URLs

| Service | URL |
|---|---|
| Staff API root | `https://wh-staging-staff-api.braveplant-5c685569.northeurope.azurecontainerapps.io` |
| Staff UI | `https://wh-staging-staff-api.braveplant-5c685569.northeurope.azurecontainerapps.io/staff/ui` |
| n8n editor | `https://wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io/home` |

> DNS/custom domain (`lunafrontdesk.com`) is not yet configured. These are the auto-assigned Azure Container Apps FQDNs.

---

## 2. Staff API / UI proof

### 2.1 Endpoints verified

| Check | Result |
|---|---|
| Root health endpoint (`GET /`) | Returns `{ "status": "ok" }` over HTTPS |
| `GET /staff/ui` — unauthenticated | Requires authentication (login redirect) |
| `POST /staff/auth/login` — Ty owner credentials | 200; session cookie issued over HTTPS |
| `GET /staff/ui` — after login | 200; Luna Front Desk dashboard loads |
| `GET /staff/intents` — after login | 200; returns `total: 35` intents |

### 2.2 Safety flags confirmed (hardcoded in `main.bicep`)

| Flag | Value | Meaning |
|---|---|---|
| `STAFF_AUTH_REQUIRED` | `true` | All staff endpoints require authentication; anonymous access rejected |
| `STAFF_ACTIONS_ENABLED` | `false` | Write endpoints disabled; no booking/bed/handoff mutations permitted |
| `WHATSAPP_DRY_RUN` | `true` | No real WhatsApp sends; all WA paths are dry-run |
| `STAFF_AUTH_HTTPS` | `true` | Session cookies use `Secure` flag |
| `STRIPE_WEBHOOK_SKIP_VERIFY` | `false` | Webhook signature verification always on |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | `true` | n8n Code nodes cannot read raw `$env` |
| `NODE_ENV` | `staging` | Staging mode; local/dev-only paths (operator token) are inactive |

All flags are hardcoded in `infra/azure/staging/main.bicep` — not overridable via parameters. Confirmed PASS during preflight (7.3c, 57/57 scaffold checks).

### 2.3 Login proof

- Login method: `POST /staff/auth/login` with Ty (owner) credentials.
- No real login page yet — first login was performed via direct API POST.
- Session cookie issued over HTTPS after successful login.
- `/staff/ui` accessible after login.
- `/staff/intents` returns `total: 35`.
- Staff write actions remain disabled (`STAFF_ACTIONS_ENABLED=false`).

---

## 3. n8n proof

### 3.1 Service health

| Check | Result |
|---|---|
| `GET /home` at n8n FQDN | 200 over HTTPS; n8n editor loads |
| n8n main Container App | Succeeded; running |
| n8n worker Container App | Succeeded; healthy |
| n8n owner account | Persisted across restarts |
| n8n DB migrations | Completed on first start |
| Latest n8n logs | Clean (no error lines) |

### 3.2 Workflow import

| Check | Result |
|---|---|
| Workflows imported | 11 Wolfhouse workflows |
| All imported workflows active | No — all `active=false` |
| Credentials imported | No |
| Production credentials present | No |
| Live WhatsApp enabled | No |
| Live Stripe enabled | No |
| Webhook POSTs run | No |

### 3.3 Workflows imported (inactive)

The following 11 workflows were imported to staging n8n manually as inactive:

| Source file | Status |
|---|---|
| `n8n/phase2/Wolfhouse - Booking Flow Router.json` | Imported, `active=false` |
| `n8n/phase2/Wolfhouse - Main (local Stripe).json` | Imported, `active=false` |
| `n8n/phase2/Wolfhouse - Hold Booking.json` | Imported, `active=false` |
| `n8n/phase2/Wolfhouse - Ensure Booking.json` | Imported, `active=false` |
| `n8n/phase2/Wolfhouse - Create Payment Session.json` | Imported (fixed-import wrapper used; source had missing `id`), `active=false` |
| `n8n/phase2/Wolfhouse - Stripe Checkout Success.json` | Imported, `active=false` |
| `n8n/phase2/Wolfhouse - Stripe Webhook Handler.json` | Imported (fixed-import wrapper used; source had missing `id`), `active=false` |
| `n8n/phase2/Wolfhouse - Send Confirmation.json` | Imported, `active=false` |
| `n8n/phase2/Wolfhouse - Cancel Booking.json` | Imported, `active=false` |
| `n8n/phase2/Wolfhouse - Assign Beds.json` | Imported, `active=false` |
| `n8n/phase3b/Wolfhouse - Reassign Beds.json` | Imported, `active=false` |

### 3.4 Workflows not yet imported (3 remaining)

The following 3 source workflows were not imported because they are active/source files that would violate the inactive-only import guardrail unless cloned or converted to inactive staging-safe form first:

| File | Reason not imported |
|---|---|
| `n8n/phase2/Wolfhouse Booking Assistant - Return Conversation To Bot.json` | Active source workflow; requires inactive-conversion before safe import |
| `n8n/phase2/Wolfhouse Booking Assistant - Send Staff Reply.json` | Active source workflow; requires inactive-conversion before safe import |
| `n8n/Wolfhouse - Sync Planning Sheet.json` | Active source workflow; requires inactive-conversion before safe import |

These will be addressed in Stage 7.3g (remaining inactive workflow conversion/import).

---

## 4. Container Apps

| App | Status | Scale |
|---|---|---|
| `wh-staging-staff-api` | Succeeded | min 0 / max 1 |
| `wh-staging-n8n-main` | Succeeded | min 0 / max 1 |
| `wh-staging-n8n-worker` | Succeeded | min 0 / max 1 |

**Container Apps environment:** `wh-staging-env`, North Europe.

> Note: Container Apps environment is in North Europe while several backing resources (Postgres, Redis) are in West Europe. This cross-region placement was accepted for staging. Production should use a consistent region.

---

## 5. Deployment commits

The following commits were created during the Azure staging deployment:

| Commit | Message |
|---|---|
| `4e81a4d` | Deploy Azure staging staff API |
| `2be6ef0` | Reduce staging container app scale |
| `49e2950` | Wire Redis password for n8n queue mode |
| `0118ebc` | Use split Postgres env for n8n |
| `abbee49` | Configure n8n public URL |
| `df475f9` | Configure n8n proxy hops |

**Files changed during Azure deployment:**
- `Dockerfile`
- `.dockerignore`
- `infra/azure/staging/main.bicep`
- `scripts/staff-query-api.js`

---

## 6. Remaining issues / open gates

### 6.1 Infrastructure

| Issue | Status |
|---|---|
| DNS/custom domain not configured (`lunafrontdesk.com`) | NOT_STARTED — Azure FQDN only |
| Custom TLS on `staff-staging.lunafrontdesk.com` | NOT_STARTED — no CNAME, no managed cert bound |
| Container Apps env (North Europe) vs backing resources (West Europe) | Known; acceptable for staging |
| Real login page | DONE — Stage 7.3e: `GET /staff/login` serves Luna Front Desk branded form; browser redirect from `/staff/ui` |

### 6.2 Workflows

| Issue | Status |
|---|---|
| 3 remaining workflows not imported | NOT_STARTED — active source files; Stage 7.3g |
| No credentials imported into n8n | By design — no credentials until pilot gate |
| All workflows remain inactive | CONFIRMED — by design |

### 6.3 Safety gates still closed

| Gate | Status |
|---|---|
| No live WhatsApp | CONFIRMED CLOSED — `WHATSAPP_DRY_RUN=true` |
| No live Stripe | CONFIRMED CLOSED — no `sk_live_*` present |
| Staff write actions disabled | CONFIRMED CLOSED — `STAFF_ACTIONS_ENABLED=false` |
| No webhook POSTs run | CONFIRMED |
| No production credentials | CONFIRMED |
| Durable audit log not yet verified | NOT_STARTED |
| Backup/restore drill | NOT_STARTED |
| Monitoring/alerting | NOT_STARTED |

### 6.4 Pilot readiness gates still closed (final pilot decision: NO_GO)

| Gate | Status |
|---|---|
| Cami account created + first login | NOT_STARTED |
| Ale account created + first login | NOT_STARTED |
| Cami training completed | NOT_STARTED |
| Ale sign-off on config/prices | NOT_STARTED |
| Backup/restore drill documented | NOT_STARTED |
| Monitoring/alerting wired | NOT_STARTED |
| DNS/custom domain on lunafrontdesk.com | NOT_STARTED |
| n8n webhook URL points to staging HTTPS host | NOT_STARTED |
| Stripe test-mode checkout end-to-end in staging | NOT_STARTED |
| Real WhatsApp webhook registered | NOT_STARTED |

---

## 7. Next recommended stages

| Order | Stage | Description |
|---|---|---|
| A | **Stage 7.3e** | Add real staff login page for Azure `/staff/ui` (replaces API-POST first login) |
| B | **Stage 7.3f** | DNS/custom domain plan for `staff-staging.lunafrontdesk.com` |
| C | **Stage 7.4c** | Staging backup/restore drill |
| D | **Stage 7.5c** | Monitoring/alerting setup (Azure Monitor alert rules) |
| E | **Stage 7.3g** | Remaining inactive workflow conversion/import (3 workflows) |
| F | **Stage 7.7p** | Targeted UI cleanup/polish based on hosted UI feedback |

---

## 8. Implementation log

### 7.3d — Azure Staging Deployment + Login Proof (2026-06-01)

**HEAD at proof:** `df475f9`

**Deployment commits (chronological):**
- `4e81a4d` — Deploy Azure staging staff API
- `2be6ef0` — Reduce staging container app scale
- `49e2950` — Wire Redis password for n8n queue mode
- `0118ebc` — Use split Postgres env for n8n
- `abbee49` — Configure n8n public URL
- `df475f9` — Configure n8n proxy hops

**Proof result:**
- Staff API live over HTTPS: ✓
- Staff UI accessible after login: ✓
- Ty owner login works: ✓
- `/staff/intents` returns `total: 35`: ✓
- n8n live over HTTPS: ✓
- n8n worker healthy: ✓
- 11 workflows imported inactive: ✓
- All safety flags confirmed: ✓
- No credentials imported: ✓
- No live WhatsApp: ✓
- No live Stripe: ✓
- No webhook POSTs run: ✓
- Logs clean: ✓

**What is still NOT done:**
- No DNS/custom domain configured.
- No custom TLS on lunafrontdesk.com.
- Real login page deployed (7.3e Azure proof PASS — see §6 below).
- 3 workflows not yet imported.
- No credentials in n8n.
- No backup/restore drill.
- No monitoring/alerting wired.
- No Cami/Ale accounts.
- No pilot approved.
- No live operation.
- No production deployment.

---

## 6. Stage 7.3e — Login Page Azure Proof (2026-06-02)

### 6.1 Deployment

| Item | Value |
|---|---|
| Image tag deployed | `whstagingacr.azurecr.io/wh-staff-api:dc8c86c` |
| ACR build ID | `cb1` |
| Container App revision | `wh-staging-staff-api--0000002` |
| Provision state | `Succeeded` |
| Build command | `az acr build --registry whstagingacr --image wh-staff-api:dc8c86c --image wh-staff-api:latest --file Dockerfile .` |
| Update command | `az containerapp update ... --image whstagingacr.azurecr.io/wh-staff-api:dc8c86c` |

### 6.2 Safety flags (confirmed unchanged after deploy)

| Flag | Value |
|---|---|
| `STAFF_AUTH_REQUIRED` | `true` |
| `STAFF_ACTIONS_ENABLED` | `false` |
| `WHATSAPP_DRY_RUN` | `true` |
| `STRIPE_WEBHOOK_SKIP_VERIFY` | `false` |

### 6.3 Smoke tests — automated (unauthenticated)

| Check | Result |
|---|---|
| `GET /` → `{"status":"ok"}` | PASS (HTTP 200) |
| `GET /staff/login` → HTTP 200 HTML | PASS |
| `GET /staff/login` contains "Luna Front Desk" | PASS |
| `GET /staff/login` contains "Staff sign in" | PASS |
| `GET /staff/login` contains "wolfhouse-somo" | PASS |
| `GET /staff/login` contains "Staging / shadow mode" | PASS |
| `GET /staff/login` contains "Staff actions disabled" | PASS |
| `GET /staff/ui` (unauthenticated) → redirects to `/staff/login` | PASS (302 → 200 login page) |
| `GET /staff/intents` (unauthenticated) → 401 | PASS |

### 6.4 Smoke tests — manual login (requires interactive input)

Run `scripts/test-azure-login-proof.ps1` with Ty credentials to verify:
- `POST /staff/auth/login` → 200 + session cookie
- `GET /staff/ui` authenticated → 200 with Luna Front Desk UI + Sign out button
- `GET /staff/intents` authenticated → `total: 35`
- `POST /staff/auth/logout` → 200

### 6.5 n8n — unchanged

- n8n Container Apps untouched
- No workflow imports
- No workflow activations
- No credentials changed

### 6.6 What is still NOT done after 7.3e Azure proof

- DNS/custom domain not configured.
- No custom TLS on lunafrontdesk.com.
- 3 workflows not yet imported.
- No credentials in n8n.
- No backup/restore drill.
- No monitoring/alerting.
- No Cami/Ale accounts.
- No pilot approved.
- No live operation.

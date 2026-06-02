# Stage 7.3f — DNS + Custom Domain Binding (Staging)

**Status:** DONE (2026-06-02) — `staff-staging.lunafrontdesk.com` bound to Azure Container App with Azure managed TLS certificate. All smoke tests PASS over HTTPS on clean URL.
**Parent plan:** [`PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md`](PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md) — Workstream C (TLS/deployment).
**Builds on:** [`PHASE-7.3D-AZURE-STAGING-DEPLOYMENT-LOGIN-PROOF.md`](PHASE-7.3D-AZURE-STAGING-DEPLOYMENT-LOGIN-PROOF.md) — Staff API deployed and login proven.

> **Safety scope.** This document records DNS binding and TLS setup for the staging environment only. It does not approve live operation, pilot begin, WhatsApp live-send, Stripe live keys, workflow activation, or any write-surface use. All dangerous live paths remain disabled by hardcoded safety flags.

---

## 1. URLs

| Service | URL |
|---|---|
| **Custom domain (new)** | `https://staff-staging.lunafrontdesk.com` |
| Azure default FQDN (still active) | `https://wh-staging-staff-api.braveplant-5c685569.northeurope.azurecontainerapps.io` |
| n8n editor | `https://wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io/home` |

---

## 2. DNS records

| DNS provider | GoDaddy (`lunafrontdesk.com`) |
|---|---|
| **CNAME** name | `staff-staging` |
| **CNAME** value | `wh-staging-staff-api.braveplant-5c685569.northeurope.azurecontainerapps.io` |
| **TXT** name | `asuid.staff-staging` |
| **TXT** value | `1DEB80678001394FE24D1DE93E59732E3892D2BBD58D753027C21276DB40CE92` |

Both records verified via authoritative nameserver (`ns48.domaincontrol.com`) and via Google Public DNS (8.8.8.8).

---

## 3. Azure binding

| Item | Value |
|---|---|
| Container App | `wh-staging-staff-api` |
| Resource group | `wh-staging-rg` |
| Environment | `wh-staging-env` |
| Hostname | `staff-staging.lunafrontdesk.com` |
| Binding type | `SniEnabled` |
| Managed certificate | `mc-wh-staging-env-staff-staging-lu-5595` |
| Certificate subject | `staff-staging.lunafrontdesk.com` |
| Certificate provisioning | `Succeeded` |
| Validation method | `CNAME` |
| Azure CLI command | `az containerapp hostname bind --hostname staff-staging.lunafrontdesk.com --name wh-staging-staff-api --resource-group wh-staging-rg --environment wh-staging-env --validation-method CNAME` |

---

## 4. Smoke tests

All tests run against `https://staff-staging.lunafrontdesk.com`.

| Check | Result |
|---|---|
| `GET /` → `{"status":"ok"}` | PASS (HTTP 200) |
| `GET /staff/login` → HTTP 200 HTML | PASS |
| Contains "Luna Front Desk" | PASS |
| Contains "Staff sign in" | PASS |
| Contains "wolfhouse-somo" | PASS |
| Contains "Staging / shadow mode" | PASS |
| Contains "Staff actions disabled" | PASS |
| Contains "Company" (wording fix) | PASS |
| `GET /staff/ui` (unauth) → redirects to `/staff/login` | PASS |
| `GET /staff/intents` (unauth) → 401 | PASS |

### Manual login proof

Run `scripts/test-azure-login-proof.ps1` (update `$base` to `https://staff-staging.lunafrontdesk.com`) to verify:
- `POST /staff/auth/login` → 200 + session cookie
- `GET /staff/ui` authenticated → 200 with Luna Front Desk UI + Sign out
- `GET /staff/intents` → `total: 35`
- `POST /staff/auth/logout` → 200, redirects to `/staff/login`
- After logout, `GET /staff/ui` → redirect to `/staff/login` (session revoked)

---

## 5. Safety flags (unchanged)

| Flag | Value |
|---|---|
| `STAFF_AUTH_REQUIRED` | `true` |
| `STAFF_ACTIONS_ENABLED` | `false` |
| `WHATSAPP_DRY_RUN` | `true` |
| `STRIPE_WEBHOOK_SKIP_VERIFY` | `false` |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | `true` |

---

## 6. n8n — unchanged

- n8n Container Apps untouched.
- No workflow imports.
- No workflow activations.
- No credentials configured.
- n8n still only reachable at Azure default FQDN — no custom domain for n8n yet.

---

## 7. Gates still closed

| Gate | Status |
|---|---|
| Production DNS (`lunafrontdesk.com` apex / `www`) | NOT configured |
| n8n custom domain | NOT configured |
| Webhook URL update in n8n workflows | NOT done |
| Live WhatsApp | NOT enabled |
| Live Stripe | NOT enabled |
| Staff write actions | NOT enabled |
| Workflow activation | NOT done |
| Cami/Ale staff accounts | NOT created |
| Backup/restore drill | NOT done |
| Monitoring/alerting | NOT wired |
| Pilot approval | NOT given |

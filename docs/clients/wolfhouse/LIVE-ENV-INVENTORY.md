# Wolfhouse — Live Environment Inventory

Client: `wolfhouse` · Location: `wolfhouse-somo` · Region: **northeurope**

> **Names and placeholders only — never put secret values in this file.**
> This is the concrete *planned* inventory for Wolfhouse live: the resource/secret
> *names* and *hostnames*, plus a status for each. Actual secret values live in Key
> Vault / the runtime env, never in git. See `docs/MULTICLIENT-ARCHITECTURE.md`,
> `docs/clients/wolfhouse/GO-LIVE-CHECKLIST.md`, `LIVE-CUTOVER-RUNBOOK.md`.

Live model (early): **separate runtime + env + secrets + database per client**,
shared code/image. Naming follows the existing `wh-staging-*` convention, swapping
`staging` → `prod`.

**Status legend:**
- **existing** — already provisioned (today, for staging or shared use).
- **proposed** — planned name suggested here; confirm before creating.
- **required-before-live** — must exist/be set before flipping `live_enabled`.
- **operator-provided** — a real value an operator supplies at provisioning (never committed).

## 1. Azure compute / hosting

| Item | Planned name | Status |
|------|--------------|--------|
| Azure region | `northeurope` | proposed |
| Resource group | `wh-prod-rg` | proposed |
| Container Apps environment | `wh-prod-env` | proposed |
| Staff API app | `wh-prod-staff-api` | proposed |
| Hermes/Luna app/container | `wh-prod-hermes` | proposed |
| Container registry (ACR) | `whstagingacr` (shared) **or** `whprodacr` | proposed — decide reuse-shared vs create-prod (do **not** create here) |
| Release image tag | `wh-staff-api:<git-sha>` / `wh-hermes:<git-sha>` | required-before-live — built from clean `master` |

> **ACR decision (open):** staging uses the shared `whstagingacr`. For live, either
> (a) reuse `whstagingacr` as a shared immutable-tag registry, or (b) create a
> dedicated `whprodacr`. Not created in this branch — flagged for operator decision.

## 2. Database

| Item | Planned name | Status |
|------|--------------|--------|
| Postgres server strategy | dedicated prod server `wh-prod-pg` (isolated; not the staging `wh-staging-pg-app`) | proposed |
| Database name | `wolfhouse_prod` | proposed |
| DB host | resolved from `wh-prod-pg` | required-before-live |
| DB user secret name | `wolfhouse-prod-db-user` | required-before-live (value operator-provided) |
| DB password secret name | `wolfhouse-prod-db-password` | required-before-live (value operator-provided) |
| DB connection URL secret name | `wolfhouse-prod-database-url` | required-before-live (value operator-provided) |

> Strategy note: live DB is isolated per client (no cross-client rows, no shared
> connection string). Locations live inside this DB, tagged by `location_id`.

## 3. Staff API / portal

| Item | Planned name | Status |
|------|--------------|--------|
| Staff portal hostname | `staff.lunafrontdesk.com` (prod; cf. staging `staff-staging.lunafrontdesk.com`) | proposed |
| Staff API hostname | `wh-prod-staff-api.<region>.azurecontainerapps.io` (fronted by the portal host) | proposed |
| Staff API base URL | `https://staff.lunafrontdesk.com` | proposed |
| Default client env | `DEFAULT_CLIENT=wolfhouse-somo` | required-before-live (env name only) |
| Bot internal token secret name | `luna-bot-internal-token` | required-before-live (value operator-provided) |
| Staff admin session secret name | `wolfhouse-staff-session-secret` | required-before-live (value operator-provided) |
| Staff admin auth allowlist | `staff-portal-access.json` (real Wolfhouse owner/admin emails) | required-before-live |

## 4. WhatsApp (Meta Cloud API)

| Item | Planned name / label | Status |
|------|----------------------|--------|
| WhatsApp phone number | label `WOLFHOUSE_LIVE_WA_NUMBER` (E.164) | operator-provided |
| WhatsApp `phone_number_id` secret name | `wolfhouse-whatsapp-phone-number-id` | required-before-live (value operator-provided) |
| WhatsApp access token secret name | `wolfhouse-whatsapp-access-token` | required-before-live (value operator-provided) |
| Meta app secret name | `wolfhouse-meta-app-secret` | required-before-live (value operator-provided) |
| Meta webhook verify token secret name | `wolfhouse-meta-verify-token` | required-before-live (value operator-provided) |
| Hermes webhook hostname | `hermes.lunafrontdesk.com` (path `/whatsapp/webhook`; cf. staging `lunabox.lunafrontdesk.com`) | proposed |
| Live webhook URL | `https://hermes.lunafrontdesk.com/whatsapp/webhook` | required-before-live — set in Meta only at approved cutover |
| Routing | `phone_number_id → client_slug=wolfhouse` | required-before-live |

## 5. Stripe (live context)

| Item | Planned name | Status |
|------|--------------|--------|
| Stripe live secret key secret name | `wolfhouse-stripe-secret-key` | required-before-live (value operator-provided; Wolfhouse's own account) |
| Stripe webhook signing secret name | `wolfhouse-stripe-webhook-secret` | required-before-live (value operator-provided) |
| Stripe webhook endpoint | `https://staff.lunafrontdesk.com/stripe/webhook` | required-before-live — no shared default |

## 6. Key Vault / secret store

| Item | Planned name | Status |
|------|--------------|--------|
| Key Vault | `wh-prod-kv` (cf. staging `wh-staging-kv`) | existing (created in shell apply; RBAC-enabled) |

> **Key Vault rejects underscores in secret names — names are hyphenated.** The
> vault is RBAC-enabled: the operator must hold **Key Vault Secrets Officer** on
> `wh-prod-kv` before setting values. See `PROD-INFRA-PLAN.md` → Post-apply fixes.

Required secret **names** (all stored in `wh-prod-kv`; values operator-provided, never committed):

- `wolfhouse-prod-db-user`
- `wolfhouse-prod-db-password`
- `wolfhouse-prod-database-url`
- `luna-bot-internal-token`
- `wolfhouse-staff-session-secret`
- `wolfhouse-whatsapp-phone-number-id`
- `wolfhouse-whatsapp-access-token`
- `wolfhouse-meta-app-secret`
- `wolfhouse-meta-verify-token`
- `wolfhouse-stripe-secret-key`
- `wolfhouse-stripe-webhook-secret`

## 7. DNS / hostname requirements

| Item | Planned value | Status |
|------|---------------|--------|
| Staff portal DNS | `staff.lunafrontdesk.com` → Wolfhouse prod Staff API (TLS valid) | required-before-live |
| Hermes webhook DNS | `hermes.lunafrontdesk.com` → Wolfhouse prod Hermes (TLS valid) | required-before-live |
| Public HTTPS reachability | Meta + Stripe webhook hosts reachable publicly over HTTPS | required-before-live |
| Host isolation | Wolfhouse-specific hosts; no shared host serving multiple live clients | required-before-live |

## 8. Monitoring / logging

| Item | Planned name | Status |
|------|--------------|--------|
| Log Analytics workspace | `wh-prod-logs` | proposed |
| Health monitoring | `GET /` + key `GET /staff/*` return 200; Hermes liveness | required-before-live |
| Webhook delivery alerts | Meta + Stripe delivery-failure alerts to operator | required-before-live |
| Error-rate alert | 5xx / error-rate alert on Staff API | required-before-live |
| On-call operator | named operator receives alerts | operator-provided |

## 9. Rollback reference

| Item | Planned value | Status |
|------|---------------|--------|
| Previous known-good image tag | recorded at cutover | required-before-live |
| Previous Meta webhook target | `lunabox.lunafrontdesk.com/whatsapp/webhook` (or prior prod target) | required-before-live — restore on rollback |

See `LIVE-ROLLBACK-RUNBOOK.md` for the rollback procedure.

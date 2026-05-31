# Stage 7.1 — Environment and Secrets Inventory

**Status:** PLANNING / INVENTORY DONE (2026-05-31). No implementation; no secrets changed.
**Parent plan:** [`PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md`](PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md) — Workstream A (environment separation), C (TLS/deployment), and part of B (auth).
**Scope:** Enumerate every env var, secret, integration key, URL, and workflow-specific setting across local, staging, and production. Define the local → staging → production separation model. No live keys modified. `.env` files never committed.

> **Security note:** This document contains only placeholder names and allowed-value descriptions — never real secrets, tokens, or passwords.

---

## Environment model (local / staging / production)

Three isolated environments. No shared database, no shared workflow state, no shared API keys across environments.

| Environment | Purpose | Data | Workflows | Stripe | WhatsApp |
|---|---|---|---|---|---|
| **local** | Developer machines; fixture gates; safe CLI/API proof | Dev/fixture data only | Inactive by default; activated per approved test | `sk_test_*` only | `WHATSAPP_DRY_RUN=true` |
| **staging** | Pilot preparation; integration testing; staff training | Realistic dummy or anonymised data | Inactive by default; one pilot workflow active only after Stage 7.6 gate | `sk_test_*` only; **never** live key | `WHATSAPP_DRY_RUN=true` until Stage 7.8 gate passes |
| **production** | Live Wolfhouse pilot | Real guest data | Approved pilot workflow(s) only; all others inactive | `sk_live_*` only after Stage 7.9 gate | `WHATSAPP_DRY_RUN=false` only after Stage 7.8 gate |

---

## A. Database env vars

| Var | Description | Local example | Staging | Production | Secret? |
|---|---|---|---|---|---|
| `WOLFHOUSE_DATABASE_URL` | Full Postgres connection URL (takes precedence over components) | `postgres://wolfhouse:…@localhost:5433/wolfhouse` | Managed DB URL | Managed DB URL | **Yes** — injected at deploy; never committed |
| `WOLFHOUSE_DB_USER` | App DB username | `wolfhouse` | `wolfhouse_staging` | `wolfhouse_prod` | No |
| `WOLFHOUSE_DB_PASSWORD` | App DB password | dev placeholder | rotate per-env | rotate per-env | **Yes** |
| `WOLFHOUSE_DB_NAME` | App DB name | `wolfhouse` | `wolfhouse_staging` | `wolfhouse` | No |
| `WOLFHOUSE_DB_PORT` | App DB port | `5433` (Docker mapped) | `5432` | `5432` | No |
| `N8N_DB_USER` | n8n internal DB user | `n8n` | `n8n_staging` | `n8n_prod` | No |
| `N8N_DB_PASSWORD` | n8n internal DB password | dev placeholder | rotate per-env | rotate per-env | **Yes** |
| `N8N_DB_NAME` | n8n internal DB name | `n8n` | `n8n_staging` | `n8n` | No |
| `N8N_DB_PORT` | n8n internal DB port | `5434` (Docker mapped) | `5432` | `5432` | No |

**Production rules:**
- Each environment must have its own Postgres instance. No shared DB.
- `WOLFHOUSE_DATABASE_URL` injected from secrets manager; never in `.env` file in staging/production.
- `WOLFHOUSE_DB_PASSWORD` rotated on first deploy and periodically. Emergency revoke plan: change DB user password + restart app.

---

## B. n8n env vars

| Var | Description | Local | Staging | Production | Secret? |
|---|---|---|---|---|---|
| `N8N_PORT` | n8n web/API port | `5678` | `5678` (behind HTTPS proxy) | `5678` (behind HTTPS proxy) | No |
| `N8N_HOST` | n8n host (used for webhook URL construction) | `localhost` | staging subdomain | production subdomain | No |
| `N8N_WEBHOOK_URL` | Public base URL for incoming webhooks | `http://localhost:5678/` | `https://hooks.staging.<domain>/` | `https://hooks.<domain>/` | No |
| `N8N_PROTOCOL` | `http` (local) or `https` (staging/prod behind proxy) | `http` | `https` | `https` | No |
| `N8N_ENCRYPTION_KEY` | n8n credential encryption key — must be ≥ 32 chars | dev placeholder (`change-me-32-char-minimum-key!!`) | unique random ≥ 32 chars | unique random ≥ 32 chars | **Yes** — loss = all n8n credentials unreadable |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | Allow code nodes to read `$env` | `false` (local only) | `true` (block) | `true` (block) | No |
| `NODE_FUNCTION_ALLOW_BUILTIN` | Allow `crypto` in Code nodes | `crypto` | `crypto` (if needed) | `crypto` (if needed) | No |
| `GENERIC_TIMEZONE` | n8n timezone | `Europe/Madrid` | `Europe/Madrid` | `Europe/Madrid` | No |
| `REDIS_PORT` | Redis port (queue mode) | `6379` | `6379` | `6379` | No |

**Workflow policy** (not an env var but a deployment rule):
- All workflows **inactive by default** on first deploy to any environment.
- Activate only via explicit approval; document which workflow is active, when, and for what test.
- Workflow IDs are environment-specific (n8n assigns IDs on import); do not hardcode IDs in docs.

**Production rules:**
- `N8N_ENCRYPTION_KEY` must be set before first launch; changing it invalidates stored credentials.
- `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` in staging/production (Code nodes must not read raw secrets).
- `N8N_HOST` and `N8N_WEBHOOK_URL` must match the actual domain/subdomain where webhooks are publicly reachable.

---

## C. WhatsApp / Meta

| Var | Description | Local | Staging | Production | Secret? |
|---|---|---|---|---|---|
| `WHATSAPP_DRY_RUN` | `true` = log only, no real Graph API send | `true` (always) | `true` (default; `false` only after Stage 7.8 gate) | `false` only after Stage 7.8 gate; `true` default | No (flag) |
| `WHATSAPP_ACCESS_TOKEN` | Meta Graph API access token | empty | test token (approved test number only) | live token | **Yes** |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Business phone number ID | empty | test number ID | live number ID | **Yes** |
| `WHATSAPP_APP_SECRET` | Meta app secret (for webhook signature verification) | not required locally | required in staging | required in production | **Yes** |
| `WHATSAPP_VERIFY_TOKEN` | Meta webhook verification token | not required locally | required if webhook registered | required | **Yes** |

**Local vs live number:**
- Local and staging must use a **test/sandbox phone number** (or no real number at all with `DRY_RUN=true`).
- The real Wolfhouse WhatsApp Business number is used **only** in production after Stage 7.8 gate.

**Production rules:**
- `WHATSAPP_DRY_RUN` must be explicitly set `false` for live sends; the default in `docker-compose.local.yml` is `true` and this must be preserved.
- Never commit real WhatsApp tokens; inject from secrets manager.
- Live number switch requires owner (Ale/Cami) approval and Stage 7y shadow-mode soak first.

---

## D. Stripe

| Var | Description | Local | Staging | Production | Secret? |
|---|---|---|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe API secret key | `sk_test_*` | `sk_test_*` only | `sk_live_*` only after Stage 7.9 gate | **Yes** |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key (if frontend needed) | `pk_test_*` | `pk_test_*` | `pk_live_*` after Stage 7.9 gate | No (public) |
| `STRIPE_WEBHOOK_SECRET` | Webhook endpoint secret (`whsec_*`) | test webhook secret | test webhook secret | live webhook secret | **Yes** |
| `STRIPE_WEBHOOK_SKIP_VERIFY` | `true` skips signature verification (local isolated tests only) | `false` (default); `true` only in isolated test scripts | `false` always | `false` always | No |
| `STRIPE_DEFAULT_DEPOSIT_CENTS` | Default deposit amount in cents | `20000` (€200) | same as production config | per client config (€200 standard, €100 custom) | No |
| `STRIPE_CHECKOUT_SUCCESS_URL` | Redirect URL after successful Stripe checkout | `http://localhost:5678/...` | `https://hooks.staging.<domain>/...` | `https://hooks.<domain>/...` | No |
| `STRIPE_CHECKOUT_CANCEL_URL` | Redirect URL on checkout cancel | `https://www.wolf-house.com/surfcampsomo` | same | same | No |
| `USE_STRIPE_CHECKOUT` | Enable Stripe Checkout flow | `true` | `true` | `true` | No |
| `N8N_CREATE_PAYMENT_SESSION_URL` | Internal webhook URL for Create Payment Session workflow | `http://localhost:5678/webhook/create-payment-session` | staging URL | production URL | No |

**Production rules:**
- `STRIPE_WEBHOOK_SKIP_VERIFY=false` is **mandatory** in staging and production. No exceptions.
- `sk_live_*` keys must never appear in local or staging `.env` files.
- Stripe live key activation requires Stage 7.9 gate (test-mode soak + webhook idempotency proven + owner approval).
- Deposit amounts must be confirmed `pricing_status=confirmed` in `wolfhouse-somo.baseline.json` before live charge.

---

## E. Staff API / UI

| Var | Description | Local | Staging | Production | Secret? |
|---|---|---|---|---|---|
| `STAFF_QUERY_API_PORT` | Port for staff query HTTP server | `3036` | `3036` (behind HTTPS proxy in staging) | `3036` (behind HTTPS proxy) | No |
| `STAFF_ACTIONS_ENABLED` | Enables POST write endpoints | `true` only during fixture gates | `false` (default) | `false` until Stage 7.2 auth + TLS complete | No (flag) |
| `STAFF_OPERATOR_TOKEN` | Local/dev single operator token (not production auth) | `test-operator-token` (dev only) | unused (should not be set until real auth replaces it) | **not used** — replaced by production auth (Stage 7.2) | **Yes** (local) / deprecated before prod |
| *(future)* `STAFF_JWT_SECRET` | JWT signing secret for production staff auth | n/a | staging rotation | production rotation | **Yes** |
| *(future)* `STAFF_SESSION_SECRET` | Session signing secret | n/a | staging rotation | production rotation | **Yes** |

**Production rules:**
- `STAFF_OPERATOR_TOKEN` is explicitly **local/dev only**. It must not be set or used in production. It will be deprecated when Stage 7.2 production auth is built.
- `STAFF_ACTIONS_ENABLED=false` is the default. Enable only after production auth + TLS are in place (Stage 7.2 + 7.3 gates).
- Staff API must be behind TLS in staging/production; direct HTTP is local/dev only.

---

## F. Client config (not env vars — file-based)

These are configured in `config/clients/wolfhouse-somo.baseline.json` (committed, no secrets) and `config/clients/wolfhouse-somo.secrets.json` (gitignored, contains real numbers).

| Config key / secret | Source | Status | Production gate |
|---|---|---|---|
| `client_slug` | baseline.json `_meta.client_slug` | `wolfhouse-somo` confirmed | — |
| `assistant_name` | baseline.json | `Luna` | — |
| `packages` / `catalog` / `prices` | baseline.json `pricing_policy.global_pricing_status` | **provisional** — safe for dry-run/shadow only | `pricing_status=confirmed` required before live autonomous charge |
| `deposit_rule` (€200 / €100 tiers) | baseline.json `payment.deposit_rule` | provisional | owner sign-off → `confirmed` |
| `closed_months` | baseline.json `property` | confirmed | — |
| `check_in_time`, `check_out_time` | baseline.json `property` | confirmed | — |
| `add-ons` / `service_catalog` | baseline.json `service_addons` | provisional | owner sign-off |
| `cancellation` / `refund_policy` | baseline.json `cancellation` | partially confirmed | owner sign-off before live |
| `handoff_whatsapp_phone` | **secrets.json** (gitignored) | secret | must be verified number |
| `master_admin_numbers` | **secrets.json** (gitignored) | secret | confirmed with Ale/Cami |
| `staff_admin_password` | **secrets.json** (gitignored) | secret | rotate before production |

**Production rule:** All `pricing_status=provisional` items must be flipped to `confirmed` by Ale/Cami before any live autonomous charge. The onboarding checklist (Stage 7.6 / workstream M) is the gate.

---

## G. Airtable / Google Sheets (transitional bridge)

| Var / config | Description | Status | Cutover plan |
|---|---|---|---|
| `AIRTABLE_API_TOKEN` | Airtable personal access token | In use — dual-write bridge | Remove after Airtable cutover gate (Stage 7.10) |
| `AIRTABLE_BASE_ID` | Airtable base ID (`appOCWIN47Bui9CSS`) | In use | Remove at cutover |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | Planning workbook ID | Local planning only | Not needed in production |
| `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` | Service account credentials | Optional; local only | Not in production unless explicitly needed |
| `N8N_WEBHOOK_SHARED_SECRET` | Apps Script → n8n webhook shared header secret | In use | Rotate before production; remove if Apps Script bridge removed |

**Transitional note:** Airtable env vars remain valid until Stage 7.10 cutover gate. After cutover, remove from production `.env` and deactivate related n8n nodes. Do not deepen Airtable dependency.

---

## H. Logging / audit / monitoring

| Var / path | Description | Local | Staging/Production |
|---|---|---|---|
| `logs/staff-query-log.jsonl` | Staff query/action audit log (current) | Local file | Must be promoted to durable storage (DB table or managed log service) in staging/production — not a local file |
| *(future)* `AUDIT_LOG_TABLE` or `AUDIT_LOG_DSN` | Connection for durable audit log backend | n/a | Required before pilot |
| *(future)* `ALERT_WEBHOOK_URL` | Alerting destination (Slack/PagerDuty/email) | n/a | Required for monitoring (Stage 7.5) |
| *(future)* `ERROR_CAPTURE_DSN` | Sentry / equivalent error capture | n/a | Recommended for production |
| `PHASE2F_LOG_WORKFLOW_EVENTS` | Optional resolver audit logging | `false` default | `false` (non-blocking; enable if debugging needed) |
| `STAGE52_FIXTURE_HOLD` | Fixture gate flag — hold guard | `false` default | `false` always in non-fixture environments |
| `STAGE53_FIXTURE_PAYMENT` | Fixture gate flag — payment guard | `false` default | `false` always in non-fixture environments |

---

## I. URLs / domains

| Setting | Local | Staging | Production |
|---|---|---|---|
| Staff API/UI URL | `http://127.0.0.1:3036` | `https://staff.staging.<domain>` | `https://staff.<domain>` |
| n8n web UI URL | `http://localhost:5678` | `https://n8n.staging.<domain>` | `https://n8n.<domain>` |
| n8n webhook base URL | `http://localhost:5678/webhook/` | `https://hooks.staging.<domain>/webhook/` | `https://hooks.<domain>/webhook/` |
| WhatsApp webhook URL | n/a (dry-run) | `https://hooks.staging.<domain>/webhook/whatsapp` | `https://hooks.<domain>/webhook/whatsapp` |
| Stripe webhook URL | `http://localhost:5678/webhook/stripe-checkout-success` | staging URL | production URL |
| Public domain(s) | n/a | TBD — separate subdomain per service recommended | TBD |

**Production rule:** Public webhook URLs for WhatsApp and Stripe must be HTTPS, routable from the internet, and must match the `N8N_WEBHOOK_URL` configured in n8n. A mismatch causes all inbound webhooks to fail silently.

---

## Environment separation table (key settings)

| Setting | Local/dev | Staging | Production | Owner | Secret? | Production rule |
|---|---|---|---|---|---|---|
| `WHATSAPP_DRY_RUN` | `true` | `true` until Stage 7.8 gate | `false` only after Stage 7.8 gate + owner approval | Ale/Cami | No | Default `true`; only disable after explicit gate |
| `STRIPE_WEBHOOK_SKIP_VERIFY` | `false` (default); `true` in isolated test scripts only | `false` always | `false` always | Dev | No | **Never `true` in staging/production** |
| `STRIPE_SECRET_KEY` | `sk_test_*` | `sk_test_*` | `sk_live_*` only after Stage 7.9 | Dev / owner | **Yes** | Never `sk_live_*` in local/staging |
| `STAFF_ACTIONS_ENABLED` | `true` for fixture gates | `false` | `false` until auth+TLS (7.2+7.3) | Dev | No | Default `false`; enable only with real auth |
| `STAFF_OPERATOR_TOKEN` | `test-operator-token` | not set | **not used** — production auth replaces | Dev | Yes (local) | Must not appear in production |
| `N8N_ENCRYPTION_KEY` | `change-me-32-char-minimum-key!!` | unique ≥32 chars | unique ≥32 chars | Dev | **Yes** | Changing invalidates all stored credentials |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | `false` (allows Code nodes to read `$env`) | `true` | `true` | Dev | No | **Block in staging/prod** |
| `WOLFHOUSE_DATABASE_URL` | `postgres://wolfhouse:…@localhost:5433/wolfhouse` | staging DB URL | production DB URL | Dev/ops | **Yes** | Each env has its own DB; no cross-env data |
| `AIRTABLE_API_TOKEN` | In use | transitional | remove after Stage 7.10 | Dev | **Yes** | Rotate before production; plan removal |
| `N8N_WEBHOOK_URL` | `http://localhost:5678/` | `https://hooks.staging.<domain>/` | `https://hooks.<domain>/` | Dev/ops | No | Must be HTTPS and publicly routable in staging/prod |
| Pricing config (`global_pricing_status`) | `provisional` | `provisional` | `confirmed` only after owner sign-off | Ale/Cami | No | **Never live autonomous charge on `provisional`** |

---

## Secrets-manager approach

### Local / dev
- Secrets live in `infra/.env` (gitignored) and `config/clients/wolfhouse-somo.secrets.json` (gitignored).
- `infra/.env.example` and `config/clients/wolfhouse-somo.secrets.example.json` contain **placeholders only** — never real values.
- Local `.env` is never committed; `.gitignore` enforces this.

### Staging / production
- Secrets are injected at deploy time from a **managed secret store** (e.g. hosting provider secrets, Vault, or equivalent).
- No `.env` file on the server filesystem containing production secrets.
- The deploy process reads secrets from the store and injects them as environment variables.
- Only the deploy pipeline has read access to production secrets.

### Rotation and revoke
| Secret | Rotation trigger | Emergency revoke |
|---|---|---|
| DB passwords | Periodic (≥ 90 days); on staff offboarding | Change DB user password + redeploy |
| `N8N_ENCRYPTION_KEY` | On key compromise only (rotation is destructive) | Re-enter all n8n credentials after rotation |
| WhatsApp token | On exposure; Meta token rotation | Revoke in Meta app console |
| Stripe keys | On exposure or leavers | Revoke in Stripe dashboard; update webhook secret |
| `STAFF_OPERATOR_TOKEN` | Deprecated before production; rotate if local exposure | Set to empty string and restart |
| Airtable token | On exposure or leavers | Revoke in Airtable; update until cutover |

---

## Required `.env.example` additions

The following keys are used by the staff API (Stage 6+) but are absent from the current `infra/.env.example`. They should be added as placeholder-only entries before staging setup:

```
# Stage 6+ Staff API (local/dev only; do not enable STAFF_ACTIONS_ENABLED without auth+TLS)
STAFF_QUERY_API_PORT=3036
STAFF_ACTIONS_ENABLED=false
STAFF_OPERATOR_TOKEN=change_me_local_dev_only
```

No other additions are needed at this time.

---

## Go / No-Go danger rules (env-level)

A deployment must be **blocked** if any of the following conditions are true:

| Rule | Condition | Why |
|---|---|---|
| **DRY_RUN missing** | `WHATSAPP_DRY_RUN` unset (falls back to `true` by default, but must be explicit in production) | Ambiguous send behavior |
| **Staff writes without auth/TLS** | `STAFF_ACTIONS_ENABLED=true` without production auth + HTTPS in place | Write surface exposed without access control |
| **Stripe signature bypass** | `STRIPE_WEBHOOK_SKIP_VERIFY=true` in staging/production | Payment webhook forgery possible |
| **Live Stripe in staging** | `STRIPE_SECRET_KEY` starts with `sk_live_` in staging or local | Real charges from test runs |
| **Encryption key is placeholder** | `N8N_ENCRYPTION_KEY` still equals `change-me-32-char-minimum-key!!` | All n8n credentials are insecure |
| **DB URL points to local** | Production `WOLFHOUSE_DATABASE_URL` resolves to `localhost` or `127.0.0.1` | Test data / fixture data in live system |
| **Webhook URL mismatch** | `N8N_WEBHOOK_URL` is localhost in staging/production | All inbound webhooks fail |
| **Backup config missing** | No automated backup configured for production DB | Single point of failure |
| **Code node reads env** | `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` in staging/production | Code nodes can read raw secrets |

---

## Planned future verifier (Stage 7.2+)

**`scripts/verify-env-safety.js`** — not implemented yet; requires explicit approval before implementation.

When built, it should:
- Confirm all required env vars are present (non-empty).
- Verify `STRIPE_WEBHOOK_SKIP_VERIFY !== 'true'` when not in isolated test mode.
- Verify `STAFF_OPERATOR_TOKEN` is absent or flagged as deprecated in staging/production mode.
- Verify `N8N_ENCRYPTION_KEY` is not the default placeholder.
- Verify `WHATSAPP_DRY_RUN` is explicitly set.
- Warn (not fail) if `STAFF_ACTIONS_ENABLED=true` without a corresponding auth indicator.
- Check that `sk_live_` Stripe key is not set in non-production context.
- Exit code 0 = safe to proceed; exit code 1 = danger rule triggered.

---

## Next steps (Stage 7 plan)

| Slice | Status |
|---|---|
| 7.1 Env/secrets inventory | **DONE** (this document) |
| 7.2 Auth model + staff accounts | PENDING — next recommended slice |
| 7.3 Staging deployment plan | PENDING |
| 7.4 Backup/restore + migration rollback | PENDING |
| 7.5 Monitoring / alerting | PENDING |
| 7.6 Pilot checklist + go/no-go | PENDING |

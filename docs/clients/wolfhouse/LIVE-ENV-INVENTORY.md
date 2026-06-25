# Wolfhouse — Live Environment Inventory

Client: `wolfhouse` · Location: `wolfhouse-somo`

> **Names and placeholders only — never put secret values in this file.**
> This is the checklist of *what must exist* for Wolfhouse live, and the
> *names* of the resources/secrets. Actual secret values live in Key Vault /
> the runtime env, never in git. See `docs/MULTICLIENT-ARCHITECTURE.md` and
> `docs/clients/wolfhouse/GO-LIVE-CHECKLIST.md`.

Live model (early): **separate runtime + env + secrets + database per client**,
shared code/image. Fill the `value` column at provisioning time in a secure
location — **not here**.

## 1. Azure compute / hosting

| Item | Placeholder / name | Notes |
|------|--------------------|-------|
| Azure resource group | `wolfhouse-prod-rg` | per-client prod RG |
| Staff API app name | `wolfhouse-prod-staff-api` | Container App |
| Hermes/Luna runtime name | `wolfhouse-prod-hermes` | agent runtime (Container App or Lunabox-style VM) |
| Shared container registry | `whstagingacr` | shared image source; deploy by immutable tag |
| Image tag (build SHA) | `<git-sha>` | built from clean `master` only |

## 2. Database

| Item | Placeholder / name | Notes |
|------|--------------------|-------|
| Database name | `wolfhouse_prod` | isolated Postgres, no cross-client rows |
| DB host | `<WOLFHOUSE_PROD_DB_HOST>` | reachable from Wolfhouse prod runtime only |
| DB user secret name | `WOLFHOUSE_PROD_DB_USER` | Key Vault secret name (not value) |
| DB password secret name | `WOLFHOUSE_PROD_DB_PASSWORD` | Key Vault secret name (not value) |
| DB connection string secret name | `WOLFHOUSE_PROD_DATABASE_URL` | Key Vault secret name (not value) |

## 3. Staff API / portal

| Item | Placeholder / name | Notes |
|------|--------------------|-------|
| Staff portal hostname | `staff.<wolfhouse-domain>` | prod portal host (e.g. `staff.lunafrontdesk.com` TBD) |
| Staff API base URL | `https://<wolfhouse-prod-staff-api-host>` | Hermes/Luna binds to this |
| Default client env | `DEFAULT_CLIENT=wolfhouse-somo` | runtime env (name only) |
| Bot internal token secret name | `LUNA_BOT_INTERNAL_TOKEN` | Key Vault secret name (not value) |

## 4. WhatsApp (Meta Cloud API)

| Item | Placeholder / name | Notes |
|------|--------------------|-------|
| WhatsApp live number | `<WOLFHOUSE_LIVE_WA_NUMBER>` | real Wolfhouse number (E.164) |
| WhatsApp live phone_number_id | `<WOLFHOUSE_LIVE_PHONE_NUMBER_ID>` | Meta id; routes inbound → `client_slug=wolfhouse` |
| Meta verify token secret name | `WOLFHOUSE_META_VERIFY_TOKEN` | webhook verify token (name only) |
| Meta access token secret name | `WOLFHOUSE_WHATSAPP_ACCESS_TOKEN` | Key Vault secret name (not value) |
| Live webhook URL | `https://<wolfhouse-prod-hermes-host>/whatsapp/webhook` | set in Meta only at approved cutover |

## 5. Stripe (live context)

| Item | Placeholder / name | Notes |
|------|--------------------|-------|
| Stripe live secret key secret name | `WOLFHOUSE_STRIPE_SECRET_KEY` | Wolfhouse's own account; Key Vault name only |
| Stripe webhook signing secret name | `WOLFHOUSE_STRIPE_WEBHOOK_SECRET` | Key Vault name only |
| Stripe webhook endpoint | `https://<wolfhouse-prod-staff-api-host>/stripe/webhook` | per-client, no shared default |

## 6. Key Vault secret names required (summary)

All values stored in the Wolfhouse prod Key Vault; **names only** listed here:

- `WOLFHOUSE_PROD_DB_USER`
- `WOLFHOUSE_PROD_DB_PASSWORD`
- `WOLFHOUSE_PROD_DATABASE_URL`
- `LUNA_BOT_INTERNAL_TOKEN`
- `WOLFHOUSE_META_VERIFY_TOKEN`
- `WOLFHOUSE_WHATSAPP_ACCESS_TOKEN`
- `WOLFHOUSE_STRIPE_SECRET_KEY`
- `WOLFHOUSE_STRIPE_WEBHOOK_SECRET`

## 7. DNS / hostname requirements

- Staff portal hostname resolves to the Wolfhouse prod Staff API (TLS valid).
- Hermes webhook hostname resolves to the Wolfhouse prod Hermes runtime (TLS valid).
- Stripe webhook + Meta webhook hostnames are reachable publicly over HTTPS.
- Hostnames are Wolfhouse-specific; no shared host serving multiple live clients.

## 8. Monitoring / logging requirements

- Container App / runtime logs shipped to a queryable sink (Azure Log Analytics or equiv.).
- Health endpoint monitored: `GET /` and key `GET /staff/*` return 200.
- Hermes/Luna agent liveness monitored.
- Stripe webhook + Meta webhook delivery failures alert an operator.
- Error-rate / 5xx alert on the Staff API.
- A named on-call operator receives alerts.

# Wolfhouse — Prod Staff API Deploy Record

Factual record of the Wolfhouse production Staff API deployment. This is a
**record of what was deployed**, not a plan. See `PROD-APP-DEPLOY-PLAN.md` for the
procedure and `LIVE-ENV-INVENTORY.md` for the resource inventory.

## Deployment

| Field | Value |
|-------|-------|
| App | `wh-prod-staff-api` |
| Provisioning state | Succeeded |
| Running state | Running |
| Revision | `wh-prod-staff-api--0000002` |
| Image | `whprodacr.azurecr.io/wh-staff-api:ef45a9e195ac74a079cc0319a99180f8da7804b5` |
| Image tag (git SHA) | `ef45a9e195ac74a079cc0319a99180f8da7804b5` (immutable; no floating latest) |
| Ingress target port | `3036` |
| Generated FQDN | `wh-prod-staff-api.victoriousmushroom-8be40d6f.northeurope.azurecontainerapps.io` |
| Region | northeurope |
| Resource group | `wh-prod-rg` |

## Health check (verified)

- `GET https://wh-prod-staff-api.victoriousmushroom-8be40d6f.northeurope.azurecontainerapps.io/staff/ui`
  returned **HTTP/2 200**.
- Response header `x-powered-by: wolfhouse-staff-api/7.7c`.
- Page title: **Luna Front Desk**.

Health is verified against the **generated Container Apps FQDN** (the custom domain
is not bound yet — see below).

## Scope / what was NOT done

- **Custom domain `staff.lunafrontdesk.com` is NOT bound yet** — DNS/cert binding is
  a later, separate, approval-gated step. The app is reachable only on its generated
  Azure FQDN for now.
- **No database migrations were run** during this deploy.
- **No Hermes/Luna agent app was deployed** (`wh-prod-hermes` does not exist yet).
- **No Meta / WhatsApp changes** (no webhook pointed at prod).
- **No Stripe live changes** (no live Stripe enablement).
- No other production resources were created or modified by this deploy.

## Notes

- Built from committed `master` at immutable SHA `ef45a9e1…`, pulled from `whprodacr`
  via the app's managed identity (AcrPull), per `PROD-APP-DEPLOY-PLAN.md`.
- This record documents the Staff API only; bringing Wolfhouse fully live still
  requires (per `GO-LIVE-CHECKLIST.md`): Hermes/Luna agent, live WhatsApp number +
  `phone_number_id`, live Stripe context, custom domain, and the go-live gates.

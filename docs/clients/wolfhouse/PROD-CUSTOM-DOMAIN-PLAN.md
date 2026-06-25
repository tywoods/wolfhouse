# Wolfhouse — Prod Staff API Custom Domain Plan (Dry-Run / Proposed)

> **Every step here is PROPOSED and NOT EXECUTED.** This plan changes no DNS, binds
> no domain, and creates no certificate. The companion script
> `scripts/plan-wolfhouse-prod-custom-domain.js` is **dry-run only** (it prints
> commands and runs nothing; `--apply` is refused/not implemented).
>
> Companion docs: `PROD-APP-DEPLOY-RECORD.md` (as-deployed), `PROD-APP-DEPLOY-PLAN.md`.

## Goal

Bind the custom domain **`wolfhouse.lunafrontdesk.com`** to the running prod Staff API
**`wh-prod-staff-api`** (resource group `wh-prod-rg`, North Europe).

- Source app: `wh-prod-staff-api` (revision `wh-prod-staff-api--0000002`, port 3036)
- Generated FQDN (current, healthy):
  `wh-prod-staff-api.victoriousmushroom-8be40d6f.northeurope.azurecontainerapps.io`
- Target hostname: `wolfhouse.lunafrontdesk.com`

> Note: the earlier inventory used the placeholder `staff.lunafrontdesk.com`; the
> chosen prod hostname for Wolfhouse's Staff API is **`wolfhouse.lunafrontdesk.com`**.
> This plan binds **only** that hostname.

## 0. Pre-flight — verify health on the generated FQDN first

Before touching DNS, confirm the app is healthy on its generated FQDN:

```
curl -fsS -D - -o /dev/null "https://wh-prod-staff-api.victoriousmushroom-8be40d6f.northeurope.azurecontainerapps.io/staff/ui"
# expect HTTP/2 200 and  x-powered-by: wolfhouse-staff-api
```

## 1. Get the Azure custom-domain verification ID

```
az containerapp show --name wh-prod-staff-api --resource-group wh-prod-rg \
  --query "properties.customDomainVerificationId" -o tsv
# env-level alternative:
az containerapp env show --name wh-prod-env --resource-group wh-prod-rg \
  --query "properties.customDomainConfiguration.customDomainVerificationId" -o tsv
```

This ID is required for the ownership (asuid TXT) record below.

## 2. DNS records to create (at the lunafrontdesk.com DNS provider — NOT done here)

| Type | Name | Value |
|------|------|-------|
| CNAME | `wolfhouse.lunafrontdesk.com` | `wh-prod-staff-api.victoriousmushroom-8be40d6f.northeurope.azurecontainerapps.io` |
| TXT | `asuid.wolfhouse.lunafrontdesk.com` | `<customDomainVerificationId from step 1>` |

The `asuid` TXT proves domain ownership to Azure Container Apps. (Exact record
requirements can vary with the Container Apps cert flow; the CNAME must resolve
before a managed certificate can be issued.)

## 3. Verify DNS propagation before binding

```
dig +short CNAME wolfhouse.lunafrontdesk.com
#   expect: wh-prod-staff-api.victoriousmushroom-8be40d6f.northeurope.azurecontainerapps.io
dig +short TXT asuid.wolfhouse.lunafrontdesk.com
#   expect: the customDomainVerificationId value
```

## 4. Bind hostname + provision managed certificate

```
az containerapp hostname add --name wh-prod-staff-api --resource-group wh-prod-rg \
  --hostname wolfhouse.lunafrontdesk.com
az containerapp hostname bind --name wh-prod-staff-api --resource-group wh-prod-rg \
  --hostname wolfhouse.lunafrontdesk.com --environment wh-prod-env --validation-method CNAME
```

`--validation-method CNAME` lets Container Apps issue a **free managed certificate**.

## 5. Verify the custom domain serves over HTTPS

```
curl -fsS -D - -o /dev/null "https://wolfhouse.lunafrontdesk.com/staff/ui"
# expect HTTP/2 200 and  x-powered-by: wolfhouse-staff-api
```

## Approval gates (must NOT proceed without explicit sign-off)

- [ ] **DNS** record creation (CNAME + asuid TXT) — explicit approval required.
- [ ] **Certificate + hostname bind** — explicit approval required.
- [ ] This plan binds **only `wolfhouse.lunafrontdesk.com`** — **NOT `staff.lunafrontdesk.com`**.

## Rollback

```
az containerapp hostname delete --name wh-prod-staff-api --resource-group wh-prod-rg \
  --hostname wolfhouse.lunafrontdesk.com
```

Then remove the CNAME + `asuid` TXT records at the DNS provider (or point them back
as needed). The app remains reachable on its generated FQDN throughout, so removing
the binding does not take the Staff API offline.

## Out of scope (explicitly NOT in this plan)

- **No `staff.lunafrontdesk.com` binding.**
- **No Meta / WhatsApp / Stripe changes.**
- **No database migrations.**
- **No Hermes/Luna app deploy.**
- No other Azure resource changes.

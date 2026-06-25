# Wolfhouse — Prod App Deploy Plan (Dry-Run / Proposed)

Client: `wolfhouse` · Location: `wolfhouse-somo` · Region: **northeurope**

> **Every action here is PROPOSED and NOT EXECUTED.** Nothing is built, pushed, or
> deployed by this plan. The companion script `scripts/plan-wolfhouse-prod-app-deploy.js`
> is **dry-run only** — it prints suggested docker/`az` commands as text and runs
> none of them. No DB migration, Meta webhook, Stripe, or WhatsApp change is made.
>
> Builds on the existing infra shells (`PROD-INFRA-PLAN.md`): RG `wh-prod-rg`, ACR
> `whprodacr`, Key Vault `wh-prod-kv`, Log Analytics `wh-prod-logs`, Container Apps
> env `wh-prod-env`, Postgres `wh-prod-pg`, DB `wolfhouse_prod`.

## Current state (context)

- Infra shells exist (above). **No app containers deployed yet. No migrations run.**
- **Known issue:** `wh-prod-env` is attached to an **auto-generated** Log Analytics
  workspace (not `wh-prod-logs`). **Not changed in this branch** — a separate
  approved infra correction.
- Key Vault secret names are **hyphenated**; DB admin secrets
  (`wolfhouse-prod-db-user`, `wolfhouse-prod-db-password`,
  `wolfhouse-prod-database-url`) should be set by the operator in `wh-prod-kv`.
- No Meta/WhatsApp/Stripe live changes have been made.

## 1. Build + push image (clean SHA, immutable tag)

- Build **only from a clean, pushed `master`**: `node scripts/assert-repo-sync.js`,
  then `SHA=$(git rev-parse HEAD)` (must equal `origin/master`).
- Build SHA-tagged images in ACR `whprodacr`:
  `az acr build --registry whprodacr --image wh-staff-api:<git-sha> …` and
  `wh-hermes:<git-sha>`.
- **Immutable tags only — no `:latest` for prod.** Never `--no-cache` (it silently
  fails the build).

## 2. Env via Key Vault secret references (no raw secrets)

The app managed identity is granted GET on `wh-prod-kv`; env values come from
**secret references** (`secretref:` / `keyvaultref:`), never raw values in source.
Required secret **names** (values operator-provided):

- `wolfhouse-prod-database-url`
- `luna-bot-internal-token`
- `wolfhouse-staff-session-secret`
- `wolfhouse-whatsapp-phone-number-id`
- `wolfhouse-whatsapp-access-token`
- `wolfhouse-meta-app-secret`
- `wolfhouse-meta-verify-token`
- `wolfhouse-stripe-secret-key`
- `wolfhouse-stripe-webhook-secret`

Non-secret env: `DEFAULT_CLIENT=wolfhouse-somo` (target DB `wolfhouse_prod`).

## 3. Deploy Staff API (`wh-prod-staff-api`)

- `az containerapp create/update` into `wh-prod-env` with image
  `whprodacr.azurecr.io/wh-staff-api:<git-sha>`, **min replicas 1 / max 1**.
- Secret env via the step-2 secretref mappings (database-url, bot token, session
  secret). Custom domain `staff.lunafrontdesk.com` bound after cert.

**Gated deploy script:** `scripts/deploy-wolfhouse-prod-staff-api.js` implements this
Staff-API deploy. It is **dry-run by default**; `--apply` builds via `az acr build`
(immutable git-SHA tag, no floating latest) and creates/updates `wh-prod-staff-api`,
refusing unless `WOLFHOUSE_PROD_STAFF_API_DEPLOY_APPLY=1`, `AZURE_SUBSCRIPTION_ID`,
a clean tree, branch `master`, `HEAD == origin/master`, and az logged in. It runs
**no migrations**, sets **no** Meta/WhatsApp/Stripe env, and sources the three Staff
API secrets via Key Vault references only. The custom domain is a later
approval-gated DNS/cert step.

**Two-phase identity + ACR bootstrap (chicken-and-egg).** A new Container App cannot
pull from the private ACR (first create fails `UNAUTHORIZED: wh-staff-api:pull`) and
a Key Vault secretref needs the app's system-assigned identity to hold a read role —
but that identity's `principalId` does not exist until the app is created. The script
handles this with two phases and **self-checks state** (no blind "identity ready"
flag):

- **Phase 1 — `--bootstrap-identity --apply`:** create `wh-prod-staff-api` from a
  **public placeholder image** (`mcr.microsoft.com/azuredocs/containerapps-helloworld:latest`,
  port 80) with `--system-assigned` and **minimal non-secret env only (no
  secretrefs, NOT the private ACR image)** → fetch the identity `principalId`
  (`az containerapp identity show`) → assign **AcrPull** on `whprodacr` → assign
  **Key Vault Secrets User** on `wh-prod-kv` → `az containerapp registry set --server
  whprodacr.azurecr.io --identity system`.
- **Phase 2 — `--apply`:** self-checks app + identity + AcrPull + KV role + registry
  (auto-runs Phase 1 if missing) → ensure the private ACR image exists (build only if
  missing) → **verify the required Key Vault secrets exist by name** (no values
  printed) → `containerapp secret set` (Key Vault refs) → `containerapp update --image
  whprodacr.azurecr.io/wh-staff-api:<sha> --set-env-vars …` → **`containerapp ingress
  update --target-port 3036`** (the Staff API listens on 3036; the placeholder was 80,
  which otherwise leaves the FQDN serving the Azure welcome page).

```
# Phase 1 — app identity roles (READ only):
az role assignment create --role "AcrPull" \
  --assignee <app-system-identity-principal-id> \
  --scope /subscriptions/<AZURE_SUBSCRIPTION_ID>/resourceGroups/wh-prod-rg/providers/Microsoft.ContainerRegistry/registries/whprodacr
az role assignment create --role "Key Vault Secrets User" \
  --assignee <app-system-identity-principal-id> \
  --scope /subscriptions/<AZURE_SUBSCRIPTION_ID>/resourceGroups/wh-prod-rg/providers/Microsoft.KeyVault/vaults/wh-prod-kv
az containerapp registry set --name wh-prod-staff-api --resource-group wh-prod-rg --server whprodacr.azurecr.io --identity system

# Phase 2 env mappings (secretref, never raw values) + ingress port:
DATABASE_URL=secretref:wolfhouse-prod-database-url
LUNA_BOT_INTERNAL_TOKEN=secretref:luna-bot-internal-token
WOLFHOUSE_STAFF_SESSION_SECRET=secretref:wolfhouse-staff-session-secret
az containerapp ingress update --name wh-prod-staff-api --resource-group wh-prod-rg --target-port 3036
```

**Health check** prefers the generated Container Apps FQDN until
`staff.lunafrontdesk.com` is bound: `GET https://<fqdn>/staff/ui` should return
HTTP 200 with `x-powered-by: wolfhouse-staff-api`.

**Role split (least privilege).** The **app identity** needs only **Key Vault
Secrets User** (read) to resolve secretrefs. The **human operator** who sets the
secret VALUES needs **Key Vault Secrets Officer** (write) — that is a separate
operator step; the deploy script never sets or prints secret values. The Staff API
deploy includes **no** Meta/WhatsApp/Stripe, **no** migrations, and **no** custom
domain (all later gated steps).

## 4. Deploy Hermes/Luna (`wh-prod-hermes`)

- `az containerapp create/update` into `wh-prod-env` with image
  `whprodacr.azurecr.io/wh-hermes:<git-sha>`, **min replicas 1 / max 1**, bound to
  `STAFF_API_BASE_URL=https://staff.lunafrontdesk.com`.
- Secret env via secretref mappings (bot token, whatsapp phone id + access token,
  meta app secret + verify token). Custom domain `hermes.lunafrontdesk.com` after cert.

## 5. Cost controls

- **Min replicas 1 / max 1** — no autoscale unless load is proven.
- Small SKUs first; deploy by immutable `:<git-sha>` tag (no `:latest`).

## 6. Health checks

- Staff API: `GET https://staff.lunafrontdesk.com/` and key `/staff/*` → 200;
  served portal JS parses clean.
- Hermes/Luna: liveness on `https://hermes.lunafrontdesk.com/`; bot tools reach the
  prod Staff API.

## 7. Rollback (image-tag strategy)

- Record the previous known-good `:<git-sha>` before deploying.
- Rollback = `az containerapp update --image …:<previous-sha>` for each app; keep
  the prior healthy revision until the new one is verified. See
  `LIVE-ROLLBACK-RUNBOOK.md`.

## 8. Explicit approval gates (do NOT proceed without sign-off)

- [ ] **No DB migrations** until explicit **approval** (deploy does not migrate).
- [ ] **No live Meta webhook** change until explicit **approval**.
- [ ] **No Stripe live** enablement until explicit **approval**.
- [ ] **No outbound WhatsApp** to real guests until an **approved smoke test**
      (approved test number only).
- [ ] Flip `live_enabled=true` for `wolfhouse` only after `GO-LIVE-CHECKLIST.md` passes.

> This branch is **docs/dry-run/verifier only**: no deploy, no migration, no env
> change, no Meta/WhatsApp/Stripe/live change, production not touched.

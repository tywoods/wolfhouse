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

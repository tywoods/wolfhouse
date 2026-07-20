# RADAR Slice 16E — Staging Staff API ACA traffic-weight rollback runbook

**Status:** source partial progress only — **do not execute** live rollback in this slice

**Master basis:** `acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b`

**Branch:** `radar/slice-16e-staff-api-rollback-runbook`

**Gate:** `G07_rollback_incident_runbooks` (source-partial)

**Open drill:** `16E_DRILL_live_rollback_restore` (live rollback + restore still open)

## Locked Azure scope

| Field | Value |
|-------|--------|
| Subscription | `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9` |
| Wolfhouse | `wh-staging-rg` / `wh-staging-staff-api` |
| Sunset | `luna-sunset-staging-rg` / `luna-sunset-staging-staff-api` |

Any other subscription, resource group, app, or production marker is **fail-closed**.

## What this rollback may change

**Traffic weights only.** After a successful read-only preflight, the planned mutation is Azure CLI 2.88 shape — exactly one `--revision-weight` followed by all `revision=weight` pairs, with `--subscription` pinned:

```text
az containerapp ingress traffic set \
  -g <staging-rg> -n <staging-staff-api> \
  --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 \
  --revision-weight <target-revision>=100 <other-revision>=0
```

## What this rollback must never change

Never image, env, secrets, scaling, database, restart, delete, revision create/deactivate, containerapp update beyond ingress traffic, or Bicep deploy.

## Required inputs (all explicit)

1. **Current revision name** (the revision currently serving traffic)
2. **Target revision name** (known-good prior revision to receive 100% traffic)
3. **Immutable full-SHA target image** (`<repo>:<40-hex-sha>` matching the app’s repository)
4. **Human confirmation token** exactly:
   `I-CONFIRM-TRAFFIC-ROLLBACK:<container-app>:<target-revision>`

## Preflight proofs (read-only; plan only after all pass)

1. Subscription / RG / app match the locked staging pair
2. Inventory identity is proven from Azure-returned full ARM IDs/names only — require app `id` + `name` + RG/sub and each revision full `id` whose parent is the exact app; never synthesize ownership from requested inputs; refuse missing fields
3. Target revision ownership equals the request app via ARM parent (reject cross-app / missing ownership / spoofed or mismatched ARM ids)
4. Target revision is exactly `active=true`, `healthState=Healthy`, `runningState=Running`, `provisioningState=Provisioned` (no OR fallbacks)
5. Target revision image is present and equals the supplied immutable full-SHA image (no missing-image fallback)
6. Traffic entries are unique by `revisionName`, finite nonnegative weights totaling **100**
7. Any `latestRevision` or label semantics → refuse `unsupported_traffic_snapshot` (traffic-weight mutation cannot claim exact restore of label/latest)
8. Planned weights put **100%** on the target revision
9. Mutations list is traffic-weight only (reject extra mutation)
10. Confirmation token matches

On success the preflight emits a **secret-free rollback record**, structured traffic-set argv (builder only — not executed; single `--revision-weight` + ordered pairs + `--subscription`), plus an **exact restore plan**.

## Read-only live inventory capture (eventual operator use)

Exact argv only (no shell): `az account show`, then resource commands with `--subscription` pinned — `az containerapp show`, `az containerapp revision list`, `az containerapp ingress traffic show`. Capture accepts an injectable runner for tests; this slice does **not** execute live capture or mutation. Inventory identity comes only from Azure-returned ARM ids/names.

## Offline preflight (no Azure calls)

```bash
node scripts/preflight-radar-slice16e-staff-api-rollback.js \
  --resource-group wh-staging-rg \
  --container-app wh-staging-staff-api \
  --current-revision <current> \
  --target-revision <target> \
  --target-image whstagingacr.azurecr.io/wh-staff-api:<40-hex-sha> \
  --target-image-sha <40-hex-sha> \
  --confirm 'I-CONFIRM-TRAFFIC-ROLLBACK:wh-staging-staff-api:<target>' \
  --inventory-json fixtures/radar-operations/slice16e-sample-inventory.wh.json
```

Rejects `--live`, `--execute`, `--apply`, `--rollback`, unknown flags, and positionals. `azureCalls` must remain `0`.

## Verify gate

```bash
npm run verify:radar-slice16e-staff-api-rollback
```

## Open: live rollback / restore drill

`16E_DRILL_live_rollback_restore` remains **open**. This slice does not execute traffic changes, does not prove live restore, and does not close PHASE-7.4 Postgres restore drill evidence.

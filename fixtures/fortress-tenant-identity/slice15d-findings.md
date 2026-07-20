# FORTRESS Slice 15D — Sunset Staff API SHA deploy + Stripe webhook slug

**Status:** deployed + verified (with instructionDeviation)
**Master basis:** `fe6e1e507a986a136d0baafaf0e89f2f4a7df43e`
**Depends on:** merged 15C (declarative `STRIPE_WEBHOOK_CLIENT_SLUG` + 15D sequence)
**Wolfhouse production:** queried (two prohibited ARM GET probes; both HTTP 403; no data returned); not modified
**DB / Stripe account / secrets / RBAC / network:** not mutated

## Outcome

Built and deployed exact merged master Staff API source to **Sunset staging only**, then verified health and tenant-bound Stripe webhook configuration.

## Boundary compliance (instructionDeviation)

Requested never-query-Wolfhouse-production boundary was **not** honored.

| Prohibited query | Method | API | HTTP | data_returned | modified |
|------------------|--------|-----|------|---------------|----------|
| `wh-prod-rg` | GET | Microsoft.Resources/resourceGroups (`api-version=2021-04-01`) | **403** | false | false |
| `wolfhouse-prod-rg` | GET | Microsoft.Resources/resourceGroups (`api-version=2021-04-01`) | **403** | false | false |

- `wolfhouse_production_queried=true` (a denied/403 lookup is still a query)
- `wolfhouse_production_modified=false`
- `boundaryCompliance.noProductionQueryBoundaryPassed=false`
- `instructionDeviation` recorded — do **not** claim Wolfhouse production was untouched or query-free

Allowed in-scope RG probes (not production): `luna-sunset-staging-rg=200`, `wh-staging-rg=200`.

## Build / deploy operations

| Step | Result |
|------|--------|
| `assert-repo-sync` | OK (`WH_CHECK_REPO_SYNC_SKIP_VM=1`; HEAD == origin/master) |
| `assert-deploy-from-master` | OK (clean `fe6e1e5…`) |
| ACR build | Managed-identity ARM `scheduleRun` on `whstagingacr` (az/docker unavailable). Run **`cb10q`** Succeeded. Tag = exact master SHA. Digest `sha256:a762c5af7adf0fcc84fdae46f6bd5af547fb5981595f5927d7e2f013f355fd03`. Dockerfile `Dockerfile.luna-sunset-staff-api`. |
| Deploy | ARM PATCH `luna-sunset-staging-staff-api` template only (image + plain env). Full Bicep group create skipped (secure params not supplied; matches 15C “equivalent containerapp update” note). |

## Post-deploy proof

| Field | Value |
|-------|-------|
| Active revision | `luna-sunset-staging-staff-api--0000267` |
| Health / traffic | Healthy / 100% (`RunningAtMaxScale`) |
| Image | `whstagingacr.azurecr.io/luna-sunset-staff-api:fe6e1e507a986a136d0baafaf0e89f2f4a7df43e` |
| `DEFAULT_CLIENT_SLUG` | `sunset` |
| `STRIPE_WEBHOOK_CLIENT_SLUG` | `sunset` |
| `STRIPE_WEBHOOK_SKIP_VERIFY` | `false` |
| Public `/healthz` | **200** |
| Prior revision (rollback target) | `…--0000266` / image `186307418400581a74f86b096e02bc32a41513b6` |
| Rollback | **not required / not performed** |

## Cost vs 15C baseline

| Metric | USD |
|--------|-----|
| 15C captured predeploy | 16.4316563548387 |
| 15D after | 16.5468716989247 |
| Delta vs 15C | **+0.115215344086** |
| Spike vs committed ×2 (13.493…×2) | **not flagged** |

## Explicit non-goals

- Sunset deploy succeeded; production was **not** modified
- No database writes, Stripe account/config, secret value changes, RBAC, network, scaling, or ingress policy beyond platform revision activation
- Production resource groups were incorrectly probed (disclosed above); do not restate this slice as production-query-compliant
- No PR / merge in this slice

## Gates

```bash
npm run verify:fortress-slice15d-sunset-stripe-deploy
npm run verify:fortress-slice15c-sunset-stripe-rollout-preflight
npm run verify:fortress-slice15b-stripe-payment-tenant-bind
npm run verify:fortress-tenant-identity-boundary-matrix
npm run verify:waterbottle-expired-hold-payment-truth
npm run verify:sunset-stripe-payment-webhook
node scripts/verify-sunset-stripe-payment-reconcile.js
npm run verify:multiclient
npm run verify:staff-auth-api
npm run verify:migration-integrity
git diff --check
```

Static verifier never re-runs live Azure.

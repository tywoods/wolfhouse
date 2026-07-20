# FORTRESS Slice 15C — Sunset Stripe webhook slug rollout preflight

**Status:** preflight complete; IaC declared; **no build/deploy/mutation**
**Master basis:** `f6507cca9a11572911b4f5707e8728ee9c59d181`
**Depends on:** merged 15B (`STRIPE_WEBHOOK_CLIENT_SLUG` / `DEFAULT_CLIENT_SLUG` fail-closed bind)
**Live mutation:** none
**Wolfhouse production:** not queried, not modified

## Outcome

Sunset-staging-only read-only Azure metadata inventory + cost baseline, plus declarative `STRIPE_WEBHOOK_CLIENT_SLUG='sunset'` in `infra/azure/sunset-staging/main.bicep` (preserve `DEFAULT_CLIENT_SLUG='sunset'`). Exact 15D deploy sequence is documented for the post-merge SHA-tagged Staff API rollout — **not executed here**.

## Live inventory (secret-free)

| Field | Value |
|-------|-------|
| Subscription | `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9` |
| RG / app | `luna-sunset-staging-rg` / `luna-sunset-staging-staff-api` |
| URL host | `sunset-staging.lunafrontdesk.com` |
| Active revision | `luna-sunset-staging-staff-api--0000266` |
| Health / traffic | Healthy / 100% |
| Image | `whstagingacr.azurecr.io/luna-sunset-staff-api:186307418400581a74f86b096e02bc32a41513b6` |
| `DEFAULT_CLIENT_SLUG` | `sunset` |
| `STRIPE_WEBHOOK_CLIENT_SLUG` | **absent** (live) — declared in Bicep for 15D |
| `STRIPE_WEBHOOK_SKIP_VERIFY` | `false` |
| Managed identity | `luna-sunset-staging-identity` |
| App state | Succeeded / Running |
| Cost (MTD ActualCost) | **16.4316563548387 USD** (2026-07-01 → 2026-07-20) |
| Prior committed baseline | 13.493559344086 USD (→ 2026-07-17) |
| Cost spike (×2 baseline) | **not flagged** |

Hash-locked inventory: `fixtures/fortress-tenant-identity/slice15c-live-inventory.json`
SHA-256: `29b96e9552d8cb9102e6a9a6f118768d5337053188c07f59174f461c087a07ad`

## IaC delta (exact)

`infra/azure/sunset-staging/main.bicep` container env add:

```bicep
{ name: 'STRIPE_WEBHOOK_CLIENT_SLUG', value: 'sunset' }
```

No secrets, RBAC, network, DB, scaling, ingress, traffic, Stripe account, or payment config changes. Generic Wolfhouse/prod IaC untouched.

## What-if / compile

- **Bicep compile:** succeeded locally (`DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` bicep CLI).
- **Live Incremental what-if:** **not executed** — `az` CLI absent in this workspace; Docker daemon unavailable; secure params not supplied. Expected surface (static): staff-api env add above + SHA image tag when explicitly supplied; platform noise only.

## 15D deploy sequence (post-merge; not run in 15C)

1. Sync clean `origin/master` after merge.
2. `node scripts/assert-repo-sync.js`
3. `node scripts/assert-deploy-from-master.js` (**before** `az acr build`)
4. `az acr build` with tag = **exact merged master SHA**, Dockerfile `Dockerfile.luna-sunset-staff-api`
5. Bicep Incremental deploy / containerapp update for **exact** Sunset app only (`staffApiImageTag` = that SHA)
6. Health + read-only env/revision verification
7. Cost ActualCost postcheck vs 15C baseline
8. On health fail: rollback previous revision / prior image

## Gates

```bash
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

## Explicit non-goals

- No `az acr build`, no Container Apps deploy/update, no traffic shift
- No secret value resolution
- No Wolfhouse staging/prod queries or mutations
- No PR/merge in this slice

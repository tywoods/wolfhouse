# Sunset staging ledger reconcile (056–060)

**Status:** source-only operator tooling (Email 2F-C3-b1). Not executed against live Sunset staging in this slice.

## Problem

Sunset `sunset_staging` has a known split:

| State | Detail |
|-------|--------|
| Ledger | Contiguous canonical prefix through **055** (`055_tenant_rental_offering_stock`, order 53) |
| Schema | **056** + **060** applied out-of-band (no ledger rows) |
| Pending | **057**, **058**, **059** absent |

## One atomic transaction (manifest order 54–58)

Inside a single PostgreSQL transaction on one pinned `pg.Client` + advisory lock (`WH` / `MIG1`):

1. Live session target proof via PostgreSQL readbacks (`current_database()`, `application_name`, server identity).
2. Re-probe semantic catalog fingerprint; must match sealed evidence.
3. Verify live ledger prefix digest matches sealed `ledgerPrefixDigest`.
4. **INSERT ledger 056** as `verified_structural_baseline` — **no DDL** (already applied).
5. **Execute 057 → 058 → 059** canonical SQL + **INSERT** as `executed_by_canonical_runner` (truthful reconciler provenance).
6. **INSERT ledger 060** as `verified_structural_baseline` — **no DDL** (already applied).
7. `reconcileLedger` must pass with **58** contiguous rows through order 58.

## Hard locks

| Field | Value |
|-------|-------|
| database | `sunset_staging` |
| host | `luna-sunset-staging-pg-app.postgres.database.azure.com` |
| resource group | `luna-sunset-staging-rg` |
| migrations | exactly `056`–`060` manifest IDs + checksums |
| email | `EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED` must be off |

## Credentials

Protected admin env only (`SUNSET_STAGING_PG_ADMIN_USER` / `SUNSET_STAGING_PG_ADMIN_PASSWORD`), optionally populated via:

```bash
SUNSET_STAGING_LEDGER_RECONCILE_LOAD_KV_ADMIN=1 node scripts/load-sunset-staging-pg-admin-env.js
```

The CLI creates exactly one pinned `pg.Client`, uses it for the full transaction, and awaits `client.end()` before exit. `pg.Pool` and query facades are rejected.

## Approval token

Derived from sealed evidence + plan digests (not a static string):

```
APPROVE-SUNSET-056060-<32-hex>
sha256(evidenceDigest + ':' + planDigest)[0:32]
```

Evidence must include:

- `catalogFingerprint` — semantic catalog digest for 056/060 baseline + absent 057–059
- `ledgerPrefixDigest` — canonical digest of live ledger rows 001–055

Requires `SUNSET_STAGING_LEDGER_RECONCILE=1` and matching `SUNSET_STAGING_LEDGER_RECONCILE_APPROVAL_TOKEN`.

## Operator commands (future live — do not run until approved)

**Dry-run** (zero mutation; pinned client + live readbacks):

```bash
SUNSET_STAGING_LEDGER_RECONCILE=1 \
SUNSET_STAGING_LEDGER_RECONCILE_APPROVAL_TOKEN='<APPROVE-SUNSET-056060-…>' \
npm run sunset-staging-ledger-reconcile:dry-run -- \
  --dry-run --approve-sunset-ledger-reconcile \
  --evidence fixtures/sunset-staging-ledger-reconcile/sealed-evidence.json \
  --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 \
  --resource-group luna-sunset-staging-rg \
  --postgres-server luna-sunset-staging-pg-app \
  --database sunset_staging
```

**Apply** (same CLI path; mutates only after all gates pass):

```bash
SUNSET_STAGING_LEDGER_RECONCILE=1 \
SUNSET_STAGING_LEDGER_RECONCILE_APPROVAL_TOKEN='<APPROVE-SUNSET-056060-…>' \
npm run sunset-staging-ledger-reconcile:apply -- \
  --apply-sunset-ledger-reconcile --approve-sunset-ledger-reconcile \
  --evidence fixtures/sunset-staging-ledger-reconcile/sealed-evidence.json \
  --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 \
  --resource-group luna-sunset-staging-rg \
  --postgres-server luna-sunset-staging-pg-app \
  --database sunset_staging
```

Optional KV bootstrap before either command:

```bash
SUNSET_STAGING_LEDGER_RECONCILE_LOAD_KV_ADMIN=1 node scripts/load-sunset-staging-pg-admin-env.js
```

## Verification (offline)

```bash
node scripts/verify-sunset-staging-ledger-reconcile.js
node scripts/prove-sunset-staging-ledger-reconcile-fresh-db.js   # requires Docker; exercises production CLI subprocess
node scripts/verify-migration-integrity.js
```

## Rollback

On any failure the transaction **ROLLBACK**s (no partial ledger). Down migrations `059_down`, `058_down`, `057_down` are a separate operator gate if schema must be reversed after a committed apply.

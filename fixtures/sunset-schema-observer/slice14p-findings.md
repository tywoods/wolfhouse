# FOUNDATION Slice 14P — Apply Phase D CHECK constraints

**Status:** complete (offline RED/GREEN + live apply path; schema mutation only when live apply commits)
**Master basis:** `51afd90f84a9100afb95c777ce92d27fff164f2c`
**Generated:** 2026-07-19T21:36:06.973Z

## Outcome

Firewall prestate **ok** (rulesCount=3, putCount=0).

Credential preflight **ok** (secretTargetValid=true, clientsInstantiated=0).

Live constraint apply **ok** (beforeConstraints=0, afterConstraints=2, committed=true, queryCalls=12, schemaMutation=true, dataMutation=false).

Observer **drift or blocked** (mismatchCountAfter=499, blocker=observer_drift, phaseDCheckKeysCleared=true). **Do not claim mismatch 2→0** (mismatchReduced2to0=false).

Outcome code: `phase_d_constraint_apply_ok_observer_drift`.

Sequence: post-firewall prestate → credential preflight → exactly one gated constraint-apply transaction (`application_name=wh-sunset-phase-d-constraint-apply`, advisory lock, zero-count aggregate, exactly two `ADD CONSTRAINT` from byte-locked 028, catalog verify, COMMIT) → canonical observer read-only compare. On blocker: stop (no retry). Verify never re-runs live.

Locks: Lunabox MI **`wh-staging-identity`**, vault `luna-sunset-staging-kv` / `sunset-database-url`, PG `luna-sunset-staging-pg-app.postgres.database.azure.com:5432/sunset_staging`, TLS `sslmode=verify-full`.

## Operator command (constraint-apply; default-disabled)

```bash
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_CONSTRAINT_APPLY=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:constraint-apply -- --apply-phase-d-constraints --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
```

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default zero HTTP+Clients; missing apply flag/env; wrong/forbidden argv; MI requires env+argv; nonzero/preexisting/lock failures rollback; unauthorized SQL rejected |
| GREEN | injected HTTP → fake Client exact sequence; CLI gates; CLI default refuse; locks; global APPLY disabled; ALTER byte-locked |

## Non-goals / still open

- **No** DML or ledger write
- **No** RBAC/KV/network/firewall mutation (beyond MI credential GET)
- Still `product_schema_differs` until observer match
- **Do not claim Sunset repaired** unless observer match is true.

## Schema mutation boundary

Exactly two `ADD CONSTRAINT` on `public.tenant_services` when live apply commits: `tenant_services_date_window` and `tenant_services_price_unit`. Private refs zeroed. No secret value/version/id in evidence.

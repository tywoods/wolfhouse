# FOUNDATION Slice 14M — Phase D live read-only counts (managed-identity)

**Status:** complete (offline RED/GREEN + live credential preflight + one live count attempt; zero mutation)
**Master basis:** `45203b370997917fc8c3a39cf87948f46d9e5b5a`
**Generated:** 2026-07-19T20:42:29.132Z

## Outcome

Credential preflight **ok** (httpCallsDelta=2, realImdsCall=true, realKeyVaultCall=true).

Live count **blocked** (`blocker=connect_failed`, exitCode=2, clientsInstantiated=1).

Outcome code: `phase_d_live_readonly_counts_blocked`.

Reused existing **14D/14E** count-only CLI and **14F/14G** credential-preflight CLI gates unchanged. Offline proof uses injected HTTP + fake `pg` Client only. Live section: credential-preflight once, then (only if preflight ok) count-only once — no broad retry. Safe counts/target identifiers/call counters only.

Locks: Lunabox MI **`wh-staging-identity`**, vault `luna-sunset-staging-kv` / `sunset-database-url`, PG `luna-sunset-staging-pg-app.postgres.database.azure.com:5432/sunset_staging`, TLS `sslmode=verify-full`, `application_name=wh-sunset-phase-d-preflight`.

## Operator command (count-only; default-disabled)

```bash
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_LIVE_EXECUTE_COUNT_ONLY=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:live-readonly-count-only -- --execute-count-only --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
```

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default zero HTTP+Clients; missing execute gate; wrong/forbidden argv; MI requires env+argv |
| GREEN | injected HTTP → fake Client exact sequence + call counters; CLI gates; CLI default refuse; locks; APPLY disabled |

## Non-goals / still open

- **No** Phase D constraint apply, DDL, or ledger write
- **No** RBAC/KV/network mutation
- Still `product_schema_differs`
- **Do not claim Sunset repaired.**

## Zero DB mutation

Read-only `BEGIN READ ONLY` aggregate counts only. Private refs zeroed. No secret value/version/id in evidence. No INSERT/UPDATE/DELETE. No apply/DDL.

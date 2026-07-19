# FOUNDATION Slice 14O — Post-firewall Phase D live read-only counts

**Status:** complete (offline RED/GREEN + live firewall prestate + credential preflight + one count attempt; zero mutation)
**Master basis:** `c0874b04a622190766e74c443bc361e1776ef02f`
**Generated:** 2026-07-19T21:24:27.762Z

## Outcome

Firewall prestate **ok** (Ready=Ready, publicNetworkAccess=Enabled, rulesCount=3, AllowLunaboxEgress=20.238.124.76/32, outbound matched=true, putCount=0, armGet=2, outboundIpGet=2).

Credential preflight **ok** (host/database/sslmode=verify-full, secretTargetValid=true, httpCallsDelta=2, clientsInstantiated=0).

Live count **ok** (total_rows=0, date_window_violations=0, price_unit_violations=0, clientsInstantiated=1, connectCalls=1, queryCalls=6, endCalls=1, sessions=1, httpRequestCount=2).

Outcome code: `phase_d_post_firewall_counts_ok`.

Sequence: post-firewall ARM/outbound prestate → merged 14F/14G metadata credential-preflight → exactly one merged 14D/14E managed-identity count-only path (`application_name=wh-sunset-phase-d-preflight`, `BEGIN READ ONLY`, transaction_read_only verify, locked catalog checks, exact 14A aggregate for total_rows/date_window_violations/price_unit_violations, COMMIT/ROLLBACK, end). On blocker: existing secret-free classifier; no retry. Verify never re-runs live.

Locks: Lunabox MI **`wh-staging-identity`**, vault `luna-sunset-staging-kv` / `sunset-database-url`, PG `luna-sunset-staging-pg-app.postgres.database.azure.com:5432/sunset_staging`, TLS `sslmode=verify-full`, firewall **`AllowLunaboxEgress`** `20.238.124.76/32`.

## Operator command (count-only; default-disabled)

```bash
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_LIVE_EXECUTE_COUNT_ONLY=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:live-readonly-count-only -- --execute-count-only --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
```

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default zero HTTP+Clients; missing execute gate; wrong/forbidden argv; MI requires env+argv; firewall outbound/rule-count/server-not-ready zero PG; connect classifier secret sanitize |
| GREEN | injected firewall prestate exact three rules; injected HTTP → fake Client exact sequence; CLI gates; CLI default refuse; locks; APPLY disabled; connect classifier mappings |

## Non-goals / still open

- **No** Phase D constraint apply, DDL, or ledger write
- **No** RBAC/KV/network/firewall mutation
- Still `product_schema_differs`
- **Do not claim Sunset repaired.**

## Zero DB mutation

Read-only `BEGIN READ ONLY` aggregate counts only (when count runs). Private refs zeroed. No secret value/version/id in evidence. No INSERT/UPDATE/DELETE. No apply/DDL. Firewall prestate is GET-only (`putCount=0`).

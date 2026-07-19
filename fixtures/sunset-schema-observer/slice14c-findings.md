# FOUNDATION Slice 14C — Phase D live read-only PostgreSQL adapter

**Status:** complete (real adapter implemented; live execution hard-disabled; offline fake-Client proof)
**Master basis:** `ff136a18c1582e7749220ed00dcb1a7d51c0b999`
**Generated:** 2026-07-19T19:05:37.079Z

## Outcome

Implemented the real PostgreSQL read-only adapter behind the merged Slice **14B** boundary. The adapter creates a `pg` Client **only after** all 14B gates pass, builds config exclusively from locked TARGETS + protected admin env (`SUNSET_STAGING_PG_ADMIN_USER` / `SUNSET_STAGING_PG_ADMIN_PASSWORD`), reuses verified TLS (`rejectUnauthorized: true` + `servername` = locked FQDN) and `statement_timeout=30000`, and executes only the exact authorized 14A sequence:

1. `BEGIN READ ONLY`
2. `SHOW transaction_read_only`
3. locked catalog table check
4. locked catalog column check
5. exact aggregate (count-only)
6. `COMMIT` (or `ROLLBACK` on failure)

`client.end()` is attempted exactly once in `finally` after connect/query success or failure. Close/end failure is **fail-closed**: otherwise-successful runs become `ok:false` / `code:close_failed` / `closed:false` (count-only data may be preserved; never a successful completed adapter run). If connect/query/commit already failed, the primary code is retained and sanitized `closeFailure=true` / `closeError` metadata is attached. Live execution remains hard-disabled (`PHASE_D_LIVE_READONLY_CONNECT_ENABLED=false`). Default and live-disabled paths instantiate **zero** Clients.

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default zero Clients; caller DSN/host/query; observer DSN; wrong/reordered/extra SQL; connect/query/commit failures sanitized; close failure fail-closed (`close_failed`); query+close failure retains primary query code; rollback+close on failure |
| GREEN | live-disabled exact target → zero Clients; exact sequence count-only success with fake Client; TLS+timeout in secret-free config view |

## Non-goals / still open

- **No** live/Azure query, firewall/network, credential loading, enable-flag flip
- **No** DDL/apply/ledger, migration, or 14A/14B target/predicate changes
- Still `product_schema_differs`
- Phase D CHECK ADD remains a later slice
- **Do not claim Sunset repaired.**

## Zero live/Azure mutation

This disposable proof used a scripted fake `pg` Client only. No Azure CLI, no live PostgreSQL, no Key Vault credential load, no network/firewall mutation.

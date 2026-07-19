# FOUNDATION Slice 14B — Phase D live read-only connection boundary

**Status:** complete (boundary gates; CONNECT_ENABLED activated in 14D; offline injected-adapter proof; boundary never connects)
**Master basis:** `8905be445fcce5d23e813f66d339c48580c5ecd9`
**Generated:** 2026-07-19T19:13:56.392Z

## Outcome

Added a live read-only connection boundary that gates the merged Slice **14A** count-only preflight against the exact Sunset staging PostgreSQL/database. Slice **14D** activates `PHASE_D_LIVE_READONLY_CONNECT_ENABLED`; this boundary still never opens sockets.

### Locked target

| Lock | Value |
|------|-------|
| Subscription | `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9` |
| Resource group | `luna-sunset-staging-rg` |
| Server | `luna-sunset-staging-pg-app` |
| FQDN | `luna-sunset-staging-pg-app.postgres.database.azure.com` |
| Database | `sunset_staging` |
| TLS | `sslmode=verify-full` |
| application_name | `wh-sunset-phase-d-preflight` |
| Transaction | `BEGIN READ ONLY` |

### Credential boundary

Credentials may come **only** from protected admin env populated by the existing locked loader (`scripts/load-sunset-staging-pg-admin-env.js` → Key Vault `sunset-database-url`):

- `SUNSET_STAGING_PG_ADMIN_USER`
- `SUNSET_STAGING_PG_ADMIN_PASSWORD`

Connection config is constructed **only** for the locked host/database (`sslmode=verify-full`, `application_name=wh-sunset-phase-d-preflight`).

**Never** accepted: caller-supplied DSN, argv credential, `SUNSET_SCHEMA_OBSERVER_DATABASE_URL` (CONNECT-only / no SELECT), `WOLFHOUSE_DATABASE_URL`, or arbitrary file path.

Username/password are **never** printed, persisted, returned, hashed, or included in evidence/errors.

### Query boundary

Only Slice **14A** catalog queries + its exact aggregate (plus session `BEGIN READ ONLY` / `SHOW transaction_read_only` / `COMMIT` / `ROLLBACK`) are authorized. Results/errors remain **count-only** and **secret-free**. 14A predicates are **unchanged**.

## Offline proof matrix (injected adapters)

| Case | Result |
|------|--------|
| Default path (no dual flags) | RED — zero connection calls |
| Exact target + dual flags + protected admin env | GREEN accept — ready (0 connect/query in boundary) |
| Wrong subscription / RG / host / database / TLS | RED before connect |
| Observer DSN / missing / partial admin credentials | RED before connect |
| Caller-supplied DSN / argv / WOLFHOUSE_DATABASE_URL / file path | RED before connect |
| Firewall/network mutation planned | RED |
| Unauthorized SQL | RED |
| 14A catalog + aggregate + session SQL | GREEN authorize |
| Live adapter factory placeholder | RED refused (CLI/adapter is live entry) |

## Unchanged hashes (byte-identical)

| Artifact | Hash |
|----------|------|
| Migration 028 | `f9972026a236b21c87442429e1b34e6951adca3e81cc84a88e82d538fa62e240` |
| Migration 035 | `924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565` |
| Migration 040 | `880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd` |
| Migration 041 | `3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09` |
| Manifest | `99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e` |
| Product fingerprint | `120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18` |
| expected-product-schema.json bytes | `cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5` |
| Forward count | **39** (unchanged) |

## Non-claims

**Do not claim** Sunset is repaired. Phase D `ADD CONSTRAINT` is **not** implemented. Boundary connect/query remains **zero** in 14B proof; Client wiring is gated in 14D. Zero live/Azure mutation. No firewall, ledger, migration, apply flag, or live evidence. No observer role/grant or Key Vault loader changes.

## Commands

```bash
npm run prove:sunset-schema-slice14b-phase-d-live-readonly-boundary
npm run verify:sunset-schema-slice14b
```

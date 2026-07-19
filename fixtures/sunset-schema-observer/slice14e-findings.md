# FOUNDATION Slice 14E — Phase D managed-identity credential loader

**Status:** complete (live HTTP hard-disabled; offline injected-HTTP proof; no live IMDS/KV/PG)
**Master basis:** `6e7c7d6f70e11b2ce77d28d367fc669b60eabe3a`
**Generated:** 2026-07-19T19:28:14.006Z

## Outcome

Made the merged count-only CLI able to obtain protected admin credentials **in-process** from Lunabox managed identity + the exact Sunset staging Key Vault secret `sunset-database-url`, while performing **no real IMDS / Key Vault / PostgreSQL call** in this slice.

Locks:

| Lock | Value |
|------|-------|
| IMDS host | `169.254.169.254` |
| Vault resource audience | `https://vault.azure.net` |
| Key Vault name / HTTPS | `luna-sunset-staging-kv` / `https://luna-sunset-staging-kv.vault.azure.net` |
| Secret name | `sunset-database-url` |
| IMDS API version | `2018-02-01` |
| Key Vault API version | `7.4` |
| MI client id | `0e05fbe3-e8c5-48aa-a914-30aed284e6f7` |
| PG host / database / TLS | `luna-sunset-staging-pg-app.postgres.database.azure.com` / `sunset_staging` / `verify-full` |

Caller URLs / names / tokens / DSNs are rejected. Secret is parsed only in memory; user/password validated against the exact target; passed privately to the existing 14D adapter; then private refs are zeroed. Token / DSN / credentials are never printed, returned, persisted, hashed, evidenced, argv-embedded, temp-filed, or child-process-env'd.

## Credential sources

- **protected-admin-env** (default / 14D offline proof): `SUNSET_STAGING_PG_ADMIN_USER` / `SUNSET_STAGING_PG_ADMIN_PASSWORD`
- **managed-identity** (explicit): requires both `SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity` and `--credential-source managed-identity`

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default zero HTTP+Clients; MI without inject → http_disabled; flag requires env+argv; caller overrides; wrong IMDS/vault/audience/secret/target/JSON/status/redirect before Client; password-bearing errors sanitized |
| GREEN | injected HTTP success → fake Client + exact count-only sequence; secret lifetime zero; protected-admin-env preserved; CLI gates; locks |

## Non-goals / still open

- **No** live secret read, Azure/PG query, firewall/network, DDL/apply/ledger
- **No** migration or predicate changes
- Still `product_schema_differs`
- Live MI HTTP enablement remains a later slice
- **Do not claim Sunset repaired.**

## Zero live/Azure mutation

Offline injected HTTP + fake `pg` Client only. `PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED=false`. No Azure CLI, no live PostgreSQL, no real Key Vault read, no network/firewall mutation.

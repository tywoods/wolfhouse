# FOUNDATION Slice 14E — Phase D managed-identity credential loader

**Status:** complete (`PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED=true` since Slice 14G; offline injected-HTTP proof only; no live IMDS/KV/PG in this prove)
**Master basis:** `6e7c7d6f70e11b2ce77d28d367fc669b60eabe3a`
**Generated:** 2026-07-19T19:46:39.280Z

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
| Lunabox MI name | `wh-staging-identity` |
| Lunabox MI client id | `0dd41fa2-52c8-4e04-bc23-8aa462938c19` |
| Lunabox MI principal id | `e3136eed-948b-4947-a26e-50a33b45a41a` |
| Lunabox VM | `/subscriptions/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9/resourceGroups/wh-staging-rg/providers/Microsoft.Compute/virtualMachines/lunabox` |
| PG host / database / TLS | `luna-sunset-staging-pg-app.postgres.database.azure.com` / `sunset_staging` / `verify-full` |

IMDS request `client_id` must equal the locked Lunabox `wh-staging-identity` client id (never omit / system / default / arbitrary). When the IMDS token JSON exposes identity metadata (`client_id` / `principal_id` / name), it must match; mismatch is rejected **before** Key Vault.

Caller URLs / names / tokens / DSNs are rejected. Secret is parsed only in memory; user/password validated against the exact target; passed privately to the existing 14D adapter; then private refs are zeroed. Token / DSN / credentials are never printed, returned, persisted, hashed, evidenced, argv-embedded, temp-filed, or child-process-env'd.

## Credential sources

- **protected-admin-env** (default / 14D offline proof): `SUNSET_STAGING_PG_ADMIN_USER` / `SUNSET_STAGING_PG_ADMIN_PASSWORD`
- **managed-identity** (explicit): requires both `SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity` and `--credential-source managed-identity`

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default zero HTTP+Clients; live HTTP activated → offline inject required (no ungated MI call); flag requires env+argv; caller overrides; wrong IMDS/vault/audience/secret/target/JSON/status/redirect before Client; wrong/omitted IMDS client_id or token identity rejected before KV; password-bearing errors sanitized |
| GREEN | injected HTTP success → fake Client + exact count-only sequence; secret lifetime zero; protected-admin-env preserved; CLI gates; locks (wh-staging-identity) |

## Non-goals / still open

- **No** live secret read, Azure/PG query, firewall/network, DDL/apply/ledger **in this offline prove**
- **No** migration or predicate changes
- Still `product_schema_differs`
- Live MI HTTP activated in Slice 14G (`PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED=true`); ungated live calls are 14G scope, not this prove
- **Do not claim Sunset repaired.**

## Zero live/Azure mutation (this prove)

Offline injected HTTP + fake `pg` Client only. Flag is `PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED=true` but this prove never calls live IMDS/KV/PG. No Azure CLI, no live PostgreSQL, no real Key Vault read, no network/firewall mutation.

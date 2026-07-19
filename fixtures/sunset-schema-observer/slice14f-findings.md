# FOUNDATION Slice 14F — Phase D credential-preflight activation

**Status:** complete (`PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED=true` since Slice 14G; offline injected-HTTP proof only; no live IMDS/KV/PG in this prove; no pg Client)
**Master basis:** `7467642653a54eb2db373e26bfc752865c1b55df`
**Generated:** 2026-07-19T19:46:39.469Z

## Outcome

Activated the merged **14E** managed-identity HTTP loader behind an explicit **metadata-only** credential-preflight command, while performing **no real IMDS / Key Vault / PostgreSQL call** in this slice. The count-only DB command is **unchanged**.

Locks confirmed on the CLI: Lunabox MI **`wh-staging-identity`**, vault `luna-sunset-staging-kv`, secret `sunset-database-url`, VM `lunabox` in `wh-staging-rg`, PG host/database/`sslmode=verify-full`.

Requires exact subscription / RG / VM identity / vault / secret / PG target args plus:

- `SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity`
- `--credential-source managed-identity`
- dedicated env `SUNSET_PHASE_D_CREDENTIAL_PREFLIGHT=1`
- `--credential-preflight-only`

Default / missing / wrong inputs make **zero HTTP** and **zero pg Clients**. On approved offline execution (injected HTTP): exact locked IMDS GET then exact locked Key Vault secret GET; validate secret DSN in memory; immediately zero private refs; output only safe booleans + identity/vault/secret/PG host/database/TLS — never token, DSN, user/password, version values, secret metadata IDs, or hashes. Never instantiates a pg Client. No POST/PUT/PATCH/DELETE. No caller URLs/tokens. Zero persistence / child-env credentials.

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default zero HTTP+Clients; missing env/flag/targets; MI flag requires env+argv; caller overrides; forbidden argv; redirects/status/body/identity sanitized; wrong secret target; no POST/PUT/PATCH/DELETE; live HTTP activated → offline inject required (no ungated preflight call) |
| GREEN | injected HTTP exact 2-call success + safe metadata; CLI gates; CLI default refuse; live HTTP flag on gates + injected path stays offline; locks |

## Non-goals / still open

- **No** live secret read, Azure/PG query, firewall/network, DDL/apply/ledger **in this offline prove**
- **No** migration or predicate changes
- Still `product_schema_differs`
- Live MI HTTP activated in Slice 14G (`PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED=true`); ungated live gated-CLI calls are 14G scope, not this prove
- **Do not claim Sunset repaired.**

## Zero live/Azure mutation (this prove)

Offline injected HTTP only. Flag is `PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED=true` but this prove never calls live IMDS/KV/PG. No Azure CLI, no live PostgreSQL, no real Key Vault read, no network/firewall mutation, no pg Client.

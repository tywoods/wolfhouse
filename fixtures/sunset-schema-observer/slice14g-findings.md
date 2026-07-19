# FOUNDATION Slice 14G — Phase D live metadata-only credential preflight

**Status:** complete (`PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED=true`; one live gated IMDS+KV GET; no pg Client; no apply/DDL)
**Master basis:** `cbd5512afbf73b0a84ead6113d6d919de7b2b411`
**Generated:** 2026-07-19T19:48:06.222Z

## Outcome

Live credential-preflight **blocked** (`blocker=http_status_rejected`, exitCode=2, httpCallsDelta=2, realImdsCall=true, realKeyVaultCall=true, clientsInstantiated=0).

Activated real Node `http`/`https` IMDS + Key Vault secret GET behind the existing **14F** credential-preflight gates. Offline proof uses injected HTTP only; live section spawns the CLI **once** with exact env+argv from `credentialPreflightEnv()` + `exactCredentialPreflightArgv()`. Never instantiates a pg Client. Count-only DB command **unchanged**.

Locks: Lunabox MI **`wh-staging-identity`**, vault `luna-sunset-staging-kv`, secret `sunset-database-url`, VM `lunabox` in `wh-staging-rg`, PG host/database/`sslmode=verify-full`.

## Operator command

```bash
SUNSET_PHASE_D_CREDENTIAL_PREFLIGHT=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:credential-preflight -- --credential-preflight-only --credential-source managed-identity --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --vm-resource-group wh-staging-rg --vm-name lunabox --managed-identity wh-staging-identity --key-vault luna-sunset-staging-kv --secret-name sunset-database-url --postgres-server luna-sunset-staging-pg-app --database sunset_staging
```

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default zero HTTP+Clients; missing env/flag/targets; live HTTP activated → offline inject required; forbidden argv; no POST/PUT/PATCH/DELETE |
| GREEN | injected HTTP exact 2-call success + safe metadata; CLI gates; CLI default refuse; locks; live HTTP transport in loader source |

## Non-goals / still open

- **No** pg Client or live PostgreSQL query
- **No** Phase D constraint apply, DDL, or ledger write
- **No** RBAC/KV/network change on live deny
- Still `product_schema_differs`
- **Do not claim Sunset repaired.**

## Zero DB mutation

Metadata-only credential preflight. Private refs zeroed immediately. No secret value/version/id in evidence. No PostgreSQL Client/connection. No apply/DDL.

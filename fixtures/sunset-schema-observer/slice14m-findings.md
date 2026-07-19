# FOUNDATION Slice 14M — Phase D live read-only counts (managed-identity)

**Status:** complete (offline RED/GREEN + code+message connect classifier + live credential preflight + diagnostic attempt 3; zero mutation)
**Master basis:** `45203b370997917fc8c3a39cf87948f46d9e5b5a`
**Generated:** 2026-07-19T20:55:45.068Z

## Outcome

Credential preflight **ok** (httpCallsDelta=2, realImdsCall=true, realKeyVaultCall=true).

Attempt 1 (retained, pre-classifier): **blocked** (`blocker=connect_failed`, code=`connect_failed`, clientsInstantiated=1, connectCalls=1, queryCalls=0, endCalls=1).

Attempt 2 (retained, code-classifier): **blocked** (`category=unknown`, `code=unknown`, clientsInstantiated=1, connectCalls=1, queryCalls=0, endCalls=1).

Diagnostic attempt 3 **blocked** (`category=timeout`, `code=MSG_TIMEOUT`, `blocker=timeout`, exitCode=2, clientsInstantiated=1, connectCalls=1, queryCalls=0, endCalls=1).

Outcome code: `phase_d_live_readonly_counts_blocked`.

Correction: when driver/SQLSTATE code classification is `unknown`, a second-stage secret-free classifier inspects capped `message`+`error.name` against anchored/fixed predicates and emits only a fixed category + fixed synthetic `MSG_*` code + fixed message `connect failed` (never raw text or matched fragments). Offline adversarial RED proves secret-bearing messages sanitize; GREEN proves each message class and code-first precedence. Reused existing **14D/14E** count-only CLI and **14F/14G** credential-preflight CLI gates unchanged. Live: credential-preflight once, then (only if preflight ok) exactly one diagnostic count (attempt 3) — no broad retry. Verify never re-runs live. Safe counts/category/code/counters only.

Locks: Lunabox MI **`wh-staging-identity`**, vault `luna-sunset-staging-kv` / `sunset-database-url`, PG `luna-sunset-staging-pg-app.postgres.database.azure.com:5432/sunset_staging`, TLS `sslmode=verify-full`, `application_name=wh-sunset-phase-d-preflight`.

## Operator command (count-only; default-disabled)

```bash
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_LIVE_EXECUTE_COUNT_ONLY=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:live-readonly-count-only -- --execute-count-only --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
```

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default zero HTTP+Clients; missing execute gate; wrong/forbidden argv; MI requires env+argv; connect classifier secret/unknown + adversarial message-class sanitize |
| GREEN | injected HTTP → fake Client exact sequence + call counters; CLI gates; CLI default refuse; locks; APPLY disabled; connect classifier code+message mappings + code-first precedence |

## Non-goals / still open

- **No** Phase D constraint apply, DDL, or ledger write
- **No** RBAC/KV/network mutation
- Still `product_schema_differs`
- **Do not claim Sunset repaired.**

## Zero DB mutation

Read-only `BEGIN READ ONLY` aggregate counts only. Private refs zeroed. No secret value/version/id in evidence. No INSERT/UPDATE/DELETE. No apply/DDL.

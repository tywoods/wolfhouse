# Email Luna controlled-drafting live preflight reader (Chapter 4H)

**Slice:** FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4H — private, fixed, server-owned Sunset staging live preflight reader. **BUILD/TEST/PR ONLY. Live proof is NOT EXECUTED.**

**Owner:** `scripts/lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader.js`

**Owned implementation:** `scripts/lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader-owned.js`

**Test-only seam:** `scripts/lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader.test-support.js` (not imported by production)

**Verifier:** `npm run verify:email-luna-controlled-drafting-live-downscope-prover-live-preflight-reader`

`LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER` remains frozen `false` with load-time throws. Chapter 4G live compose / `runProof` / CLI `--execute-once` still refuse **before** this reader can execute. This chapter builds and tests the reader with local fake Azure/ACR/PG adapters only.

## Ownership

The production owner exports `{readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg, isIndependentLivePreflight}` plus frozen pins and error identity. It does **not** export a generic callback/factory that a caller can use to brand evidence.

Adapter injection exists only as a closed constructor on the owned implementation module. Production re-exports do not include that constructor. Tests reach it through the test-support sibling. Production never selects adapters by env or opts.

Caller snapshots, including a perfect Chapter 4G snapshot, remain untrusted. `evaluateSunsetStagingLiveAppSnapshot` still must not mint `independent_read`. Only the owned reader may add the unexported WeakSet brand consumed by a future live `runProof`.

## Azure / ACR contract (measure, do not assume)

Read-only ARM GET + ACR manifest digest. No topology mutation, no `listSecrets`, no Key Vault secret GET, no Graph, no OAuth client-secret acquisition.

| Fact | Derivation |
| --- | --- |
| Subscription / RG / app / location / tenant tag | ARM container-app id, name, location, `tags.tenant` |
| Latest and latest-ready revision | ARM `latestRevisionName` / `latestReadyRevisionName` |
| Active revision + traffic 100% | Exactly one ingress traffic entry, weight 100, matching the pinned revision |
| Health / running / provisioning / replica | App `Running` + `Succeeded`; revision `Running` / `Healthy` / `Provisioned`; replicas exactly 1; scale min=max=1 |
| Image repository + tag / source SHA | Revision/app image `whstagingacr.azurecr.io/luna-sunset-staff-api:<40-hex-sha>` |
| Image digest | ACR `/v2/.../manifests/<tag>` `Docker-Content-Digest`, compared with revision runtime digest when present. Not caller text and not hardcoded-only |
| Eight flags | Each named env var explicitly present exactly once as literal string `false`. Unset / missing / duplicate / `secretRef` / boolean / `true` fail |

Pinned live target remains SHA `f6ee511273160cb46c72e345137800878d4c6512`, revision `luna-sunset-staging-staff-api--ch4f-f6ee5112`, digest `sha256:20d419d708a8e88115ccea3fb81bbd2a7d2ec67e0942c0be5be376d08d1a234a` unless later read-only evidence proves otherwise.

## PG contract

Canonical Sunset producer/worker direct LOGIN via the existing pair factory. Admin DSN (`WOLFHOUSE_DATABASE_URL`) is used only as the pair factory app identity and must be distinct. Worker LOGIN owns grant/count/binding reads. No `SET ROLE`. No DSN in evidence/errors. This chapter performs no writes (`BEGIN READ ONLY` / `ROLLBACK` on the production adapter).

| Fact | Derivation |
| --- | --- |
| Database identity | `current_database() = sunset_staging` |
| Tenant / location / binding | Azure env UUIDs + `tenant_channel_endpoints` / `tenant_locations` boolean SQL (no mailbox/address columns in evidence) |
| Direct LOGIN + ACL | Identity SQL fingerprints; Chapter 3 mapped-principal attest for producer then worker |
| TLS | `current_setting('ssl')` is `on`/`true` |
| 097 ops / 097 transitions / 098 auths | Owned `COUNT(*)` SQL inside the reader. Caller fields ignored |
| Grant / lease / reconcile | `tenant_email_delegated_grants` status/generation/lease boolean |

## Authority / TOCTOU / failure

| Situation | Result |
| --- | --- |
| Perfect caller snapshot | Untrusted. Not branded |
| Forged `{ok, independent_read}` / prototype / symbol / accessor / proxy | `isIndependentLivePreflight` false |
| Owned fake-adapter success | Branded sanitized evidence |
| Revision/digest/counts drift between the two fence reads | Fail closed (`revision_drift` / `digest_mismatch` / `counts_nonzero`) |
| Traffic split, replica 0/2, flag not exact `'false'` | Fail closed |
| LOGIN alias, TLS/ACL miss, tenant/location mismatch | Fail closed |
| Active lease, dead grant, reconcile ≠ clean | Fail closed |
| Fence age > 30s | `freshness` |
| Provider throw with planted secrets | Sanitized package error, no DSN/token/JWT |

Bounded double-read: Azure revision+digest and DB counts/generation must match start and end. Production clock is `Date.now`; tests may inject a clock only through the closed constructor.

## Non-goals

- No live proof, deploy, ACA/ACR/PG mutation, 098 consume, flag flip, send, Graph, JWKS, or Microsoft token
- No public adapter factory on the production owner
- No Staff API import or runtime wiring
- `LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER` stays false

## Next gate

A later separately authorized execution chapter may call the branded reader from live `runProof` after flipping chapter authority. That chapter still must not send, must not flip flags, and must not trust caller snapshots.

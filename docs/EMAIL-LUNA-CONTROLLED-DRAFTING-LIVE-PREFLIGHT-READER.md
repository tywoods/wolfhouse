# Email Luna controlled-drafting live preflight reader (Chapter 4H)

**Slice:** FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4H — private, fixed, server-owned Sunset staging live preflight reader. **BUILD/TEST/PR ONLY. Live proof is NOT EXECUTED.**

**Owner:** `scripts/lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader.js`

**Owned implementation:** `scripts/lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader-owned.js`

**Test-only seam:** `scripts/lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader.test-support.js` (not imported by production)

**Verifier:** `npm run verify:email-luna-controlled-drafting-live-downscope-prover-live-preflight-reader`

`LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER` remains frozen `false` with load-time throws. Production `readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg` and production adapter construction require that constant to be exactly `true` **before** IMDS/ARM/ACR/PG session acquisition. In this chapter it is exactly `false`, so direct `node -e` / REPL / import calls fail locally before IMDS. Chapter 4G live compose / `runProof` / CLI `--execute-once` still refuse **before** this reader can execute. Source-harness refusal remains defense in depth. This chapter builds and tests the reader with local fake Azure/ACR/PG adapters only. The fake constructor is not gated.

## Ownership

The production owner exports `{readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg, isIndependentLivePreflight}` plus frozen pins and error identity. It does **not** export a generic callback/factory that a caller can use to brand evidence.

Adapter injection exists only as a closed constructor on the owned implementation module. That constructor is exported by the owned module (not by the public owner). Tests reach it through the test-support sibling. Production never selects adapters by env or opts.

**Remaining LOW:** the owned implementation module is still directly require-able and still exports that constructor. This chapter does not split it into a third file. Mitigation is the closed live-execute gate on production adapters plus unforgeable WeakSet brand consumption in `inspectIndependentLivePreflight`. Public owner and live-target surfaces still do not export the constructor.

Caller snapshots, including a perfect Chapter 4G snapshot, remain untrusted. `evaluateSunsetStagingLiveAppSnapshot` still must not mint `independent_read`. Only the owned reader may add the unexported WeakSet brand. `runProof` consumes it through the pure `inspectIndependentLivePreflight(liveOwner, independent)` verifier immediately after `await readOwned()`, before field compare or token work. Missing, throwing, or non-boolean predicates fail closed. The verifier is exported so this chapter can exercise brand consumption without flipping the false live-execute gate.

## Azure / ACR contract (measure, do not assume)

Read-only ARM GET + ACR manifest digest. No topology mutation, no `listSecrets`, no Key Vault secret GET, no Graph, no OAuth client-secret acquisition.

| Fact | Derivation |
| --- | --- |
| Subscription / RG / app / location / tenant tag | ARM container-app id, name, location, `tags.tenant` |
| Latest and latest-ready revision | ARM `latestRevisionName` / `latestReadyRevisionName` |
| Active revision + traffic 100% | Exactly one ingress traffic entry, weight 100, matching the pinned revision |
| Health / running / provisioning / replica | App `Running` + `Succeeded`; revision `Running` / `Healthy` / `Provisioned`; replicas exactly 1; scale min=max=1 |
| Image repository + tag / source SHA | Measured running revision image identity: normalized `loginServer`, repository, and tag. Listed revision, direct revision GET, and app template must each exactly match the pinned owner (`whstagingacr.azurecr.io` / `luna-sunset-staff-api`) and the pinned 40-hex SHA. List-vs-direct and both fence reads compare the full identity. No partial/foreign registry acceptance. Evidence `image_login_server` / `image_repository` / `image_tag` come from those measured values after equality is proven — not from owner-constant fallback |
| Image digest | ACR `/v2/.../manifests/<tag>` `Docker-Content-Digest` must be canonical `sha256:<64hex>` and equal the independently read revision runtime digest. Null/absent/malformed runtime digest fail closed and cannot skip content identity. Not caller text and not hardcoded-only |
| Eight flags | Each named env var explicitly present exactly once as literal string `false`. Unset / missing / duplicate / `secretRef` / boolean / `true` fail |

Pinned live target remains SHA `f6ee511273160cb46c72e345137800878d4c6512`, revision `luna-sunset-staging-staff-api--ch4f-f6ee5112`, digest `sha256:20d419d708a8e88115ccea3fb81bbd2a7d2ec67e0942c0be5be376d08d1a234a`. These pins were **inherited from Chapters 4F/4G**. This source-only chapter does not measure a live deployed image. ACR digest is accepted only from HTTP 200 + `Docker-Content-Digest`; 401-with-header is unproven.

## PG contract

Canonical Sunset producer/worker direct LOGIN via the existing pair factory. Admin DSN (`WOLFHOUSE_DATABASE_URL`) is used only as the pair factory app identity and must be distinct. Worker LOGIN owns grant/count/binding reads. No `SET ROLE`. No DSN in evidence/errors. Production PG uses the pair factory's `withReadOnlyTransactionClient`: one top-level `BEGIN READ ONLY`, work, always `ROLLBACK`, never `COMMIT`, never nested `BEGIN` inside the pair factory's read-write `withTransactionClient`. Existing `withTransactionClient` callers are unchanged.

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

Bounded double-read: Azure revision+digest and DB counts/generation must match start and end. `sameFence` compares all authority-bearing identities and state, including complete revision image identity (`loginServer`, repository, tag), app image identity, traffic weight, client/location/endpoint/mailbox IDs, grant status/generation/reconcile/lease, binding flags, and LOGIN fingerprints. Production clock is `Date.now`; tests may inject a clock only through the closed constructor.

Evidence fields such as `oauth_called: false` / `kv_secret_called: false` / `token_called: false` / `jwks_called: false` / `graph_called: false` / `send_called: false` / `writes: false` are **declarations** of this chapter's closed surface, not measurements of a live attempt. Offline tests prove no live action from adapter-call counts and SQL transcripts.

## Non-goals

- No live proof, deploy, ACA/ACR/PG mutation, 098 consume, flag flip, send, Graph, JWKS, or Microsoft token
- No public adapter factory on the production owner
- No Staff API import or runtime wiring
- `LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER` stays false

## Next gate

A later separately authorized execution chapter may call the branded reader from live `runProof` after flipping chapter authority. That chapter still must not send, must not flip flags, and must not trust caller snapshots.

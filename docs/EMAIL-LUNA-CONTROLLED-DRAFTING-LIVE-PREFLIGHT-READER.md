# Email Luna controlled-drafting live preflight reader (Chapter 4H)

**Slice:** FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4H — private, fixed, server-owned Sunset staging live preflight reader. **BUILD/TEST/PR ONLY. Live proof is NOT EXECUTED.**

**Owner:** `scripts/lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader.js`

**Owned implementation:** `scripts/lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader-owned.js`

**Test-only seam:** `scripts/lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader.test-support.js` (not imported by production)

**Verifier:** `npm run verify:email-luna-controlled-drafting-live-downscope-prover-live-preflight-reader`

`LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER` remains frozen `false` with load-time throws. Production `readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg` and production adapter construction require that constant to be exactly `true` **before** IMDS/ARM/ACR/PG session acquisition. Chapter 4I does **not** OR an ambient mint/flag into this gate and does **not** open this gated constructor. Importing or using any public Chapter 4I export, or requiring the Chapter 4I CLI driver, leaves this reader chapter-disabled; direct `node -e` / REPL / import calls still fail locally before IMDS. Chapter 4G live compose / `runProof` / CLI `--execute-once` still refuse **before** this public reader can execute. A later Chapter 4I CLI-only driver may lexically construct measurement adapters only when executed as `require.main === module` after exact args, reviewed SHA/tree validation, and canonical receipt claim. Source-harness refusal remains defense in depth. This chapter builds and tests the reader with local fake Azure/ACR/PG adapters only. The fake constructor is not gated.

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
| Health / running / provisioning / replica | App `runningStatus=Running` + `Succeeded`; revision `Running` or ARM `RunningAtMaxScale` only when healthy, replicas exactly 1, scale min=max=1, and every traffic/flag/target fence still passes; `Provisioned` |
| Image repository + tag / source SHA | Measured running revision image identity: normalized `loginServer`, repository, and tag. Listed revision, direct revision GET, and app template must each exactly match the pinned owner (`whstagingacr.azurecr.io` / `luna-sunset-staff-api`) and the pinned 40-hex SHA. List-vs-direct and both fence reads compare the full identity. No partial/foreign registry acceptance. Evidence `image_login_server` / `image_repository` / `image_tag` come from those measured values after equality is proven — not from owner-constant fallback |
| Image digest | ACR `/v2/.../manifests/<tag>` `Docker-Content-Digest` is the digest authority and must be canonical `sha256:<64hex>` equal to the pinned digest. When ARM revision `properties.imageDigest` is present, it must independently equal that ACR digest. When ARM omits `properties.imageDigest` and the image is tag-only, do **not** copy the ACR digest into an ARM field; evidence records typed `arm_runtime_digest_unavailable=true` and still requires exact repository/tag/revision plus the ACR digest. Empty/malformed/wrong ARM digest and missing/wrong ACR digest fail closed. Not caller text and not hardcoded-only |
| Location | ARM display `North Europe` is closed-mapped to canonical `northeurope`. Unrelated locations, case variants, and extra whitespace fail closed |
| Eight flags | Each named env var explicitly present exactly once as literal string `false`. Unset / missing / duplicate / `secretRef` / boolean / `true` fail |

Pinned live target is SHA `a4188eea71a92b7361818e024cde0f810d6ee018`, revision `luna-sunset-staging-staff-api--0000682`, digest `sha256:820f302e8f59cfe8636eb0267c6f15bc0750f300b76735f511f3dde9c031dc39` (Chapter 4J retarget of the currently serving disabled artifact). Historical Chapter 4F pins are refused. ACR digest is accepted only from HTTP 200 + `Docker-Content-Digest`; 401-with-header is unproven.

## PG contract

Canonical Sunset producer/worker direct LOGIN via the existing pair factory. Admin DSN (`WOLFHOUSE_DATABASE_URL`) is used only as the pair factory app identity and must be distinct. Worker LOGIN owns grant/count/binding reads. No `SET ROLE`. No DSN in evidence/errors. Production PG uses the pair factory's `withReadOnlyTransactionClient`: one top-level `BEGIN READ ONLY`, work, always `ROLLBACK`, never `COMMIT`, never nested `BEGIN` inside the pair factory's read-write `withTransactionClient`. Existing `withTransactionClient` callers are unchanged.

| Fact | Derivation |
| --- | --- |
| Database identity | `current_database() = sunset_staging` |
| Tenant / location / binding | Azure env UUIDs + `tenant_channel_endpoints` / `tenant_locations` boolean SQL. Authentic brands also carry the exact measured `client_id` / `location_id` / `endpoint_id` / `mailbox_id` UUIDs (not mailbox addresses) |
| Direct LOGIN + ACL | Identity SQL fingerprints; Chapter 3 mapped-principal attest for producer then worker. Authentic brands carry `producer_login_fingerprint` / `worker_login_fingerprint` (64-hex) plus the existing login-ok booleans |
| TLS | `current_setting('ssl')` is `on`/`true` |
| 097 ops / 097 transitions / 098 auths | Owned `COUNT(*)` SQL inside the reader. Caller fields ignored |
| Grant / lease / reconcile | `tenant_email_delegated_grants` status/generation/lease. Authentic brands export integer `grant_generation` from the bounded double read; it is never omitted/undefined |

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

Bounded double-read: Azure revision+digest and DB counts/generation must match start and end. `sameFence` compares all authority-bearing identities and state, including complete revision image identity (`loginServer`, repository, tag), app image identity, traffic weight, client/location/endpoint/mailbox IDs, grant status/generation/reconcile/lease, binding flags, and LOGIN fingerprints. Those same sanitized values are copied onto the branded evidence and are forbidden from caller-supplied objects (`isIndependentLivePreflight` remains the unexported WeakSet). Production clock is `Date.now`; tests may inject a clock only through the closed constructor.

Evidence fields such as `oauth_called: false` / `kv_secret_called: false` / `token_called: false` / `jwks_called: false` / `graph_called: false` / `send_called: false` / `writes: false` are **declarations** of this chapter's closed surface, not measurements of a live attempt. Offline tests prove no live action from adapter-call counts and SQL transcripts.

## Non-goals

- No live proof, deploy, ACA/ACR/PG mutation, 098 consume, flag flip, send, Graph, JWKS, or Microsoft token
- No public adapter factory on the production owner
- No Staff API import or runtime wiring
- `LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER` stays false

## Next gate

Chapter 4J retargets this reader to the currently serving disabled Sunset artifact and authentic ARM `2024-03-01` mapping. Live execution must occur from the new reviewed candidate SHA/tree after exact-head review and true merge — not from `874bcde642d7eb4838529f84246c1c011db9861a`. Chapter 4I still owns the one-shot entrypoint and must invoke this production reader first, consuming the unexported brand through `inspectIndependentLivePreflight` before Key Vault / token / JWKS / custody PG. It must not flip `LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER` on this owner. Staff API startup stays inert. That chapter still must not send, must not flip flags, and must not trust caller snapshots.

# Email Luna controlled-drafting live downscope prover (Chapter 4E)

**Slice:** FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4E + 4G + 4H + 4I — source-only operator prover plus a dedicated Chapter 4I one-shot execution owner for a future live Microsoft downscope + shared Phase B grant continuity proof. Chapter 4G wires the exact deployed Sunset staging SHA. Chapter 4H adds the private owned Azure/ACR/PG preflight reader (merged as **#735**, `82a9eb9ae647d13e7ef11629fc87a44b94d067c6`). Chapter 4I owns the closed Sunset-only one-shot execution entrypoint. Live compose/runProof on this 4E owner remain **structurally disabled** (`LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER = false`). Do not flip that broadly imported constant. Chapter 4I does not open 4G compose or 4H production adapters via an ambient mint. Live proof is still **NOT EXECUTED**. Caller snapshots cannot mint a live brand.

**Owner:** `scripts/lib/email-luna-controlled-drafting-live-downscope-prover.js`

**CLI:** `scripts/email-luna-controlled-drafting-live-downscope-prover.js` (simulate / sunset-staging preparation; live execute gated)

**Verifier:** `npm run verify:email-luna-controlled-drafting-live-downscope-prover`

**Offline simulation:** `npm run prove:email-luna-controlled-drafting-live-downscope-prover-offline-simulation`

**Stock-PG LOGIN:** `npm run prove:email-luna-controlled-drafting-live-downscope-prover-stock-pg`

This chapter does **not** deploy, mint/refresh/introspect a live token, fetch Microsoft JWKS, call Graph/mailbox, mutate 098, flip flags, send, or change consent/grants. Chapter 4G fills `LIVE_DEPLOY_SHA_ALLOWLIST` with the immutable singleton `f6ee511273160cb46c72e345137800878d4c6512` (Sunset staging revision `luna-sunset-staging-staff-api--ch4f-f6ee5112`, digest `sha256:20d419d708a8e88115ccea3fb81bbd2a7d2ec67e0942c0be5be376d08d1a234a`). Exact `--target sunset-staging` is the only live target name. `--target live`, `--target azure`, Wolfhouse, production, aliases, equals-form flags, duplicates, extra args, and proxies still fail closed. CLI default for sunset-staging is **preparation/attestation only**. `--execute-once` is an additional gate and is **not authorized to acquire Azure/KV/live PG/Microsoft in this PR**. **Live proof remains NOT EXECUTED.**

## Architecture

Reuses canonical owners; does not clone custody, JWT, Graph, or SQL authority:

| Concern | Owner |
| --- | --- |
| Lease / open / CAS / reauth / reconcile / abort / public status / binding | `email-delegated-grant-custodian` |
| Refresh request + `controlled_drafting_v1` downscope `scope` | `email-microsoft-refresh-token-request` |
| Token-response classification (including `controlled_drafting_v1` and Phase B) | `email-microsoft-refresh-token-response-by-scope-version` |
| JWT signature | `createMicrosoftOidcJwksSignatureVerifier` |
| Draft `scp` (no `Mail.Send`) | Chapter 4C `createControlledDraftingAccessTokenClaimsInspector` |
| Staff-send `scp` (`User.Read Mail.ReadWrite Mail.Send`) | `createStaffSendPhaseBAccessTokenClaimsInspector` in the same claims module |
| Unscoped Phase B access-session (Gate 3, unchanged) | `createDelegatedGrantAccessSession` |
| Direct LOGIN mapping / 097+098 checksums | Chapter 4A session proof |
| Closed-data / proxy rejection | `email-luna-controlled-drafting-closed-data` |

The prover **must not** create a Graph provider. Production surface is `{attest, simulate, runProof}` only. No `getAccessToken`, `runClosed`, `withToken`, public callback, generic HTTP, or raw token return. A **fixed internal** consumer inspects signature-verified claims and returns a descriptor-safe sanitized summary.

Staff-send continuity uses the existing Phase B access-session owner with that fixed consumer. Gate 3 is not weakened. Continuity proves signed unscoped claims sufficient for the existing staff-send contract and custody health/generation continuity. It does not send and does not call Graph.

## Expected scopes (do not trust token-endpoint `scope` alone)

**Downscope request** (token form `scope`, Chapter 4C): `openid profile offline_access User.Read Mail.ReadWrite`

**Downscope JWT `scp` (authority after RS256 verify):** exact `User.Read Mail.ReadWrite`. `Mail.Send` absent. App-only `roles` absent.

**Staff-send unscoped refresh:** no `scope` parameter (full grant). JWT `scp` exact `User.Read Mail.ReadWrite Mail.Send`.

**OIDC in `scp`:** required OIDC scopes `openid profile offline_access` are requested on downscope and commonly appear on the TLS token-endpoint `scope` string. They typically **do not appear** in Graph access-token `scp`. This owner treats JWT `scp` as Graph delegated resources only. Unexpected OIDC tokens in `scp` fail closed (same as Chapter 4C). Token-endpoint `scope` is classified separately and is never JWT authority.

Issuer `https://login.microsoftonline.com/{tid}/v2.0` (or `https://sts.windows.net/{tid}/`), audience Graph, `ver=2.0`, tenant `tid`, account `oid` bound to canonical `provider_principal_oid` (never mailbox / `provider_resource_id`).

## Trust boundary

1. Exact Sunset own-user binding / provider principal / mailbox readiness (canonical binding DTO; no public address).
2. Direct producer and worker TCP LOGIN identity/ACL (not owner, not `SET ROLE`). Output is booleans + sha256 fingerprints only. Never DSN/password/host/user.
3. Downscoped access token cryptographically verified; exact draft `scp`; `Mail.Send` and send-capable `roles` excluded.
4. Raw token remains closed; zeroized after inspect; unreachable on the public surface.
5. Subsequent unscoped staff-send refresh/access-session proof without Graph/send.
6. Custody/generation/lease/reconciliation readback is truthful.

## Threat model

- Shared Phase B grant with staff send. Downscope may rotate the refresh token. Uncertain Microsoft/CAS/crash paths are mark-first fail-closed (Chapter 4C semantics). Stale custody must not republish `active/clean`.
- `invalid_grant`: inspect `markDelegatedGrantReauthorizationRequired`. Mark-fail/fenced → `uncertainty_persistence` / `persistence_unproven`, leave lease. Do not claim `dead_grant`.
- Token-endpoint `scope` can lie; JWT `scp` after JWKS RS256 is authority.
- Hostile args, duplicate flags, `--target=live`, production/Wolfhouse, HTTP(S) proxies, extra consumers, getters, symbols, thenables, cyclic/planted-secret errors.
- One process / one replica. Refuse active 097 ops, held leases, or uncertain grants. Sequence is downscope then continuity **once**. Rerun requires a new typed confirmation and a new prover instance.
- Evidence JSON: identifiers, fingerprints, scope names, kid/alg, equality booleans, generations, timestamps, phase statuses. No PII, mailbox address, IDs, DSNs, tokens, refresh tokens, secrets, or message content.

## Chapter 4I later live execution runbook / preflight (NOT EXECUTED in this builder)

Chapter 4G wired the exact-deployed-SHA target. A **later separately authorized execution chapter** may run the sensitive phase. This PR must not.

**Exact live target (immutable, no prefix, no env override, no secondary SHA):**

| Fact | Value |
| --- | --- |
| RG / app | `luna-sunset-staging-rg` / `luna-sunset-staging-staff-api` |
| Revision | `luna-sunset-staging-staff-api--ch4f-f6ee5112` |
| Deployed source/image SHA | `f6ee511273160cb46c72e345137800878d4c6512` |
| Digest | `sha256:20d419d708a8e88115ccea3fb81bbd2a7d2ec67e0942c0be5be376d08d1a234a` |
| Allowlist | singleton of that full SHA only |

**Operator-prover compatibility rule** (`chapter_4g_operator_cli_may_differ_from_deployed_app_sha`): the live target is the **deployed Staff API image**, not the operator CLI tree HEAD. Current origin/master may differ from `f6ee5112…` (this assignment: Pricing Code-field hide only). Canonical 4C/4E runtime owners listed in `CANONICAL_RUNTIME_OWNER_DIGESTS` are a **source-tree self-hash attestation**, not an independent image measurement, and **cannot establish deployed image truth**. A future fixed reader must compare the actual immutable deployed image/revision/digest against this exact approved compatibility contract. The Chapter 4G CLI/prover wiring is allowed to differ. Do **not** blindly require `source_sha === deploy_sha` and do **not** trust caller text for that claim.

**CLI (sole operator entry):**

```text
node scripts/email-luna-controlled-drafting-live-downscope-prover.js prove \
  --target sunset-staging \
  --deploy-sha f6ee511273160cb46c72e345137800878d4c6512 \
  --revision luna-sunset-staging-staff-api--ch4f-f6ee5112 \
  --digest sha256:20d419d708a8e88115ccea3fb81bbd2a7d2ec67e0942c0be5be376d08d1a234a \
  --confirm I_UNDERSTAND_SUNSET_STAGING_DOWNSCOPE_PROOF \
  --operator-nonce <64-lowercase-hex> \
  --confirm-issued-at <ISO-8601 now, 15-minute window>
```

Without `--execute-once` this is **preparation/attestation only**: zero token, JWKS, Graph, send, 098, Azure, KV, or live PG calls. Equals-form (`--target=sunset-staging`) is hostile.

`--execute-once` plus the typed confirmation bound to target/revision/SHA/digest/nonce/time-window is required before any sensitive dependency is acquired. This 4E/4G owner still **does not authorize** that sensitive phase (`live_execute_not_authorized_in_this_chapter`). Chapter 4I is the dedicated one-shot execution owner; see `docs/EMAIL-LUNA-CONTROLLED-DRAFTING-SUNSET-STAGING-LIVE-EXECUTION.md`. A source verify/prove harness cannot consume the live attempt (`source_test_cannot_consume_live_attempt`). One process; nonce replay fails; no automatic retry after an ambiguous Microsoft response. Do not retry `outcome_unknown`. Zero-send boundary: no Graph `/messages`, no provider send, no 097 operation create, no 098 consume. Post-proof audit is read-only.

**Independent live preflight (Chapter 4H implements the owned reader; live execute remains unauthorized):**

Chapter 4H owns `readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg`. `evaluateSunsetStagingLiveAppSnapshot` still validates untrusted caller snapshots against exact pins and **must not** mint `independent_read` or a live-proof brand. `runProof` / public compose still refuse with `live_execute_not_authorized_in_this_chapter` **before** the owned reader or KV/token/JWKS/PG run. After a future authorized `await readOwned()`, `runProof` calls `inspectIndependentLivePreflight(liveOwner, independent)` and requires the live-owner WeakSet predicate to return exactly `true` before reading fields or starting token work. 097/098 counts are never accepted from caller fields. See `docs/EMAIL-LUNA-CONTROLLED-DRAFTING-LIVE-PREFLIGHT-READER.md`.

Owned reader steps (measured; fail closed if any miss):

1. Confirm target **Sunset staging only**. Refuse production / Wolfhouse / `--target live` / `--target azure`.
2. Independently read the candidate app: exact revision, image SHA, digest, Running, latest-ready, 100% traffic, replica 1 / min=max=1.
3. All eight flags must be **explicitly present and literal `false`**. Unset fails (unlike offline fake, where unset is treated as false).
4. Independently read Sunset tenant / `sunset-somo` / database `sunset_staging`.
5. Canonical owner digest contract matches the deployed SHA.
6. Independently read 097 operations=0, 097 transitions=0, 098 authorizations=0. Do not consume 098. Do not trust argv/preflight injection.
7. Typed confirmation + fresh operator nonce + 15-minute issued-at window.
8. Direct LOGIN producer then worker. Abort on owner / `SET ROLE` / unmapped / wrong ACL / TLS failure. TLS is required for `sunset-staging`.
9. Binding + grant `active` + `reconcile_state=clean`. Abort if lease held, uncertain, or an active 097 operation exists.
10. Downscope refresh (`controlled_drafting_v1`) → JWKS verify → draft `scp` proof → reseal/CAS or omitted-RT abort.
11. Readback generation/status.
12. Unscoped staff-send access-session → staff-send `scp` proof. No Graph.
13. Readback. Write sanitized evidence JSON. Do not send. Do not flip flags.

`microsoft_live` / `jwks_live` mean **actual provider invocation / signature verification**, never composition-alone. Canonical live-owner composition is reported separately (`canonical_live_microsoft_transport_composed` / `canonical_live_jwks_factory_composed`). This chapter never contacts Microsoft.

If live proof fundamentally needs a separate grant, account, or broader capability than this shared Phase B downscope, **stop**. That is an architecture decision, not a code workaround.

## Abort / reconcile

| Situation | Action |
| --- | --- |
| Pre-Microsoft failure (status/lease/open/secret/grant_scope) | Abort lease if held. No uncertainty mark. |
| `refreshTokenOmitted` after classified success | Abort lease. No reseal, no generation bump, no `ms_response_uncertain`. |
| New refresh token | Canonical reseal + CAS. Exactly one generation on success. |
| Token HTTP timeout / unknown / unparseable / classify fail / missing access token | Mark-first `ms_response_uncertain`. Abort only after mark succeeds and abort preserves uncertain. |
| Mark-fail / fenced / expired | Leave lease. `uncertainty_persistence` / `persistence_unproven`. |
| `invalid_grant` mark-success | `dead_grant` (mark released the lease). |
| `invalid_grant` mark-fail | Leave lease. `persistence_unproven`. Not `dead_grant`. |
| Access-session continuity `uncertain` | Fail-closed. Do not claim staff-send continuity. |
| Operator abort | Do not retry after an ambiguous Microsoft response. New human confirmation, nonce, and issued-at required. |
| This-PR `--execute-once` | Do not acquire Azure/KV/PG/token/JWKS. Return gated reason. No lease. No 098. |
| Rollback / abort of a later live attempt | Leave grant fail-closed if post-Microsoft uncertainty persistence is unproven. Do not flip flags. Do not republish stale custody clean. Do not send. |

## Truth table

| Phase | Request `scope` | JWT `scp` | `Mail.Send` | Generation | Graph/send | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Simulate / CLI | none | none | n/a | unchanged | no | `simulation=true`, not a proof |
| Fake downscope success + new RT | draft set | `User.Read Mail.ReadWrite` | false | N→N+1 | no | `offline_fake_proof` |
| Fake downscope omitted RT | draft set | draft `scp` | false | N | no | abort, no bump |
| Fake continuity success + new RT | omitted | `User.Read Mail.ReadWrite Mail.Send` | true in **claims only** | N→N+1 | no | grant remains staff-send capable |
| Token-endpoint omits `Mail.Send` but JWT has it | draft set | includes `Mail.Send` | true | mark-first / claims fail | no | fail closed |
| Token-endpoint includes `Mail.Send` on downscope | send set | n/a | n/a | uncertain | no | fail closed |
| Live `--target=live` / `azure` | n/a | n/a | n/a | n/a | no | `target_live_alias_refused` |
| `sunset-staging` without exact SHA | n/a | n/a | n/a | n/a | no | `deploy_sha_not_allowlisted` (prefix/case/extra refused) |
| `sunset-staging` preparation (no `--execute-once`) | none | none | n/a | unchanged | no | `preparation=true`, `live_evidence=false`, zero sensitive deps |
| `sunset-staging --execute-once` in this PR | none | none | n/a | unchanged | no | `live_execute_not_authorized_in_this_chapter` (source tests: `source_test_cannot_consume_live_attempt`) |
| Later authorized live execute (NOT this PR) | draft then omitted | draft then staff-send | false then claims-only | N→N+1→N+2 | no | only if independent preflight branded-clean |

## Eight flags (all must be false)

1. `EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED`
2. `EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED`
3. `EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED`
4. `EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED`
5. `EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED`
6. `LUNA_AUTO_SEND_ENABLED`
7. `CUSTOMER_OUTREACH_WHATSAPP_ENABLED`
8. `STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED`

Replica: `EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT=1`.

## Evidence schema (sanitized)

Safe JSON only: `ok`, command, target, simulation/preparation/execute_once, `live_evidence`, `offline_fake_proof`, `microsoft_live`, `jwks_live` (actual invocation/verification only, never composition-alone), token/graph/send/journal/098 booleans, source_sha, deploy_sha, revision, digest, replica, `flags_all_false` / `flags_all_literal_false`, ops_097, transitions_097, rows_098, confirmation_accepted, LOGIN booleans + sha256 fingerprints, binding/own-user/mailbox booleans, principal/mailbox fingerprints (not raw IDs), downscope/continuity status + `scp` names, generations, grant_status, reconcile_state, kid/alg, iss/aud/oid/tid/ver/exp booleans, timestamps, phase statuses, compatibility_rule_id. **Never** raw DSNs, secrets, tokens, JWTs, mailbox addresses, PII, host/user/password, or message content.

Raw tokens remain inside closed owners and are zeroized after inspect. Hostile cyclic/proxy/getter/thenable/planted-secret errors must not leak them.

## Live dependency graph (fixed internal; CLI-only)

Public compose is gated by frozen `LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER = false` **before** inspecting env/getters. Future authorized composition (not this chapter): `env` (existing Sunset keys only) → `createActiveEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition` → `createSunsetMicrosoftOAuthClientSecretProvider` → `createMicrosoftTokenHttpTransport` (node:https) → `createMicrosoftOidcJwksSignatureVerifier` (node:https/crypto/timers) → `createEmailLunaControlledDraftingPrincipalConnectionPair` → live custody `withPgClient` from the **worker direct LOGIN DSN** (`EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_DATABASE_URL`), never Staff API admin `WOLFHOUSE_DATABASE_URL`. Connect failures sanitize as `pg_connect`; post-connect prover/custody failure identity is preserved; unknown work errors sanitize as `pg_work`. No Graph provider, no public factory callback, no Staff API import, no ACA command/flag edit, no new env vars/identities/OAuth apps/migrations.

## Non-goals

- No deploy, Azure/KV/ACA change, migration apply, or 098 live authorize/consume
- No live token mint/refresh/introspect, JWKS fetch against Microsoft, Graph call, or mailbox draft **in this PR**
- No consent/grant mutation
- No send, schedule-send, forward, or journal handoff
- No second OAuth architecture
- No generic token callback / header / client / fetch / request escape
- No new Azure resources, OAuth app, account, consent, env vars, identities, routes, ACA commands, or runtime startup wiring
- No deployment-flag edits
- Live proof remains **NOT EXECUTED** in this PR

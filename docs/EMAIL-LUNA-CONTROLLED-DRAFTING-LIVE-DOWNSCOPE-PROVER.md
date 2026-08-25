# Email Luna controlled-drafting live downscope prover (Chapter 4E)

**Slice:** FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4E — source-only, disabled-by-construction operator prover for a future live Microsoft downscope + shared Phase B grant continuity proof.

**Owner:** `scripts/lib/email-luna-controlled-drafting-live-downscope-prover.js`

**CLI:** `scripts/email-luna-controlled-drafting-live-downscope-prover.js` (simulate / refuse-live only)

**Verifier:** `npm run verify:email-luna-controlled-drafting-live-downscope-prover`

**Offline simulation:** `npm run prove:email-luna-controlled-drafting-live-downscope-prover-offline-simulation`

**Stock-PG LOGIN:** `npm run prove:email-luna-controlled-drafting-live-downscope-prover-stock-pg`

This chapter does **not** deploy, mint/refresh/introspect a live token, fetch Microsoft JWKS, call Graph/mailbox, mutate 098, flip flags, send, or change consent/grants. Live execution is structurally absent: `LIVE_DEPLOY_SHA_ALLOWLIST` is immutable empty. `--target=live` and `--target=sunset-staging` fail closed until a later exact-head review fills **one** exact deployed SHA.

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

## Future live runbook (not executable in this source)

Do **not** run this until a later exact-head review fills `LIVE_DEPLOY_SHA_ALLOWLIST` with exactly one deployed SHA and the operator has confirmed Sunset staging revision `--0000679` (or the then-current disabled revision), image digest, all eight flags false, replica 1, 097 ops=0, 098 auth=0.

1. Confirm target **Sunset staging only**. Refuse production / Wolfhouse.
2. Read back exact deployed SHA / revision / digest. Fail if source SHA ≠ deployed SHA.
3. Confirm all eight flags false and replica `1`.
4. Confirm 097 and 098 counts are zero. Do not consume 098.
5. Typed confirmation: `--confirm I_UNDERSTAND_SUNSET_STAGING_DOWNSCOPE_PROOF` (equals-form flags are hostile and fail closed)
6. Direct LOGIN producer then worker. Abort on owner / `SET ROLE` / unmapped / wrong ACL / TLS failure.
7. Binding + grant `active` + `reconcile_state=clean`. Abort if lease held or uncertain.
8. Downscope refresh (`controlled_drafting_v1`) → JWKS verify → draft `scp` proof → reseal/CAS or omitted-RT abort.
9. Readback generation/status.
10. Unscoped staff-send access-session → staff-send `scp` proof. No Graph.
11. Readback. Write sanitized evidence JSON. Do not send. Do not flip flags.

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
| Operator abort | Do not retry after an ambiguous Microsoft response. New human confirmation required. |

## Truth table

| Phase | Request `scope` | JWT `scp` | `Mail.Send` | Generation | Graph/send | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Simulate / CLI | none | none | n/a | unchanged | no | `simulation=true`, not a proof |
| Fake downscope success + new RT | draft set | `User.Read Mail.ReadWrite` | false | N→N+1 | no | `offline_fake_proof` |
| Fake downscope omitted RT | draft set | draft `scp` | false | N | no | abort, no bump |
| Fake continuity success + new RT | omitted | `User.Read Mail.ReadWrite Mail.Send` | true in **claims only** | N→N+1 | no | grant remains staff-send capable |
| Token-endpoint omits `Mail.Send` but JWT has it | draft set | includes `Mail.Send` | true | mark-first / claims fail | no | fail closed |
| Token-endpoint includes `Mail.Send` on downscope | send set | n/a | n/a | uncertain | no | fail closed |
| Live `--target=live` today | n/a | n/a | n/a | n/a | no | `live_mode_structurally_absent_until_reviewed_sha` |

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

## Non-goals

- No deploy, Azure/KV/ACA change, migration apply, or 098 live authorize/consume
- No live token mint/refresh/introspect, JWKS fetch against Microsoft, Graph call, or mailbox draft
- No consent/grant mutation
- No send, schedule-send, forward, or journal handoff
- No second OAuth architecture
- No generic token callback / header / client / fetch / request escape
- No new Azure resources, OAuth app, account, or consent

# Email Luna controlled-drafting token loan (Chapter 4C)

**Slice:** FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4C — draft-only Graph-bound token assembly and offline simulation (source only)

**Owner:** `scripts/lib/email-luna-controlled-drafting-token-loan.js`

**Live assembly:** `scripts/lib/email-luna-controlled-drafting-sunset-staging-token-loan.js`

**Claims inspector:** `scripts/lib/email-luna-controlled-drafting-access-token-claims.js`

**Harness:** `scripts/email-luna-controlled-drafting-one-shot-live-proof.js` (offline simulation; default dry-run; compatibility wrapper)

**Verifier:** `npm run verify:email-luna-controlled-drafting-token-loan`

**Stock PostgreSQL proof:** `npm run prove:email-luna-controlled-drafting-token-loan-stock-pg` (SKIPs honestly when embedded PostgreSQL is unavailable)

This chapter adds a construction-time-fixed Microsoft Graph access-token capability for Chapter 1 draft transport, plus an operator **offline simulation** that currently runs against fakes/stock-PG only. It is not an operator live harness and cannot prove OAuth, Graph, or 098. It does not deploy, apply migrations, mint a live token, call Graph, create a mailbox draft, or send. A later separately reviewed chapter owns live operations.

## Architecture decision

Sunset staff outbound already uses Phase B delegated grants (`User.Read Mail.ReadWrite Mail.Send`) on the existing Gate 3 send-capable reply-draft transport. That path is unchanged.

Microsoft identity platform v2 documents that a `refresh_token` grant may include `scope` to **downscope** the issued **access** token. Tenant consent and the stored refresh-token grant remain Phase A/B (Mail.Send still consented for staff send). This assembly:

1. Opens the existing grant through canonical custody (lease → open → refresh).
2. Requests exact `openid profile offline_access User.Read Mail.ReadWrite` (never `Mail.Send`).
3. Classifies the token-response `scope` with `controlled_drafting_v1`. Broader tokens (including `Mail.Send`) are `uncertain` and refuse before Graph.
4. Verifies compact JWS access-token signatures with the existing OIDC JWKS RS256 owner, then inspects `scp` / `aud` / `tid` / `azp|appid` / `oid` / `exp` / `nbf`. App-only `roles`, opaque/JWE/`alg none`, and unsigned decoded claims are refused.
5. Binds JWT `oid` to the canonical database `provider_principal_oid` (not mailbox / `provider_resource_id`). Separately requires `provider_resource_id ===` configured mailbox id and exact own-user binding.
6. If Microsoft omits a new refresh token, releases the lease through the canonical owner **without** resealing or generation-bumping the shared Phase B grant. If Microsoft returns a new refresh token, uses canonical reseal/CAS; CAS/commit failure after a potentially rotating response marks `ms_response_uncertain` before returning.

**Live downscoping is unproven** until a signed token `scp` excludes `Mail.Send` **and** a later unscoped staff-send refresh succeeds. Microsoft does not guarantee tenant downscope behavior. If live Microsoft ignores downscope and always returns `Mail.Send` while staff send remains enabled on the same endpoint, this source **fails closed**.

Staff send continues to refresh **without** a `scope` parameter, so it still receives the full grant.

## Trust boundary

- **Issuance:** canonical TLS token endpoint via `createMicrosoftRefreshTokenRequestService` (`login.microsoftonline.com` `/organizations/oauth2/v2.0/token`).
- **Token-response `scope`:** Microsoft's TLS-authenticated statement of this access token. Not caller-selected.
- **JWT signature:** existing `createMicrosoftOidcJwksSignatureVerifier` (RS256, `login.microsoftonline.com/organizations/discovery/v2.0/keys`). Instances are module-private branded. The inspector accepts only canonical branded verifiers. The verifier is single-use; this assembly creates a new instance per Graph operation. It does not add a second JWKS parser or a handwritten RS256 implementation.
- **Claims:** read only after `verified === true`. Compact JWS split is structural. Unsigned decode is never authority.
- Graph access tokens can theoretically be JWE/opaque; those refuse.

Attestation/status expose booleans, `attestation_kind=configured_contract_only`, and `scope_profile_id` / `controlled_drafting_v1` only. Static capability attestation does **not** imply grant or JWKS readiness. Live readiness requires a later real preflight that still does not expose a token. Never token values, JWT claims, refresh secrets, or account PII.

## Closed Graph provider (no token escape)

Package-first. A private assembly creates the token executor with a **fixed** Chapter 1 Graph draft HTTP consumer once and returns only `{attest, createReplyDraft, reconcileDraft}`. Execution takes a tightly validated Graph draft operation descriptor (`create_reply_draft` / `reconcile_draft`) and never a caller callback.

Production token-loan exports do not include `runClosed`, `withToken`, `getAccessToken`, a raw token provider, or a factory that lets an importer choose an exfiltration consumer. Staff API, activation, Chapter 3, and package production exports receive only `{attest}` plus the closed Chapter 1 provider operations. The token executor is not a package-surface export.

The only code that may receive the access token is the privately bound Chapter 1 Graph draft transport HTTP consumer (`POST createReply` → `PATCH` → `GET` only). That consumer cannot retain/return/throw the token: results and errors are sanitized.

Test injection, if needed, lives in `scripts/lib/email-luna-controlled-drafting-token-loan.test-support.js` (explicitly test-only; not imported by Staff API or production package exports).

**Provider fact (Microsoft Graph permissions reference):** `Mail.ReadWrite` allows create, read, update, and delete of user mail and does **not** include permission to send mail. `Mail.Send` is required to send.

## Staff API / runtime

Staff API may construct the Chapter 1 closed live provider only after the exact live flag (`EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED=true`) and a valid closed Graph-provider attestation (`attestation_kind=configured_contract_only`). Default-off import/start remains inert and does not mint or refresh tokens.

Live provider flag without a valid closed Graph provider fails before reserve/claim/Graph. Chapter 3 still **claims create authority before refresh/Graph** (`createReplyDraft`). That terminal claim-before-refresh behavior is intentional: a token-loan failure after claim with no Graph POST is recorded as `token_loan_failed_after_claim_no_provider_post` (`provider_invoked=false`). Create authority is not unclaimed (097 at-most-once); a second POST is never authorized.

Kill switch / stop-drain prevents new provider calls. No Gate 3 send adapter, journal, or staff send route changes. Graph remains POST createReply → PATCH → GET only.

## Offline simulation (source only)

`npm run email-luna-controlled-drafting-one-shot-live-proof` is a **compatibility wrapper** for offline simulation (default `preflight`, dry-run). Output always identifies itself as simulation (`simulation: true`, `live_evidence: false`).

- Refuses production / Wolfhouse.
- Phase 0 preflight: revision, replica=1, flags, 097/098 checksums, LOGIN readiness, configured-contract-only profile without returning a token or calling Graph, 097/098 counts, authorization present/absent.
- Explicit inputs: authorization id, operation id, issuance id, typed recipient confirmation. Never auto-selects a guest. Prints `server_synthetic_evidence: false`.
- Ordered human apply boundaries: prepare 098 → runtime → composition → intake → tick → live provider. Not one irreversible command.
- Fake/in-memory/stock-PG mode never emits `consumed_098:true`, `provider_is_draft:true`, `graph_called:true`, or other live provider/DB evidence. Simulated apply uses `simulated_transition`, `would_consume_098`, `would_require_provider_is_draft`.
- Abort: live → intake/tick → runtime; preserve 097/098 evidence.
- `--target=live` is structurally absent (`LIVE_DEPLOY_SHA_ALLOWLIST` is empty) until a later operator script revision. Unknown, duplicate, and hostile args fail rather than last-win/ignore.

## Shared grant rotation

The Phase B grant is shared with staff send. Downscope refresh must not lock or silently rotate that grant unsafely:

| Microsoft response | Custody action |
| --- | --- |
| `refreshTokenOmitted` | Release/complete the lease via `abortDelegatedGrantLease`. Do **not** reseal or generation-bump. |
| New refresh token | Canonical reseal + CAS. Exactly one generation on success. |
| CAS/commit fail after a potentially rotating response | Mark `ms_response_uncertain` via canonical reconciliation **before** returning failure. Never leave DB claiming the old envelope is safely current. |

Stale CAS responses cannot overwrite a newer generation. Raw secrets never appear in status or errors.

## Non-goals

- No deploy, Azure/KV/ACA change, migration apply, or 098 live authorize/consume
- No live token mint/refresh/introspect, Graph call, or mailbox draft
- No consent/grant mutation
- No send, schedule-send, forward, or journal handoff
- No second OAuth architecture
- No generic token callback / header / client / fetch / request escape

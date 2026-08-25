# Email Luna controlled-drafting token loan (Chapter 4C)

**Slice:** FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4C — draft-only token loan and one-shot live-proof harness (source only)

**Owner:** `scripts/lib/email-luna-controlled-drafting-token-loan.js`

**Live assembly:** `scripts/lib/email-luna-controlled-drafting-sunset-staging-token-loan.js`

**Claims inspector:** `scripts/lib/email-luna-controlled-drafting-access-token-claims.js`

**Harness:** `scripts/email-luna-controlled-drafting-one-shot-live-proof.js` (default dry-run)

**Verifier:** `npm run verify:email-luna-controlled-drafting-token-loan`

**Stock PostgreSQL proof:** `npm run prove:email-luna-controlled-drafting-token-loan-stock-pg` (SKIPs honestly when embedded PostgreSQL is unavailable)

This chapter adds a closed Microsoft Graph access-token loan for Chapter 1 draft transport, plus an operator one-shot live-proof harness that currently runs against fakes/stock-PG only. It does not deploy, apply migrations, mint a live token, call Graph, create a mailbox draft, or send.

## Architecture decision

Sunset staff outbound already uses Phase B delegated grants (`User.Read Mail.ReadWrite Mail.Send`) on the existing Gate 3 send-capable reply-draft transport. That path is unchanged.

Microsoft identity platform v2 documents that a `refresh_token` grant may include `scope` to **downscope** the issued **access** token. Tenant consent and the stored refresh-token grant remain Phase A/B (Mail.Send still consented for staff send). This loan:

1. Opens the existing grant through canonical custody (lease → open → refresh → reseal → CAS).
2. Requests exact `openid profile offline_access User.Read Mail.ReadWrite` (never `Mail.Send`).
3. Classifies the token-response `scope` with `controlled_drafting_v1`. Broader tokens (including `Mail.Send`) are `uncertain` and refuse before Graph.
4. Verifies compact JWS access-token signatures with the existing OIDC JWKS RS256 owner, then inspects `scp` / `aud` / `tid` / `azp|appid` / `oid` / `exp` / `nbf`. App-only `roles`, opaque/JWE/`alg none`, and unsigned decoded claims are refused.

**Distinctions:**

| Layer | What it is | Mail.Send |
| --- | --- | --- |
| Tenant consent | Admin/user grant on the enterprise app | Still present for staff send |
| Refresh-token grant | Stored Phase A/B `scope_version` | Unchanged (`phase_a_v2` / `phase_b_v1`) |
| Requested scopes | Bound `controlled_drafting_v1` profile | Excluded |
| Access-token `scp` / token-response `scope` | This loan's authority | Must be absent |

If live Microsoft ignores downscope and always returns `Mail.Send` while staff send remains enabled on the same endpoint, this source **fails closed**. It does not silently accept a send-capable token behind closed transport. Operator decision at that point: separate OAuth account/app registration without `Mail.Send`, or a later reviewed exception. Expected incremental Azure cost of a separate grant is still **zero** new resources (same vault/app process); it would require additional consent/operator work, which this slice does not perform.

Staff send continues to refresh **without** a `scope` parameter, so it still receives the full grant.

## Trust boundary

- **Issuance:** canonical TLS token endpoint via `createMicrosoftRefreshTokenRequestService` (`login.microsoftonline.com` `/organizations/oauth2/v2.0/token`).
- **Token-response `scope`:** Microsoft's TLS-authenticated statement of this access token. Not caller-selected.
- **JWT signature:** existing `createMicrosoftOidcJwksSignatureVerifier` (RS256, `login.microsoftonline.com/organizations/discovery/v2.0/keys`). The verifier is single-use; this loan creates a new instance per `runClosed`. It does not add a second JWKS parser or a handwritten RS256 implementation.
- **Claims:** read only after `verified === true`. Compact JWS split is structural. Unsigned decode is never authority.
- Graph access tokens can theoretically be JWE/opaque; those refuse.

Attestation/status expose booleans and `scope_profile_id` / `controlled_drafting_v1` only. Never token values, JWT claims, refresh secrets, or account PII.

## Closed loan

Package-first. Consumed only inside Chapter 1 Graph draft transport construction. Public surface: `attest`, `runClosed`. Caller (Staff API / Chapter 3) gets no raw token, header, fetch, request, or Graph client. `getAccessToken` is removed from the live Graph transport factory.

Refresh is single-flight and bounded. Kill switch is rechecked before token acquisition and after refresh before the consumer. Short-lived loan references are nulled in `finally`.

**Provider fact (Microsoft Graph permissions reference):** `Mail.ReadWrite` allows create, read, update, and delete of user mail and does **not** include permission to send mail. `Mail.Send` is required to send.

## Staff API / runtime

Staff API may construct the Chapter 1 closed live provider only after the exact live flag (`EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED=true`) and a valid closed-loan attestation. Default-off import/start remains inert and does not mint or refresh tokens.

Live provider flag without a valid closed loan fails before reserve/claim/Graph. Chapter 3 still claims create authority before `createReplyDraft`. A token-loan failure after claim with no Graph POST is recorded as `token_loan_failed_after_claim_no_provider_post` (`provider_invoked=false`). Create authority is not unclaimed (097 at-most-once); a second POST is never authorized.

Kill switch / stop-drain prevents new provider calls. No Gate 3 send adapter, journal, or staff send route changes.

## One-shot harness (source only)

`npm run email-luna-controlled-drafting-one-shot-live-proof` (default `preflight`, dry-run).

- Refuses production / Wolfhouse.
- Phase 0 preflight: revision, replica=1, flags, 097/098 checksums, LOGIN readiness, token-loan profile without returning a token or calling Graph, 097/098 counts, authorization present/absent.
- Explicit inputs: authorization id, operation id, issuance id, typed recipient confirmation. Never auto-selects a guest. Prints `server_synthetic_evidence: false`.
- Ordered human apply boundaries: prepare 098 → runtime → composition → intake → tick → live provider. Not one irreversible command.
- After a fake one-shot create/reconcile: turns live/intake/tick off first; requires `isDraft=true`, 098 consumed, journal unchanged, Graph send not called.
- Abort: live → intake/tick → runtime; preserve 097/098 evidence.
- `--target=live` is structurally absent (`LIVE_DEPLOY_SHA_ALLOWLIST` is empty) until a later operator script revision.

## Non-goals

- No deploy, Azure/KV/ACA change, migration apply, or 098 live authorize/consume
- No live token mint/refresh/introspect, Graph call, or mailbox draft
- No consent/grant mutation
- No send, schedule-send, forward, or journal handoff
- No second OAuth architecture

# Email Luna controlled-drafting runtime composition

**Slice:** FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 3

**Owner:** `scripts/lib/email-luna-controlled-drafting-sunset-staging-runtime-composition.js`

**Verifier:** `npm run verify:email-luna-controlled-drafting-runtime-composition`

Sunset staging Luna may later create and reconcile a real Microsoft Graph reply draft, but cannot send. This chapter adds the disabled-by-default, offline-testable runtime composition that consumes authentic Stage 1 issuance/queue material, reserves and claims the Chapter 2 durable operation, and invokes only the Chapter 1 draft-only provider surface. It is not activated, not deployed, and does not make a live provider call.

## Architecture

Canonical owners remain:

- Stage 1 issuance / queue / principals / shadow runtime
- Chapter 1 closed provider (`attest`, `createReplyDraft`, `reconcileDraft`)
- Chapter 2 operation store (producer reserve, worker claim/record/reconcile)

This package is a small factory plus a worker-tick API. Producer and worker `withTransactionClient` functions are capability-split facades (producer: reserve/load; worker: load/claim/record/reconcile). Identical references, aliases of a shared store, swapped brands, table-owner, operator, and unmapped sessions are refused via branded loaners plus canonical `session_user` principal attestation. Each store transition uses one pinned Chapter 2 transaction. The provider is never the Gate 3 Graph adapter; send/sendMail/raw token/fetch/request are not reachable.

Default is fail-closed and disabled. Activation requires the exact string `true` on the composition flag plus exact Sunset tenant, location, mailbox, endpoint, and `microsoft_graph`. Wolfhouse, production, default, and flag substitutes are refused. `LUNA_AUTO_SEND_ENABLED` remains a hard refusal.

## Unknown-outcome proof

Microsoft Graph `createReply` (`POST /v1.0/users/{mailbox}/messages/{id}/createReply`):

- is **not** idempotent; each POST creates a new draft
- `client-request-id` is correlation, not an idempotency key
- clients cannot assign the Graph message `id`
- Chapter 1 `reconcileDraft` is GET by `provider_draft_id` only (`$select=id,isDraft,subject,body,toRecipients,conversationId`); missing required observations never become exact
- Chapter 1 create is POST createReply → PATCH → GET before any exact acknowledgement
- Chapter 1 has no list, search, or `$filter` surface

A createReply response lost before the draft id is persisted therefore **cannot** be observed with the real Chapter 1 capability. This chapter does not invent a search API and does not treat fake-transport replay as live Graph at-most-once.

Fail-closed at-most-once is the Chapter 2 claim bit:

1. Claim commits to `create_dispatched_outcome_unknown` before the provider call.
2. `createReplyDraft` runs only on first claim authority (`status !== replayed`).
3. Timeout, reset, abort, crash, or malformed/secret-bearing create results stay unknown. No second create, no PATCH-back, no send.
4. Unknown **without** a persisted provider draft id is `unknown_create_unobservable`: no provider call, never recreate-ready, possible orphan draft in the mailbox.
5. Unknown **with** a persisted provider draft id is GET-reconciled through Chapter 1.

Staff edit/delete of a **known** draft is terminal: modified-by-staff, removed-by-staff, or mismatch. Luna never overwrites, recreates, or sends.

## Disablement

Feature disablement stops new reserve, claim, and provider create/reconcile immediately.

Already-unknown operations: **no provider calls**; work is surfaced blocked. Safe GET-reconcile of a known id is not continued while disabled, because disablement is fail-closed and unknown-without-id cannot be reconciled anyway.

If a create acknowledgement is already in process-local memory in the same tick, local record may still persist (no new provider call). Crash after claim and before create remains unobservable.

## Non-goals

- No activation, deploy, Azure resource, or production change
- No live Microsoft Graph, OAuth consent, or grant/scope change
- No customer contact and no mailbox draft against a real mailbox
- No send, schedule-send, forward, reply-send, or journal handoff
- No generic HTTP client, raw Graph SDK, access token, or arbitrary path
- Does not replace staff Gate 3 outbound send
- Does not change Stage 1 NIGHTWATCH shadow runtime composition
- Does not apply migration 097

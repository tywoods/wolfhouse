# Email Luna controlled-drafting operation store

**Slice:** FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 2

**Owner:** `scripts/lib/email-luna-controlled-drafting-operation-store.js`

**Migration:** `097_tenant_email_luna_controlled_draft_operations.sql`

**Verifier:** `npm run verify:email-luna-controlled-drafting-operation-store`

**PGlite proof:** `npm run prove:email-luna-controlled-drafting-operation-store-pglite`

**Stock PostgreSQL proof:** `npm run prove:email-luna-controlled-drafting-operation-store-stock-pg` (SKIPs honestly when embedded PostgreSQL is unavailable)

Sunset staging Luna may later create and reconcile a real Microsoft Graph reply draft, but cannot send. This chapter only adds durable database state, a repository/store boundary, recovery semantics, and deterministic offline proofs. It is not activated.

## Architecture

Stage 1 already owns authentic issuance material (`092`), the automation queue (`086`), policy audit (`085`), and inbound envelopes (`063`/`082`). Chapter 1 froze an unwired draft-only provider contract.

Chapter 2 adds a **dedicated** operation table plus append-only transition journal. It does **not** extend `tenant_email_outbound_send_journal`. That journal is staff send authority (`createReply` → update → send at most once) and is the wrong owner for controlled drafting.

Trusted scope is loaded from existing Stage 1 rows:

- tenant / client, location, endpoint from `092` + `086` + `057`
- mailbox, inbound provider message, inbound provider thread from `063`
- recipient and draft digest from `092` / inbound sender
- policy / eligibility / validator versions from `086`
- canonical subject / body supplied at reserve are hashed in SQL with pgcrypto SHA-256 over UTF-8 using the exact `092` algorithm (`subject || NUL || body || NUL || language`); caller digest fields are not authority
- the authentic `086` queue row must remain `pending` or `claimed` for reserve and claim

A request cannot invent tenant, location, mailbox, inbound, thread, recipient, issuance, or operation identity.

## States

Explicit names. None claim delivery or send.

| State | Meaning |
| --- | --- |
| `reserved` | Provider create not started |
| `create_dispatched_outcome_unknown` | Create dispatched; local outcome unknown |
| `provider_draft_reconciled_exact` | Provider draft created and still exact |
| `provider_draft_modified_by_staff` | Staff modified the draft; no longer exact |
| `provider_draft_removed_by_staff` | Staff removed the draft |
| `provider_mismatch_blocked` | Provider identity/bindings mismatch; fail-closed review |

Create dispatch is claimed at most once. Repeated claims return the existing row. There is no attempt counter and no blind create retry. Unknown outcome cannot return to `reserved`; recovery is reconcile-only.

Staff-modified and staff-removed states are not recreate-ready. Recording success requires the exact provider draft id, `is_draft=true`, and the exact stored bindings. Mismatch never overwrites a stored provider draft id.

Provider ids reject `.`, `..`, `/`, `?`, `#`, `%`, backslash, whitespace/control/C0/DEL, and encoding/path-confusion equivalents such as `%2e%2e`, `%2f`, and `%5c` regardless of case. Legitimate opaque Graph ids from the existing Chapter 2 contract remain accepted.

## Store surface

`createEmailLunaControlledDraftingOperationStore({ withTransactionClient })` exposes:

- `reserveControlledDraft`
- `claimCreateDispatch`
- `recordProviderCreate` (acknowledgement is data from a future trusted composition boundary; this package does not call a provider)
- `reconcileProviderDraft`
- `loadControlledDraft`
- `assertAuthenticLoadedOperation`

One pinned client owns `BEGIN` / row locks / writes / `COMMIT` / `ROLLBACK`. There is no provider client, token, HTTP, or send method.

## Non-goals

- No worker/runtime composition or activation
- No OAuth, token exchange, or live Microsoft Graph calls
- No provider-side draft creation against a real mailbox
- No send, schedule-send, forward, or reply-send
- No send phase, send counter, send authorization, or outbound journal handoff
- No generic HTTP client, raw Graph SDK, or access token
- No production / Wolfhouse changes
- No customer contact
- Does not replace staff Gate 3 outbound send
- Does not weaken Stage 1 NIGHTWATCH shadow gates
- Does not prove that installed Sunset grants lack `Mail.Send` (Chapter 1 residual)

## Rollback

`097_tenant_email_luna_controlled_draft_operations_down.sql` takes ACCESS EXCLUSIVE locks on transitions then operations before emptiness checks, and refuses while rows exist. Empty rollback is repeatable and does not reopen send authority.

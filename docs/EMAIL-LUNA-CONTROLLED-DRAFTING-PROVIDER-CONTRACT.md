# Email Luna controlled-drafting provider contract

**Slice:** FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 1

**Owner:** `scripts/lib/email-luna-controlled-drafting-provider-contract.js`

**Verifier:** `npm run verify:email-luna-controlled-drafting-provider-contract`

Sunset staging Luna may later create a real Microsoft Graph reply draft, but cannot send. This chapter only freezes the canonical draft-only provider capability/authority contract and deterministic offline proofs. It is not activated.

## Architecture

Gate 3 staff outbound already owns `email-microsoft-graph-reply-draft-transport` (`createReply` → `updateApprovedDraft` → `sendDraft`/`sendMail` → `reconcileDraft`). That transport remains the staff send owner and is **not** the Stage 2 runtime-facing surface.

Chapter 1 adds a package-first boundary in front of the same Graph provider:

- Public operations: `createReplyDraft`, `reconcileDraft`, plus `attest`.
- Identities bound on every call: tenant, location, endpoint, mailbox, inbound provider message/thread, exact recipient, subject/body digest, issuance id, operation id, and draft id (reconcile).
- Graph path grammar: `POST .../createReply`, internal `PATCH` of that exact new draft, `GET ...?$select=id,isDraft,subject,body,toRecipients,conversationId`. `/send` and `/sendMail` are not mapped. Gate 3's send-capable transport is not the Stage 2 surface.
- Create is POST → validate `id,isDraft` → PATCH canonical subject/body/bound recipient → GET/reconcile observed fields before `draft_created`. Request digests are never stored as provider observations.
- Reconcile GET of a **known** id must observe all five fields (`subject_digest`, `body_digest`, `recipient_address`, `inbound_provider_thread_id`, `mailbox_id`). Mailbox is the bound request path, not provider JSON. Missing/HTML/extra/accessor/multiple-recipient observations are never `draft_present`. `isDraft=false` is mismatch/sent-closed. 404 is `draft_not_found`.
- Typed fake transport plus a closed draft-only Graph transport. No OAuth, no worker composition, no generic HTTP/path/token export.
- Classified GET-by-id observation (`draft_present`, `draft_modified`, `draft_not_found`, `draft_mismatch`) for a **known** provider draft id only. This is not a search API and cannot observe a lost createReply without a persisted draft id.

## Capability manifest

Closed enumerable capabilities. `create_reply_draft` and `reconcile_draft` are true. Send, schedule-send, forward-send, reply-send, generic HTTP, raw SDK, and access-token export are absent (`false`). This manifest is the authority — it does not read `LUNA_AUTO_SEND_ENABLED`.

## OAuth / scope profile

Existing Phase A / Phase B delegated contracts still include `Mail.Send` for staff outbound. **This chapter does not mutate those live contracts** and does not request consent.

Stage 2 uses an explicit `controlled_drafting_v1` profile:

- OIDC: `openid profile offline_access` (optional `email`)
- Graph delegated: `User.Read` + `Mail.ReadWrite`
- `Mail.Send` is excluded and rejected

**Provider fact (Microsoft Graph permissions reference):** `Mail.ReadWrite` allows create, read, update, and delete of user mail and does **not** include permission to send mail. `Mail.Send` is required to send. This profile therefore has the minimum Graph delegated scope for createReply / PATCH draft / GET draft, and omits send.

Residual: an already-consented Sunset Phase B grant may still *contain* `Mail.Send`. Chapter 1 does not strip that grant. The Stage 2 package has no send method, so this code path cannot invoke send even if a later token still has the scope.

## Non-goals

- No worker/runtime composition or activation
- No OAuth consent, token exchange, or config change
- No live Microsoft Graph calls
- No provider-side draft creation against a real mailbox
- No send, schedule-send, forward, or reply-send
- No generic HTTP client, raw Graph SDK, access token, or arbitrary URL/path/method
- No application send route, button, or action
- No production / Wolfhouse changes
- No customer contact
- Does not replace staff Gate 3 outbound send
- Does not weaken Stage 1 NIGHTWATCH shadow gates

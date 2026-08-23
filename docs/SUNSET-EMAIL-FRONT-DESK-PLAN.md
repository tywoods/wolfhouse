# Sunset Email Front Desk — Delivery Plan

**Scope:** Sunset staging first. Production remains untouched.
**Status:** Stages 1–3 proven and deployed; Stage 4 active.

## Staging activation rule

Sunset staging is the working test environment. After each reviewed increment is merged and deployed:

- turn the new feature on for the exact Sunset staging tenant/location;
- exercise it through the real Staff UI and a controlled mailbox;
- leave it on for operator testing when healthy;
- retain global and tenant/location kill switches;
- turn it off only for a demonstrated safety/reliability defect or while replacing a revision;
- never confuse “kill switch exists” with “feature should remain permanently disabled.”

No production activation is included in this plan.

## Stage 1 — Connect Microsoft email — CLOSED

- Microsoft delegated OAuth for Sunset Somo.
- Key Vault token custody and mailbox ownership binding.
- Read/refresh health in Staff Email Settings.
- Real staging mailbox connected and enabled.

**Exit:** Somo Microsoft mailbox connects and reports healthy in staging.

## Stage 2 — Email into the existing Inbox — CLOSED

- Exactly-once Microsoft Graph ingest.
- Project email into existing `conversations` and `messages`.
- Email channel badge and Somo location ownership.
- Keep email identities out of the WhatsApp transport.
- Leave staging ingest enabled for ongoing tests.

**Exit:** controlled inbound email appears once in the Staff Inbox.

## Stage 3 — Staff draft, approve, and send — CLOSED / REACTIVATION ACTIVE

- Manual draft save.
- Explicit staff approval.
- Graph `createReply`, update exact immutable draft, send exact draft.
- Durable exactly-once journal.
- Forced-uncertainty reconciliation and zero-call replay.
- Correct gate-off UI: email must never fall back to the WhatsApp send route.
- After the UI repair, enable staff email drafting/sending on Sunset Somo staging and leave it enabled for testing.

**Exit:** staff reply reaches the original controlled thread exactly once and remains usable in staging.

## Stage 4 — Luna email drafting — ACTIVE

Luna drafts; staff reviews and sends. Luna never approves or sends.

### Slice 4.1 — Trusted email envelope — MERGED

- Immutable tenant, location, and conversation authority.
- Email body, subject, quoted thread, HTML, and attachments treated as untrusted data.
- Draft-only output with no send capability.

### Slice 4.2 — Grounded read-only tools — IN REVIEW

- Read configured catalog, prices, policies, availability, booking details, and payment status through existing Staff API/DB owners.
- Bind every read to server-selected tenant and location.
- Reject model/caller authority overrides.
- Return typed `missing_fact` or `handoff_required` results.
- Exclude secrets, provider IDs, raw payment URLs, and active capabilities.

### Slice 4.3 — Deterministic draft-or-handoff policy

- Draft only when identity, intent, location, and required facts are sufficiently established.
- Explicit handoffs for ambiguity, unsupported requests, missing facts, tool failure, ownership mismatch, or human request.
- Prompt-injection and cross-location attempts fail closed.
- Trusted server composition must issue evidence immediately before the decision; model/email data must never receive the producer:

```js
const {
  issueAndDecideEmailLunaDraftPolicy,
} = require('../scripts/lib/email-luna-draft-policy');

// classifierSnapshot and groundedToolResults are outputs selected by trusted
// server wiring. The canonical operation validates/copies/freezes them and decides
// synchronously inside one private freshness scope; it does not infer truth.
const { evidence, decision } = issueAndDecideEmailLunaDraftPolicy({
  envelope,
  evidence: {
    ...classifierSnapshot,
    grounded_results: groundedToolResults,
  },
});
```

`issueAndDecideEmailLunaDraftPolicy` is the server-owned composition API. Do not expose it through a model tool, email payload, browser bundle, or generic request handler. Standalone evidence creation/decision is compatibility-only and deliberately fails closed as stale outside the private synchronous scope. Production wiring must supply the classifier and grounded-tool outputs.

### Slice 4.4 — Luna email author and SOUL

- Warm, capable front-desk host voice.
- Follow the guest’s language.
- Email-appropriate structure: concise paragraphs, direct answers, one clear next step.
- No invented facts, fake certainty, internal jargon, or repetitive emoji/openers.
- Schema-validate and fact-check drafts before saving.

### Slice 4.5 — Staff Inbox integration

- “Generate Luna draft” on an owned email thread.
- Editable result saved through the existing Stage 3 draft route.
- Staff remains the only approval/send authority.

### Slice 4.6 — Golden corpus

- English and Spanish.
- Pricing, policy, availability, booking, and payment-status questions.
- Missing details and ambiguous identity.
- Quoted-thread, HTML, attachment, and prompt-injection attacks.
- Somo/Sardinero and cross-tenant isolation.

### Slice 4.7 — Deployed staging activation

- Enable Luna drafting for Sunset Somo after reviewed deployment.
- Test real Inbox drafts and explicit handoffs.
- Prove no Luna send/approve capability.
- Leave healthy drafting enabled for operator testing.

**Exit:** Luna produces grounded editable drafts or explicit handoffs in the real staging Inbox; staff alone sends.

## Stage 5 — Gmail / Google Workspace connector

- Google OAuth onboarding in Email Settings.
- Gmail history/thread ingest behind the shared mailbox adapter.
- Gmail reply-draft, update, send, and reconciliation adapter.
- Reuse shared Inbox, Luna, approval, journal, isolation, and kill-switch layers.
- Enable one controlled Sunset staging Gmail mailbox and leave it on for testing.

**Exit:** Gmail mail ingests once and a staff-approved reply reaches the original Gmail thread exactly once.

## Stage 6 — Generic IMAP/SMTP connector

- Secure IMAP/SMTP settings and credentials in Key Vault.
- Support app-password/basic-secret providers only over verified TLS; provider-specific OAuth can be added behind the same adapter.
- IMAP UID/UIDVALIDITY and Message-ID based ingest identity.
- Standards-correct `In-Reply-To` / `References` threading.
- SMTP acceptance journal, uncertainty handling, reconciliation, and duplicate suppression.
- Provider presets plus custom host/port settings in Email Settings.
- Enable one controlled non-Microsoft/non-Gmail Sunset staging mailbox and leave it on for testing.

**Exit:** generic mailbox ingests once and a staff-approved SMTP reply is threaded and accepted once, including uncertainty/replay proof.

## Stage 7 — Copy the proven system to Sardinero

- Separate Sardinero endpoint and mailbox authority.
- Support any connector proven in Stages 1, 5, or 6.
- Independent health, ingest, Inbox, Luna drafting, approval, and send controls.
- Cross-location refusal tests.
- Enable Sardinero staging after deployed proof.

**Exit:** Somo and Sardinero operate independently without mailbox, conversation, booking, or location crossover.

## Shared guardrails

- Facts come only from Staff API/DB-owned evidence.
- Provider/mail content never selects tenant or location authority.
- Exactly-once ingest and outbound behavior.
- Staff approval required for every send.
- Luna has no approve/send capability.
- Secrets stay in Key Vault and never reach Luna, UI responses, or logs.
- Every connector is a provider adapter; Inbox, Luna, approval, and audit remain shared.
- Reviewed exact source, exact-image deployment, real staging UI/mailbox proof, and kill-switch verification for every stage.

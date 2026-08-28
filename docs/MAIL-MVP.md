# MAIL MVP

Living plan for ordinary front-desk email. Durable product facts only. No process IDs, DSNs, tokens, mailbox secrets, or live send evidence.

Sunset staging is the only later deploy target. This document does not authorize production, gateway/Hermes restart, `/sethome`, Salt, Deckhand, Full Sail 4J, auto-send enablement, IMAP/SMTP changes, provider sends, or live email actions. Slice 008 may create an unpaid 24-hour hold and a Staff API payment link during Create Draft; confirmation still waits for verified payment.

Staff API remains the only authority for prices, availability, payment URLs, and bookings. Never invent those facts. Every future send remains journaled.

## Slices

| Slice | Name | This job? | Status |
| --- | --- | --- | --- |
| **001** | Create Draft + context | Yes | Source slice: explicit staff click regenerates the standing draft from the authoritative thread plus private staff goals. The model may return only a closed enumerated drafting plan; a deterministic Luna renderer writes the guest-facing EN/ES copy. No paste wrapper, no send, no approval, no outbound journal. |
| **002** | Ty live proof | No | Later. Controlled Sunset mailbox proof of 001 on staging. Not this PR. |
| **003** | auto create-and-send | No | Microsoft-only automatic create-and-send. Default remains OFF. Both `LUNA_AUTO_SEND_ENABLED=true` and `LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED=true` are required for provider auto-send. Reuses Create Draft author + staff Approve & send owners. Dormant. Do not rebuild in 004. |
| **004** | auto proof | No | Landed. Bounded fail-closed Sunset-staging operator proof of 003. Default refuse. Do not rebuild. |
| **005** | generic IMAP inbound | No | Landed. Generic IMAP inbound connector. A verified sunset IMAP mailbox is polled, persisted, and projected into the same Staff Inbox conversations/messages journal as Graph (thread list + open thread, guest-linkable). Graph inbound on support@lunafrontdesk.com stays as-is. Auto stays off. |
| **006** | generic SMTP send | No | Landed. Generic SMTP send. Create Draft + Approve & send over SMTP for a generic mailbox, same staff Inbox loop as Microsoft. Every would-be send writes approval + outbound journal. Auto stays off. |
| **007** | Email Luna Hermes managed by Skipper | No | Landed. Dedicated Skipper-managed `hermes-sunset-email-luna` draft-only runtime. Auto remains OFF. |
| **008** | booking-from-email | Yes | Email hold + pay-to-book. Create Draft may include a Staff-API-created payment URL and the truthful 24-hour hold expiry. Booking commits only after a verified Stripe webhook. Unpaid holds expire and release inventory. Auto remains OFF. |

## 003 Microsoft auto create-and-send

Sunset Microsoft inbound only. Default remains OFF. Live flags stay false.

When Email channel mode is Auto, the conversation is Luna On, `needs_human` is false, and both emergency flags are the literal string `true` (`LUNA_AUTO_SEND_ENABLED` and `LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED`), Luna authors the same empty-context Create Draft standing draft and sends it through the same approval + outbound journal + provider transport owners as staff Approve & send. Exactly one approval, journal, and provider send per inbound operation. Duplicate Microsoft delivery is idempotent.

Luna Off, `needs_human`, global pause, and pause-lookup failure all block before draft/send. Author/tool/provider failure fail closed and do not mark sent. Generic IMAP/SMTP, Graph direct-send shortcuts, campaigns, WhatsApp, and booking create are excluded. `CUSTOMER_OUTREACH_EMAIL_ENABLED` is not a send gate.

WhatsApp add-on: `.hermes/plans/2026-08-26-sunset-whatsapp-autonomy-wiring.md` is not present; no WhatsApp evaluator cleanup in this slice.

## 004 auto proof (Sunset staging operator harness)

Proof of 003 only. Reuses `scripts/lib/email-luna-microsoft-auto-create-send.js`. Default remains OFF.

The harness refuses unless the operator types `I_UNDERSTAND_SUNSET_STAGING_MAIL_MVP_004_ONE_SHOT_AUTO_CREATE_AND_SEND` bound to `sunset-staging`, `luna-sunset-staging-staff-api`, the current 100% Healthy serving revision+image, a fresh 64-hex nonce, and a 15-minute window. Traffic is the actual ACA ingress weight (exactly one explicit 100% revision equal to latestReady/latest). Desired flag state is accepted only from that successor's immutable `az containerapp revision show` template env, and only when the revision is the exact authorized image tag+digest, `latest`==`latestReady`==the sole 100%-traffic revision, revision health is Healthy with an accepted running state, and at least one running replica from the replica list belongs to that exact revision. Exactly the two allowlisted flags must have literal desired values; duplicate, missing, or `secretRef` values fail closed, as does unrelated env mutation. ACA revision templates are immutable; readiness plus a running replica of that revision proves the running deployment of that template. Bound proof includes revision name, image tag, digest, and replica. Graph preflight remains a separate exact ACA exec before flags. Process `printenv` is preferred if it succeeds once; a trusted WebSocket HTTP 429 does not wait 630s/20m — ACA-native revision proof is then sufficient. Supervisor-owned issued-at and a durable one-use nonce bind the operation across process restart. It independently preflights zero/new selected-operation state for the existing guest-linked Microsoft thread subject `Testing 8 26` and authoritative inbound sender `twoods@xantrion.com` (not UI display `twoods`). Luna On and `needs_human` false are required. After the unchanged 003 `{status:'sent'}` return, leftover/Sol checks recompute evidence HMAC **inside the Staff replica** against durable approval `message_text` hash + selected source operation + tenant/location/conversation/request/provider/model/runtime. Host env HMAC and `evidence_mac` presence without recomputation are not proof. Default Graph arrival is a replica GET-only list through the reviewed Staff custody/token-loan owner (`$select` without body/bodyPreview). Kill-switch is replica-only before ON and after OFF. Conversation metadata HMAC booleans are not proof. Duplicate journal/provider outcomes succeed only at exact 1/1/1; partial is fail-closed.

A later authorized execution may temporarily set only `LUNA_AUTO_SEND_ENABLED=true` and `LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED=true`, prove the enabled serving revision, then put email channel mode `auto` on that attested successor only (same-image successor with 100% Healthy traffic and the two allowlisted flags literal true from the immutable revision template, or from one successful replica-process `printenv`; flag updates create a new revision; wait up to 10 minutes per successor at a 2s identity poll for readiness, fail-closed on timeout; Graph preflight already uses one ACA exec at t0; do not spend 20 minutes waiting on globally 429/unstable WebSocket exec; never reuse attestation across revision/replica or desired enabled state; exact native or process proof returns immediately), kill-switch the attested-false replica before ON and after OFF, invoke the canonical 003 owner once (inner ACA exec writes a one-shot request; the long-lived Staff API process claims it and runs 003 outside the exec cgroup; dispatch marker only after that Staff claim; inner capability is stamped after the enabled successor is attested so the 15-minute operator confirm window is not widened and does not expire during the wait). If ACA exec disconnects after the inner dispatch marker, do not retry the owner. Reconcile through a capability-free replica snapshot plus the durable dispatch receipt. A proven-zero no-send (dead pid, counts 0, Graph arrivals 0) may replace that no-retry marker once; a fresh nonce is still required. Then **always** restore both flags `false` and automation `off` in supervisor `finally` and attest the restored successor the same way. No public endpoint or new secret. Copied scripts in an old image are not proof: live dispatch requires a Staff image built from exact `origin/master` after this merge. Owner / proof: `npm run verify:mail-mvp-004`. Runbook: `docs/MAIL-MVP-004-SUNSET-AUTO-PROOF-RUNBOOK.md`.

This slice does not execute live send, deploy, or flag flips.

## 007 Email Luna Hermes Sol (Skipper-managed)

Sunset staging only. Dedicated internal draft service `hermes-sunset-email-luna` (`HERMES_ROLE=sunset-email-luna`). Durable Hermes config pins `model.provider: openai-codex` and `model.default: gpt-5.6-sol`. Isolated home is a Lunabox volume or a dedicated Azure Files mount of `/opt/data` (account `lunasunsetemailst`, share `hermes-sunset-email-luna-home`) with canonical Hermes path `/opt/data/.hermes` (`HOME=/opt/data`). CIFS stays `uid=10000,gid=10000,nobrl,mfsymlinks,dir_mode=0700,file_mode=0600`; email-role bootstrap unlinks the setup-owned `SOUL.md` then writes `.env`. Codex refresh rotations persist at `/opt/data/.hermes/auth.json` on that share. No Key Vault auth.json snapshot. No copies or symlinks. No WhatsApp/Discord gateway, no Staff booking plugin, no outbound email authority.

Staff API remains the sole renderer and the sole authority for prices, availability, bookings, holds, confirmations, and payment links. Hermes is invoked in-process through the installed openai-codex composition. The draft service returns a closed enumerated plan plus exact-attempt provenance taken from the actual Codex Responses HTTP transport (chatgpt.com `/backend-api/codex`) and the live Responses terminal `model`. Config strings, env, constants, wrapper args, client labels, and HTTP 200 are not proof. Staff rejects any provider/model other than `openai-codex` / `gpt-5.6-sol`.

The Staff-reachable path is a separately created Container App `luna-sunset-staging-email-luna` in `luna-sunset-staging-env` with **internal TLS ingress** (`environmentId` in YAML; `--yaml` without `--environment`). Isolated `.hermes/auth.json` lives on the Azure Files mount at `/opt/data`. API bearer and response HMAC remain Key Vault / ACA secrets. Lunabox `127.0.0.1:8093` is a local probe only. WhatsApp Caddy is unchanged.

Activation is separate from WhatsApp and from auto-send:

- `EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED=true`
- `EMAIL_LUNA_HERMES_SOL_BASE_URL` (`https://` origin of the internal ACA `luna-sunset-staging-email-luna.internal.<env-hash>.northeurope.azurecontainerapps.io`, or loopback HTTP for tests)
- `EMAIL_LUNA_HERMES_SOL_TOKEN` (matches the draft service `API_SERVER_KEY`)
- `EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET` (Staff verifies HMAC over request id + authority + provider + model + runtime + plan hash)
- optional `EMAIL_LUNA_HERMES_SOL_TLS_PIN` (leaf SPKI; default identity is CA + hostname)
- existing Create Draft gates (`LUNA_DEPLOYMENT=sunset-staging`, `EMAIL_STAFF_LUNA_DRAFT_ENABLED=true`, `EMAIL_LUNA_DRAFT_RUNTIME_ENABLED=true`)
- tenant/location `sunset` / `sunset-somo`

Do **not** set `LUNA_AI_MODEL=gpt-5.6-sol` on Staff API. Sol is a Hermes openai-codex model id; the Chat Completions `luna-ai-provider` path cannot use it. If Hermes is unavailable, Create Draft with notes uses the reviewed FIX-3 deterministic closed-plan compile. Timeout, malformed output, extra keys, and provenance mismatch fail closed and do not overwrite the standing draft. Empty or whitespace notes still call Email Luna Hermes Sol against the authoritative thread and render a warm low-claim **thread-specific** guest reply; they must not use the canned review stub, and they must not give back the generic “Thanks for your message / A teammate can follow up” leftover when a standing draft already contains it. Thread topics are a server-owned allowlist of hostel/email intents (testing, front desk, mailbox, booking/reservation, surf, lesson/class, board/rental, room/bed, stay, loft, and ES equivalents); names, addresses, IDs, dates, phones, and other PII never become guest copy. If a signed Sol plan is rewritten locally (topic replacement, leftover-wrapper compile, or a Python-shaped HMAC-verified plan whose exact acts cannot keep guest-copy authenticity), Staff preserves authenticated Sol **plan** provenance separately from exact-body authenticity. The transformed body is accepted only through the same-process local compiler; Staff must not claim that modified body was HMAC-signed, and must not accept an arbitrary unsigned network body. If Hermes is unavailable for empty notes, FIX-3 compiles a low-claim plan from the thread (an allowlisted topic question, not that leftover wrapper).

Auto remains OFF. Approve & send is unchanged. Existing `hermes-sunset-luna` and Wolfhouse `hermes-luna` compose blocks are pinned.

Owner / proof: `npm run verify:mail-mvp-007`. Live Skipper steps: `docs/MAIL-MVP-007-SUNSET-EMAIL-SOL-RUNBOOK.md`.

## 001 Create Draft + context

Staff Inbox thread UI:

- Two-row context textarea in its own wider area **left** of **Create Draft**. It is a real editable notes field, not a chip, and is not squeezed into the button row.
- **Create Draft** sits **next to** existing **Approve & send**.
- Explicit staff click regenerates the standing draft from the authoritative thread plus private staff goals (the context field) plus Luna drafting goals. Context is untrusted private instruction for this draft, never guest copy. The model may interpret those goals into a strict closed enumerated drafting plan only — no guest-facing freeform prose. If the canonical `callLunaAiJsonChat` provider is unconfigured and returns null, the same author compiles that closed plan from the already-filtered private goals; it does not accept freeform model prose. A deterministic renderer owned by this route turns allowed acts into natural EN/ES copy (thank-you and “Would you like to make a booking?” / “¿Quieres hacer una reserva?”). It has no primitives for price, availability, payment, hold, booking confirmation/creation, URLs, or factual inventory claims. Do not paste staff notes, quote them, or wrap them with “We also wanted to add”. Empty or whitespace context still uses the same natural closed-plan author against the authoritative thread — no canned review stub when Email Luna succeeds, and no byte-identical generic teammate-followup leftover in place of a thread-specific reply. Unknown acts, extra keys, malformed output, and timeouts fail closed and do not overwrite the standing draft.
- Must not send, approve, or invoke outbound/provider transport.
- **Approve & send** stays behaviorally unchanged and remains the only send path in this slice.
- Existing generate-on-open may remain.
- Auto-send stays off.

Operator context is bounded plain guidance. Server-side validation length-limits and normalizes it. Context is never authority for prices, availability, payment URLs, or bookings. The closed plan schema is the hard-truth boundary: the model cannot return guest-facing claim prose because that field does not exist. Regex claim detection remains defense-in-depth on private staff goals, bounded topic labels, and renderer output. Asking whether the guest wants to make a booking remains allowed. Conversation/event/endpoint authority binding and stale-selection protections stay in force. Regeneration uses the existing draft producer and replaces/updates the standing draft in the established durable/UI flow without creating an approval or outbound journal.

## 008 booking-from-email

Sunset staging only. Staff Inbox **Create Draft** on an email thread that already names dates plus deposit/full may place a Staff API hold and include the exact Staff-API-created payment URL plus the truthful hold expiry.

- Hold requested dates for **exactly 24 hours** from authoritative Postgres `NOW()`.
- Deposit vs full is an enum only; amounts come from the Staff API quote (`deposit_required_cents` / `total_cents`). The model cannot supply amounts, URLs, or availability.
- Availability and price are revalidated in the existing Sunset create transaction. Mismatch fail-closes with no invented link.
- Identities stay bound: tenant, location, mailbox, conversation, inbound event, quote, hold, checkout session.
- Idempotent retries reuse the same hold and checkout; they do not mint duplicates.
- Booking commits only after the existing Stripe webhook / hold-promote owner verifies the provider event. Late payment after expiry does not revive the booking.
- Unpaid expiry uses the existing hold-expiry worker (lease/race-safe vs payment commit) and releases inventory exactly once. Active unpaid holds occupy Sunset course/rental capacity.
- Create Draft still does not send, approve, or change Graph / IMAP / SMTP. Auto remains OFF.

Owner / proof: `npm run verify:mail-mvp-008`.

## 005 generic IMAP inbound

Sunset staging only. A connected generic `imap_smtp` mailbox is polled over implicit TLS/993, mapped to the canonical inbound envelope, persisted in `tenant_email_inbound_events`, and projected through the existing MATCH / event-store / inbox-bridge path into Staff Inbox `conversations` / `messages`.

Done when inbound from that mailbox appears in the same Inbox projection as Microsoft Graph: thread list + open thread, guest-linkable (exact same-tenant `guests.email` bind, or unmatched with `conversations.email` set and `guest_id` null). Graph inbound on `support@lunafrontdesk.com` stays as-is. Do not rebuild Graph.

Connect / poll / fetch / attach are in scope. SMTP send is MAIL-MVP-006. Auto stays off. Owner / proof: `npm run verify:mail-mvp-005`.

## 006 generic SMTP send

Sunset staging only. Staff Inbox Create Draft + Approve & send for a verified generic `imap_smtp` mailbox uses SMTP (STARTTLS MAIL FROM / RCPT TO / DATA), not Graph. Graph send on `support@lunafrontdesk.com` stays as-is.

Every would-be send writes `tenant_email_reply_approvals` and `tenant_email_outbound_send_journal` with `provider = imap_smtp`. Missing SMTP host secret or transport fail-closes after those rows. Auto stays off (`LUNA_AUTO_SEND_ENABLED` / channel mode / `LUNA_EMAIL_SMTP_AUTO_SEND_ENABLED` default false). No live send in this pack. Owner / proof: `npm run verify:mail-mvp-006`.

## Hard boundaries (all slices unless a later reviewed job says otherwise)

- No production.
- No deploy from a MAIL-MVP-001 worker.
- No gateway/Hermes restart, `/sethome`, Salt, Deckhand, or Full Sail 4J.
- No auto-send enable, live provider sends, or live email actions. IMAP inbound attach in 005 and journaled SMTP send in 006 (fail-closed, no live send in the pack) are the exceptions.
- No booking confirmation until verified payment. 008 may create an unpaid 24-hour hold plus a Staff API payment link during Create Draft.
- Do not modify environment flags or live systems.
- Staff API only for prices/availability/bookings/payment URLs.
- Luna:On and `needs_human` are later-auto inputs only.
- Every future send remains journaled; do not alter Approve & send journaling.

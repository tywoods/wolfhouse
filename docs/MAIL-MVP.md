# MAIL MVP

Living plan for ordinary front-desk email. Durable product facts only. No process IDs, DSNs, tokens, mailbox secrets, or live send evidence.

Sunset staging is the only later deploy target. This document does not authorize production, gateway/Hermes restart, `/sethome`, Salt, Deckhand, Full Sail 4J, auto-send enablement, IMAP/SMTP changes, provider sends, live email actions, or booking creation.

Staff API remains the only authority for prices, availability, payment URLs, and bookings. Never invent those facts. Every future send remains journaled.

## Slices

| Slice | Name | This job? | Status |
| --- | --- | --- | --- |
| **001** | Create Draft + context | Yes | Source slice: explicit staff click regenerates the standing draft from the authoritative thread plus private staff goals. The model may return only a closed enumerated drafting plan; a deterministic Luna renderer writes the guest-facing EN/ES copy. No paste wrapper, no send, no approval, no outbound journal. |
| **002** | Ty live proof | No | Later. Controlled Sunset mailbox proof of 001 on staging. Not this PR. |
| **003** | auto create-and-send | No | Microsoft-only automatic create-and-send. Default remains OFF. Both `LUNA_AUTO_SEND_ENABLED=true` and `LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED=true` are required for provider auto-send. Reuses Create Draft author + staff Approve & send owners. Dormant. Do not rebuild in 004. |
| **004** | auto proof | Yes (this PR) | Bounded fail-closed Sunset-staging operator proof of 003. Default refuse. Typed one-shot authorization bound to sunset-staging / exact Staff app / current serving revision+image / fresh nonce+window. One existing guest-linked thread (`Testing 8 26`, sender `twoods@xantrion.com`). Live proof stays blocked until an exact-master Staff image containing this harness is serving. This builder does not execute live/cloud/provider work. |
| **005** | generic IMAP inbound | No | Later. Generic IMAP inbound connector. Not this PR. |
| **006** | generic SMTP send | No | Later. Generic SMTP send. Every future send remains journaled. Not this PR. |
| **007** | Email Luna Hermes managed by Skipper | Yes (this PR) | Dedicated Skipper-managed `hermes-sunset-email-luna` (`HERMES_ROLE=sunset-email-luna`) draft-only runtime. Durable config pins `openai-codex` / `gpt-5.6-sol`. Staff Create Draft on Sunset staging calls a colocated internal TLS ACA; provenance is the live Hermes composition attempt, not config text. Not an env flip of `LUNA_AI_MODEL`. Auto remains OFF. |
| **008** | booking-from-email | No — **LATER** | Product rule only. Do not implement booking in this document's current slice. |

## 003 Microsoft auto create-and-send

Sunset Microsoft inbound only. Default remains OFF. Live flags stay false.

When Email channel mode is Auto, the conversation is Luna On, `needs_human` is false, and both emergency flags are the literal string `true` (`LUNA_AUTO_SEND_ENABLED` and `LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED`), Luna authors the same empty-context Create Draft standing draft and sends it through the same approval + outbound journal + provider transport owners as staff Approve & send. Exactly one approval, journal, and provider send per inbound operation. Duplicate Microsoft delivery is idempotent.

Luna Off, `needs_human`, global pause, and pause-lookup failure all block before draft/send. Author/tool/provider failure fail closed and do not mark sent. Generic IMAP/SMTP, Graph direct-send shortcuts, campaigns, WhatsApp, and booking create are excluded. `CUSTOMER_OUTREACH_EMAIL_ENABLED` is not a send gate.

WhatsApp add-on: `.hermes/plans/2026-08-26-sunset-whatsapp-autonomy-wiring.md` is not present; no WhatsApp evaluator cleanup in this slice.

## 004 auto proof (Sunset staging operator harness)

Proof of 003 only. Reuses `scripts/lib/email-luna-microsoft-auto-create-send.js`. Default remains OFF.

The harness refuses unless the operator types `I_UNDERSTAND_SUNSET_STAGING_MAIL_MVP_004_ONE_SHOT_AUTO_CREATE_AND_SEND` bound to `sunset-staging`, `luna-sunset-staging-staff-api`, the current 100% Healthy serving revision+image, a fresh 64-hex nonce, and a 15-minute window. Traffic is the actual ACA ingress weight (exactly one explicit 100% revision equal to latestReady/latest); replica process env is attested via `printenv`/`/proc/1/environ`, never template env. Supervisor-owned issued-at and a durable one-use nonce bind the operation across process restart. It independently preflights zero/new selected-operation state for the existing guest-linked Microsoft thread subject `Testing 8 26` and authoritative inbound sender `twoods@xantrion.com` (not UI display `twoods`). Luna On and `needs_human` false are required. After the unchanged 003 `{status:'sent'}` return, leftover/Sol checks recompute evidence HMAC **inside the Staff replica** against durable approval `message_text` hash + selected source operation + tenant/location/conversation/request/provider/model/runtime. Host env HMAC and `evidence_mac` presence without recomputation are not proof. Default Graph arrival is a replica GET-only list through the reviewed Staff custody/token-loan owner (`$select` without body/bodyPreview). Kill-switch is replica-only before ON and after OFF. Conversation metadata HMAC booleans are not proof. Duplicate journal/provider outcomes succeed only at exact 1/1/1; partial is fail-closed.

A later authorized execution may temporarily set only `LUNA_AUTO_SEND_ENABLED=true`, `LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED=true`, and email channel mode `auto`, prove the enabled serving revision (same-image successor with 100% Healthy traffic and replica-process flags true; flag updates create a new revision), kill-switch the attested-false replica before ON and after OFF, invoke the canonical 003 owner once (inner dispatch marker only after handle starts), then **always** restore both flags `false` and automation `off` in supervisor `finally` and attest the restored successor the same way. Copied scripts in an old image are not proof: live dispatch requires a Staff image built from exact `origin/master` after this merge. Owner / proof: `npm run verify:mail-mvp-004`. Runbook: `docs/MAIL-MVP-004-SUNSET-AUTO-PROOF-RUNBOOK.md`.

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

## 008 booking-from-email — product rule only (LATER)

Do **not** implement booking from this plan or from slice 001.

When email booking is built later:

- Hold the guest-requested dates for **24 hours** so they can pay.
- The booking is placed when payment of the Staff API payment link succeeds (deposit or full).
- An unpaid hold expires.
- Staff API is the only authority.
- Never invent prices.

## Hard boundaries (all slices unless a later reviewed job says otherwise)

- No production.
- No deploy from a MAIL-MVP-001 worker.
- No gateway/Hermes restart, `/sethome`, Salt, Deckhand, or Full Sail 4J.
- No auto-send enable, IMAP/SMTP changes, provider sends, or live email actions.
- No booking creation.
- Do not modify environment flags or live systems.
- Staff API only for future prices/availability/bookings; none in slice 001.
- Luna:On and `needs_human` are later-auto inputs only.
- Every future send remains journaled; do not alter Approve & send journaling.

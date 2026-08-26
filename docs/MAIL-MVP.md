# MAIL MVP

Living plan for ordinary front-desk email. Durable product facts only. No process IDs, DSNs, tokens, mailbox secrets, or live send evidence.

Sunset staging is the only later deploy target. This document does not authorize production, gateway/Hermes restart, `/sethome`, Salt, Deckhand, Full Sail 4J, auto-send enablement, IMAP/SMTP changes, provider sends, live email actions, or booking creation.

Staff API remains the only authority for prices, availability, payment URLs, and bookings. Never invent those facts. Every future send remains journaled.

## Slices

| Slice | Name | This job? | Status |
| --- | --- | --- | --- |
| **001** | Create Draft + context | Yes | Source slice: explicit staff click regenerates the standing draft from the authoritative thread plus private staff goals. The model may return only a closed enumerated drafting plan; a deterministic Luna renderer writes the guest-facing EN/ES copy. No paste wrapper, no send, no approval, no outbound journal. |
| **002** | Ty live proof | No | Later. Controlled Sunset mailbox proof of 001 on staging. Not this PR. |
| **003** | auto create-and-send | No | Microsoft-only automatic create-and-send. Default remains OFF. Both `LUNA_AUTO_SEND_ENABLED=true` and `LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED=true` are required for provider auto-send. Reuses Create Draft author + staff Approve & send owners. Dormant. |
| **004** | auto proof | No | Later. Proof of automatic create-and-send. Auto-send stays off until an explicit later slice. |
| **005** | generic IMAP inbound | No | Later. Generic IMAP inbound connector. Not this PR. |
| **006** | generic SMTP send | No | Later. Generic SMTP send. Every future send remains journaled. Not this PR. |
| **007** | Email Luna Hermes managed by Skipper | Yes (this PR) | Dedicated Skipper-managed `hermes-sunset-email-luna` (`HERMES_ROLE=sunset-email-luna`) draft-only runtime. Durable config pins `openai-codex` / `gpt-5.6-sol`. Staff Create Draft and generate-on-open use it on Sunset staging when dedicated gates are set. Not an env flip of `LUNA_AI_MODEL`. Auto remains OFF. |
| **008** | booking-from-email | No — **LATER** | Product rule only. Do not implement booking in this document's current slice. |

## 003 Microsoft auto create-and-send

Sunset Microsoft inbound only. Default remains OFF. Live flags stay false.

When Email channel mode is Auto, the conversation is Luna On, `needs_human` is false, and both emergency flags are the literal string `true` (`LUNA_AUTO_SEND_ENABLED` and `LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED`), Luna authors the same empty-context Create Draft standing draft and sends it through the same approval + outbound journal + provider transport owners as staff Approve & send. Exactly one approval, journal, and provider send per inbound operation. Duplicate Microsoft delivery is idempotent.

Luna Off, `needs_human`, global pause, and pause-lookup failure all block before draft/send. Author/tool/provider failure fail closed and do not mark sent. Generic IMAP/SMTP, Graph direct-send shortcuts, campaigns, WhatsApp, and booking create are excluded. `CUSTOMER_OUTREACH_EMAIL_ENABLED` is not a send gate.

WhatsApp add-on: `.hermes/plans/2026-08-26-sunset-whatsapp-autonomy-wiring.md` is not present; no WhatsApp evaluator cleanup in this slice.

## 007 Email Luna Hermes Sol (Skipper-managed)

Sunset staging only. Dedicated internal draft service `hermes-sunset-email-luna` (`HERMES_ROLE=sunset-email-luna`) beside WhatsApp `hermes-sunset-luna`. Durable Hermes config pins `model.provider: openai-codex` and `model.default: gpt-5.6-sol`. Isolated `HERMES_HOME` at `/var/lib/hermes-sunset-email-luna`. No WhatsApp/Discord gateway, no Staff booking plugin, no outbound email authority.

Staff API remains the sole renderer and the sole authority for prices, availability, bookings, holds, confirmations, and payment links. Hermes receives a closed drafting envelope and returns a closed enumerated plan plus server-owned provenance. Staff rejects any provider/model other than `openai-codex` / `gpt-5.6-sol`.

Activation is separate from WhatsApp and from auto-send:

- `EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED=true`
- `EMAIL_LUNA_HERMES_SOL_BASE_URL` (origin only)
- `EMAIL_LUNA_HERMES_SOL_TOKEN` (matches the draft service `API_SERVER_KEY`)
- existing Create Draft gates (`LUNA_DEPLOYMENT=sunset-staging`, `EMAIL_STAFF_LUNA_DRAFT_ENABLED=true`, `EMAIL_LUNA_DRAFT_RUNTIME_ENABLED=true`)
- tenant/location `sunset` / `sunset-somo`

Do **not** set `LUNA_AI_MODEL=gpt-5.6-sol` on Staff API. Sol is a Hermes openai-codex model id; the Chat Completions `luna-ai-provider` path cannot use it. If Hermes is unavailable, Create Draft with notes uses the reviewed FIX-3 deterministic closed-plan compile. Timeout, malformed output, extra keys, and provenance mismatch fail closed and do not overwrite the standing draft. Empty notes stay the safe thread-only draft.

Auto remains OFF. Approve & send is unchanged. Existing `hermes-sunset-luna` and Wolfhouse `hermes-luna` compose blocks are pinned.

Owner / proof: `npm run verify:mail-mvp-007`. Live Skipper steps: `docs/MAIL-MVP-007-SUNSET-EMAIL-SOL-RUNBOOK.md`.

## 001 Create Draft + context

Staff Inbox thread UI:

- Two-row context textarea in its own wider area **left** of **Create Draft**. It is a real editable notes field, not a chip, and is not squeezed into the button row.
- **Create Draft** sits **next to** existing **Approve & send**.
- Explicit staff click regenerates the standing draft from the authoritative thread plus private staff goals (the context field) plus Luna drafting goals. Context is untrusted private instruction for this draft, never guest copy. The model may interpret those goals into a strict closed enumerated drafting plan only — no guest-facing freeform prose. If the canonical `callLunaAiJsonChat` provider is unconfigured and returns null, the same author compiles that closed plan from the already-filtered private goals; it does not accept freeform model prose. A deterministic renderer owned by this route turns allowed acts into natural EN/ES copy (thank-you and “Would you like to make a booking?” / “¿Quieres hacer una reserva?”). It has no primitives for price, availability, payment, hold, booking confirmation/creation, URLs, or factual inventory claims. Do not paste staff notes, quote them, or wrap them with “We also wanted to add”. Empty context keeps a safe thread-only Luna draft without the staff-goal model path. Unknown acts, extra keys, malformed output, and timeouts fail closed and do not overwrite the standing draft.
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

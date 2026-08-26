# MAIL MVP

Living plan for ordinary front-desk email. Durable product facts only. No process IDs, DSNs, tokens, mailbox secrets, or live send evidence.

Sunset staging is the only later deploy target. This document does not authorize production, gateway/Hermes restart, `/sethome`, Salt, Deckhand, Full Sail 4J, auto-send enablement, IMAP/SMTP changes, provider sends, live email actions, or booking creation.

Staff API remains the only authority for prices, availability, payment URLs, and bookings. Never invent those facts. Every future send remains journaled.

## Slices

| Slice | Name | This job? | Status |
| --- | --- | --- | --- |
| **001** | Create Draft + context | Yes | Source slice: explicit staff click regenerates the standing draft from the authoritative thread plus private staff goals. The model may return only a closed enumerated drafting plan; a deterministic Luna renderer writes the guest-facing EN/ES copy. No paste wrapper, no send, no approval, no outbound journal. |
| **002** | Ty live proof | No | Later. Controlled Sunset mailbox proof of 001 on staging. Not this PR. |
| **003** | auto create-and-send | No | Later. Automatic create-and-send remains off. Luna:On and `needs_human` are later-auto inputs only. |
| **004** | auto proof | No | Later. Proof of automatic create-and-send. Auto-send stays off until an explicit later slice. |
| **005** | generic IMAP inbound | No | Later. Generic IMAP inbound connector. Not this PR. |
| **006** | generic SMTP send | No | Later. Generic SMTP send. Every future send remains journaled. Not this PR. |
| **007** | Email Luna Hermes managed by Skipper | No | Later. Hermes email Luna managed by Skipper. Not this PR. |
| **008** | booking-from-email | No — **LATER** | Product rule only. Do not implement booking in this document's current slice. |

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

# Stage 27demo — Open WhatsApp Demo Closeout

**Status:** PASS — full chain 27demo-a through 27demo-i (2026-06-09).  
**Anchor booking:** `WH-G27-850FDAFDB9` · phone `+491726422307`  
**Staging image (final deploy):** `2d4dfde-stage27demo-i-confirmation-send`  
**Closeout commit:** idempotency normalization + this doc (see git log).

**Non-negotiables proven:** Staging only · Stripe **test** mode only · explicit gates for writes/live send · no production · no n8n Meta activation for demo slices.

---

## Chain summary

| Stage | Scope | Result | Notes |
|-------|--------|--------|-------|
| **27demo-a** | Open WhatsApp + Stripe TEST design | **PASS** | Design lock, no live send. Doc: [STAGE-27DEMO-A-OPEN-WHATSAPP-BOOKING-STRIPE-DEMO-DESIGN.md](STAGE-27DEMO-A-OPEN-WHATSAPP-BOOKING-STRIPE-DEMO-DESIGN.md) |
| **27demo-b** | Hosted inbound no-send | **PASS** | Open demo inbound dry-run, gates block writes/send |
| **27demo-c** | Hosted live reply | **PASS** | One controlled live WhatsApp reply window, gates restored |
| **27demo-d** | Booking hold + draft write | **PASS** | Demo hold/payment draft on staging |
| **27demo-d.1** | Calendar assignment | **PASS** | `DEMO-R1-B1` assignment, booking `WH-G27-8E83FAD8BB` |
| **27demo-d.2** | Room label fallback | **PASS** | `DEMO-R1-B1` → `DEMO-R1` when `room_code` null |
| **27demo-e** | Stripe TEST link + payment link WhatsApp | **PASS** | Image `b816f06-stage27demo-e-stripe-link`; link idempotency; optional live payment-link send to Ty |
| **27demo-f** | Payment truth | **PASS** | 27p fixture on `WH-G27-850FDAFDB9`; `deposit_paid`, no confirmation |
| **27demo-g** | Confirmation preview | **PASS** | 27q dry-run; room `DEMO-R2` from bed_code fallback (`2d4dfde`) |
| **27demo-h** | Confirmation go/no-go dry-run | **PASS** | `confirm_send:false` → `not_approved`; no mutation |
| **27demo-i** | Live confirmation send | **PASS** | One allowlisted send; `confirmation_sent_at` set; idempotency normalized at closeout |

---

## Final anchor booking state

| Field | Value |
|-------|--------|
| `booking_code` | `WH-G27-850FDAFDB9` |
| `payment_status` | `deposit_paid` |
| `amount_paid_cents` | 20000 |
| `balance_due_cents` | 49800 |
| `confirmation_sent_at` | `2026-06-09T21:36:03.370Z` |
| Confirmation sends | **1** audit row (idempotent replay blocks duplicates) |

Secondary link-only booking (earlier proof): `WH-G27-8E83FAD8BB` — checkout created, not used for live confirmation.

---

## Gates restored (post 27demo-i)

```
WHATSAPP_DRY_RUN=true
OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=false
OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=false
OPEN_DEMO_BOOKING_WRITES_ENABLED=false
LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST unset
```

---

## Idempotency closeout fix

Duplicate confirmation send with same idempotency key / already-sent booking previously returned `send_error` while correctly blocking a second WhatsApp. **27demo-closeout** normalizes to:

- `send_status: idempotent_replay`
- `confirmation_sent: true`
- `sends_whatsapp: false`
- `duplicate_send_blocked: true`
- `next_safe_step: confirmation_sent`

Verifier: `npm run verify:stage27demo-i-confirmation-send`

---

## Production launch caveats (not in scope for 27demo)

- **Stripe live mode** — demo used `sk_test_` only; production requires live keys, webhooks, and separate proof.
- **Open demo gates** — `OPEN_DEMO_*` env flags are staging harness; do not enable on production without explicit cutover plan.
- **WhatsApp live send** — requires `WHATSAPP_DRY_RUN=false`, allowlist, and owner GO; default remains dry-run.
- **Confirmation playbook** — check-in/out dates not in current 14b/27q Cami template; add only via explicit product decision.
- **Guest phone allowlist** — open demo intentionally has no inbound allowlist on staging number; production Luna may differ.
- **n8n pipe** — demo brain is Staff API + optional n8n inbound; production wiring is separate (27x.2+).

---

## Verifiers (local regression)

```bash
npm run verify:stage27demo-i-confirmation-send
npm run verify:stage27demo-g-confirmation-preview
npm run verify:stage27demo-e-stripe-test-link-whatsapp
npm run verify:stage27r-confirmation-send-go-no-go
```

---

## Recommended next step

Production-readiness slices outside open demo: **27x.2** n8n inbound pipe (disabled/dry-run), production Stripe/webhook cutover checklist, and owner-approved live Luna automation gates — not a repeat of 27demo on production.

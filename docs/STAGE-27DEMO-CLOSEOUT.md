# Stage 27demo — Open WhatsApp Demo Closeout

**Status:** **PASS** — full open-demo chain complete end-to-end on hosted staging (2026-06-10).  
**Primary anchor booking:** `WH-G27-0ECC1D9B57` · phone `+34600995557`  
**Staff API proof image:** `9b43cb5-stage27demo-j-n8n-review-pipe` · revision `wh-staging-staff-api--0000170`  
**Production:** **not live** — staging only; Stripe **test** mode only; gates restored after proof.

**Non-negotiables proven:** Staging only · explicit gates for writes/live send · no production/Main · n8n inactive after proof · owner-approved live confirmation send window only for o.3.

---

## n8n open-demo chain (primary closeout — PASS)

End-to-end path: **n8n inbound → Staff API brain → hold/draft → calendar → Stripe TEST link → payment truth → confirmation preview → go/no-go → one live confirmation send.**

| Stage | Scope | Result | Notes |
|-------|--------|--------|-------|
| **27demo-l** | n8n booking write + calendar | **PASS** | n8n → Staff API → Luna → hold + draft payment → `DEMO-R2-B1` / `DEMO-R2-B2` → calendar visible. Doc: [STAGE-27DEMO-L-N8N-BOOKING-WRITE-CALENDAR.md](STAGE-27DEMO-L-N8N-BOOKING-WRITE-CALENDAR.md) |
| **27demo-m** | n8n Stripe TEST link pipe | **PASS** | n8n created/reused Stripe TEST Checkout link (`checkout_created`). Doc: [STAGE-27DEMO-M-N8N-STRIPE-TEST-LINK.md](STAGE-27DEMO-M-N8N-STRIPE-TEST-LINK.md) |
| **27demo-n** | Stripe TEST payment truth | **PASS** | Signed `checkout.session.completed` POST to hosted `/staff/stripe/webhook`; payment `paid`, booking `deposit_paid`; no confirmation send |
| **27demo-o.1** | Confirmation preview dry-run | **PASS** | 27q/14b preview; room `DEMO-R2` from bed fallback; no send, no writes |
| **27demo-o.2** | Confirmation send go/no-go blocked | **PASS** | `confirm_send:false` → `not_approved`; `WHATSAPP_DRY_RUN:true`; no mutation |
| **27demo-o.3** | Live confirmation send | **PASS** | One allowlisted WhatsApp to `+34600995557`; idempotency blocked second send; gates restored |

---

## Primary anchor booking — final state

| Field | Value |
|-------|--------|
| `booking_code` | `WH-G27-0ECC1D9B57` |
| `guest_phone` | `+34600995557` |
| `booking.status` | `hold` |
| `payment_status` | `deposit_paid` |
| `amount_paid_cents` | 20000 (€200 deposit) |
| `balance_due_cents` | 39800 (€398) |
| `beds` | `DEMO-R2-B1`, `DEMO-R2-B2` |
| `room label` | `DEMO-R2` |
| `payment_draft_id` | `6fd60294-d230-48a1-889d-359cc439c017` |
| Stripe session (TEST) | `cs_test_a18HyMNIWRS3vRU9yuoNHn2mZjqKKPK4hBol4fkEerHHvr75sXcNiEE5bh` |
| `confirmation_sent_at` | `2026-06-10T06:41:44.477Z` |
| `guest_message_send_id` | `fdd92c15-9142-4852-b0d8-01bbbad7e785` |
| WhatsApp `wamid` | `wamid.HBgLMzQ2MDA5OTU1NTcVAgARGBIzODJEOTYwNzgzNzY4MkFGNzcA` |
| Confirmation sends | **1** row (idempotent replay blocks duplicates) |

**Confirmation message (excerpt):** Paid €200 · balance €398 · address Somo · gate `2684#` · room `DEMO-R2` · arrival payment options · no bed-code leak.

---

## Earlier open-demo chain (27demo-a → 27demo-i)

Prior staging proof on anchor `WH-G27-850FDAFDB9` (`+491726422307`) — image `2d4dfde-stage27demo-i-confirmation-send`. Still valid regression baseline; superseded as **primary** closeout anchor by the n8n chain above.

| Stage | Scope | Result |
|-------|--------|--------|
| 27demo-a | Design lock | PASS |
| 27demo-b | Hosted inbound no-send | PASS |
| 27demo-c | Hosted live reply | PASS |
| 27demo-d / d.1 / d.2 | Hold/draft + calendar | PASS |
| 27demo-e | Stripe TEST link + payment link WhatsApp | PASS |
| 27demo-f | Payment truth (27p fixture) | PASS |
| 27demo-g | Confirmation preview | PASS |
| 27demo-h | Go/no-go dry-run | PASS |
| 27demo-i | Live confirmation send | PASS |

---

## Gates restored (post 27demo-o.3)

```
WHATSAPP_DRY_RUN=true
LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST unset (null)
OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=false
OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=false
OPEN_DEMO_BOOKING_WRITES_ENABLED=false
n8n workflows inactive after proof
```

---

## Idempotency (confirmation send)

Duplicate confirmation send with same idempotency key / already-sent booking returns:

- `send_status: idempotent_replay`
- `confirmation_sent: true`
- `sends_whatsapp: false`
- `duplicate_send_blocked: true`
- `next_safe_step: confirmation_sent`

Proven on o.3 anchor. Verifier: `npm run verify:stage27demo-i-confirmation-send`

---

## Production launch caveats

- **Production is not live** — all 27demo proofs are staging-only; Main/production untouched.
- **Stripe live mode** — demo used `sk_test_` only; production requires live keys, webhooks, and separate proof.
- **Open demo gates** — `OPEN_DEMO_*` env flags are staging harness; do not enable on production without explicit cutover plan.
- **WhatsApp live send** — requires `WHATSAPP_DRY_RUN=false`, allowlist, and owner GO; default remains dry-run.
- **n8n** — demo pipes exported inactive; production wiring is separate.

---

## Verifiers (local regression)

```bash
npm run verify:stage27demo-l-n8n-booking-write
npm run verify:stage27demo-m-n8n-stripe-test-link
npm run verify:stage27demo-i-confirmation-send
npm run verify:stage27demo-g-confirmation-preview
npm run verify:stage27r-confirmation-send-go-no-go
npm run verify:stage27p-stripe-payment-truth
```

---

## Product priority after 27demo

**Do not chase UI polish** until the base booking-flow rehearsal is solid for real phones.

**Next core booking capability after base flow:** services / add-ons on the guest booking path — not random Staff Portal UI cleanup.

---

## Recommended next step

**Stage 28 — Wolfhouse real-phone staging rehearsal / launch candidate**

Ale/Cami pull out phones, message Luna on the staging number, and watch a booking appear in Staff Portal + bed calendar — same brain path as 27demo, with real-phone UX rehearsal and launch-candidate gates. Not a repeat of open-demo proof on production.

# Stage 27o — Stripe Test Checkout Link (No Live Send)

**Status:** PASS — local verifier (2026-06-08).  
**Parent:** [STAGE-27N-HOLD-PAYMENT-DRAFT-WRITE.md](STAGE-27N-HOLD-PAYMENT-DRAFT-WRITE.md) · [STAGE-27L-HOLD-PAYMENT-DRAFT-DESIGN.md](STAGE-27L-HOLD-PAYMENT-DRAFT-DESIGN.md)  
**Module:** `scripts/lib/luna-guest-stripe-test-link-create.js`  
**Verifier:** `npm run verify:stage27o-stripe-test-link`

**Non-negotiables:** Staging/local only · **no production** · Stripe **test** mode only · no WhatsApp · no Meta · no n8n · no booking confirmation · **no webhook/payment truth in 27o**.

---

## 1. Purpose

After Stage **27n** creates a draft `payments` row, this module creates a **Stripe test Checkout Session** and updates the payment with session metadata — for **staff/manual testing only**. The URL is returned in the API/module response; it is **not** sent to a guest.

---

## 2. Reused Stripe path

Logic mirrors **`handlePaymentCreateStripeLink`** (Stage **8.4.9**) in `scripts/staff-query-api.js`:

| Step | Pattern |
|------|---------|
| Load payment + booking | Same SQL join on `payments` / `bookings` / `clients` |
| Validate | `draft` (or idempotent `checkout_created` + URL) · EUR · `amount_due_cents > 0` |
| Stripe | `stripe.checkout.sessions.create({ mode: 'payment', ... })` |
| DB update | `status = checkout_created`, `stripe_checkout_session_id`, `checkout_url`, `expires_at`, metadata merge |
| Idempotency | If `checkout_created` + `checkout_url` exists → return existing session (no duplicate) |

Route anchor: `POST /staff/payments/:payment_id/create-stripe-link`

Guest module source tag: `luna_guest_stage27o`

---

## 3. API

```js
await runGuestStripeTestLinkCreateApproved(input, context)
```

### Input

| Field | Required | Notes |
|-------|----------|-------|
| `payment_draft_id` | ✓ | UUID of draft payment from 27n |
| `booking_id` | optional | Must match payment row if provided |
| `booking_code` | optional | Must match payment row if provided |
| `success_url` / `cancel_url` | optional | Override env redirect URLs |
| `staff_operator` | optional | Stored in payment metadata |
| `source` | optional | Defaults to `luna_guest_stage27o` |

### Context

| Field | Required | Notes |
|-------|----------|-------|
| `confirm_stripe_test_link` | ✓ must be `true` | Explicit approval gate |
| `env` | optional | Env bag (defaults `process.env`) |
| `pg` | optional | Injected pg client for tests |

---

## 4. Required env gates (all must pass)

| Gate | Value |
|------|--------|
| Environment | Non-production (staging/dev/localhost) |
| `confirm_stripe_test_link` | `true` in context |
| `STAFF_ACTIONS_ENABLED` | `"true"` |
| `STRIPE_LINKS_ENABLED` | `"true"` |
| `WHATSAPP_DRY_RUN` | `"true"` |
| `STRIPE_SECRET_KEY` | Present · must start with `sk_test_` |
| Redirect URLs | `STRIPE_CHECKOUT_SUCCESS_URL` + `STRIPE_CHECKOUT_CANCEL_URL` (or legacy `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL`) |

---

## 5. Payment / booking validation

- Payment exists and matches optional `booking_id` / `booking_code`
- Status `draft` or `pending` (or idempotent `checkout_created` with URL)
- `amount_due_cents > 0`, currency EUR
- Not already paid (`amount_paid_cents = 0`, status ≠ `paid`)
- Booking not `confirmed`
- Hold not expired when `hold_expires_at` is set

---

## 6. Output

```json
{
  "success": true,
  "stripe_link_attempted": true,
  "stripe_link_created": true,
  "stripe_mode": "test",
  "booking_id": "...",
  "booking_code": "WH-G27-...",
  "payment_draft_id": "...",
  "stripe_checkout_session_id": "cs_test_...",
  "stripe_checkout_url": "https://checkout.stripe.com/...",
  "payment_status": "checkout_created",
  "next_safe_step": "awaiting_payment_truth",
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "booking_confirmed": false,
  "payment_truth_recorded": false,
  "staff_notice": "For staff/manual testing only — not sent to guest."
}
```

Blocked path: `stripe_link_attempted: false`, `next_safe_step: "keep_dry_run"`.

---

## 7. Idempotency

If payment is already `checkout_created` with `checkout_url`, returns existing session (`idempotent: true`) — same convention as Stage 8.4.9. No second Stripe session is created.

---

## 8. Local / staging usage

Prerequisites:

- Stage **27n** draft payment exists (`payment_draft_id`)
- All env gates in §4 set on **staging/local** Staff API or script runtime
- `DATABASE_URL` to staging/local Postgres

Example:

```js
const out = await runGuestStripeTestLinkCreateApproved(
  {
    payment_draft_id: '<uuid-from-27n>',
    booking_code: 'WH-G27-...',
    staff_operator: 'staging-test',
  },
  {
    confirm_stripe_test_link: true,
    env: process.env,
  },
);
// out.stripe_checkout_url — open manually in browser for test payment
```

**The link is returned for staff/manual testing only.** Do not send via WhatsApp or guest automation.

---

## 9. What 27o does NOT do

- Send WhatsApp / Meta messages
- Call n8n
- Confirm booking
- Mark payment paid
- Run webhook handler or payment truth updates

---

## 10. Next stage

**Stage 27p** — webhook / payment truth confirmation path (`awaiting_payment_truth` → paid status + booking updates).

---

## 11. Verifier

```bash
npm run verify:stage27o-stripe-test-link
```

Static gate checks, reused-path references, mock pg idempotent reuse, source hygiene, staff-notice safety.

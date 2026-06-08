# Stage 27p — Stripe Payment Truth (No Live Send)

**Status:** PASS — local verifier (2026-06-08).  
**Parent:** [STAGE-27O-STRIPE-TEST-LINK.md](STAGE-27O-STRIPE-TEST-LINK.md) · [STAGE-27N-HOLD-PAYMENT-DRAFT-WRITE.md](STAGE-27N-HOLD-PAYMENT-DRAFT-WRITE.md)  
**Module:** `scripts/lib/luna-guest-stripe-payment-truth-apply.js`  
**Verifier:** `npm run verify:stage27p-stripe-payment-truth`

**Non-negotiables:** Staging/local only · Stripe **test** mode only · no WhatsApp · no Meta · no n8n · **no confirmation send** · no second payment record.

---

## 1. Purpose

After Stage **27o** creates a test Checkout session (`checkout_created`), this module applies **Stripe payment truth** — the same DB updates as the Staff Portal webhook — when a `checkout.session.completed` event (or equivalent test fixture) is processed. Payment moves to `paid`; booking amounts and `payment_status` (`deposit_paid` / `paid`) update per existing rules.

**No guest confirmation is sent.** A `confirmation_draft` may be persisted to `bookings.metadata` (same as Stage 8.4.11) for a future dry-run slice.

---

## 2. Reused webhook path

Logic mirrors **`handleStripeWebhook`** (Stage **8.4.11**) in `scripts/staff-query-api.js`:

| Step | Pattern |
|------|---------|
| Event | `checkout.session.completed` only |
| Lookup | Payment by `payment_id` metadata or `stripe_checkout_session_id` |
| Validate | EUR · amount match · session id match · eligible payment status |
| Idempotency | Already `paid` → return success, no double-count |
| Payment update | `status = paid`, `amount_paid_cents`, `paid_at`, Stripe metadata merge |
| Booking update | `amount_paid_cents`, `balance_due_cents`, `payment_status` enum |
| Draft | `confirmation_draft` in metadata when `deposit_paid` or `paid` (no send) |

Route anchor: `POST /staff/stripe/webhook`

Guest module source tag: `luna_guest_stage27p`

---

## 3. API

```js
await runGuestStripePaymentTruthApplyApproved(input, context)
```

### Input

| Field | Required | Notes |
|-------|----------|-------|
| `payment_draft_id` | ✓* | UUID of payment from 27n/27o |
| `stripe_event` | ✓* | Full Stripe event fixture (`checkout.session.completed`) |
| `stripe_session` | alt | Session object if event wrapper omitted |
| `booking_id` / `booking_code` | optional | Must match payment row if provided |
| `staff_operator` / `source` | optional | Stored in payment metadata |

\* One of `payment_draft_id` or session `id` required; provide `stripe_event` or `stripe_session`.

### Context

| Field | Required | Notes |
|-------|----------|-------|
| `confirm_payment_truth` | ✓ must be `true` | Explicit approval gate |
| `env` | optional | Env bag (defaults `process.env`) |
| `pg` | optional | Injected pg client for tests |

---

## 4. Required gates (all must pass)

| Gate | Value |
|------|--------|
| Environment | Non-production (staging/dev/localhost) |
| `confirm_payment_truth` | `true` in context |
| Stripe session/event | `livemode: false` (test mode) |
| Event type | `checkout.session.completed` (when event wrapper provided) |
| Payment | Exists · status `checkout_created` or `pending` · not already paid |
| Session match | `stripe_checkout_session_id` matches payment row |
| Amount | `session.amount_total === payment.amount_due_cents` |
| Currency | EUR on payment and session |
| Booking | Exists · hold not expired when `hold_expires_at` set |

---

## 5. Payment truth rules

- **Eligible payment statuses:** `checkout_created`, `pending` (maps to “pending_link” in design docs)
- **Not eligible:** `draft`, `paid`, `cancelled`, `addon_service` (uses separate webhook branch)
- **Booking `payment_status` after apply:**
  - `deposit_only` + balance remaining → `deposit_paid`
  - Full balance cleared → `paid`
  - Otherwise → `waiting_payment`
- **Booking `status` (hold/confirmed)** is **not** changed to `confirmed` here (same as 8.4.11)

---

## 6. Output

Success after truth applied:

```json
{
  "success": true,
  "payment_truth_attempted": true,
  "payment_truth_recorded": true,
  "payment_status": "paid",
  "booking_id": "...",
  "booking_code": "WH-G27-...",
  "booking_payment_status": "deposit_paid",
  "amount_paid_cents": 20000,
  "balance_due_cents": 80000,
  "stripe_checkout_session_id": "cs_test_...",
  "idempotent_replay": false,
  "next_safe_step": "ready_for_confirmation_dry_run",
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "confirmation_sent": false
}
```

Idempotent replay (already paid): `idempotent_replay: true`, same `next_safe_step`.

Blocked path: `payment_truth_recorded: false`, `next_safe_step: "awaiting_payment_truth"`.

---

## 7. Idempotency / replay

If payment is already `paid` (or `amount_paid_cents > 0`), returns success with `idempotent_replay: true`. **No second UPDATE** — no double-count. Same convention as Stage 8.4.11 webhook handler.

---

## 8. Local / staging test usage

Prerequisites:

1. Stage **27n** draft + Stage **27o** Checkout session (`checkout_created`)
2. Complete payment in Stripe test mode (or craft fixture with `STRIPE_WEBHOOK_SKIP_VERIFY=true`)
3. Non-production env + `confirm_payment_truth: true`

Example (fixture session after test Checkout completes):

```js
const out = await runGuestStripePaymentTruthApplyApproved(
  {
    payment_draft_id: '<uuid>',
    stripe_event: {
      id: 'evt_test_...',
      type: 'checkout.session.completed',
      livemode: false,
      data: { object: { /* Stripe session object */ } },
    },
  },
  { confirm_payment_truth: true, env: process.env },
);
```

Alternatively POST the same payload to `POST /staff/stripe/webhook` on staging with `STRIPE_WEBHOOK_SKIP_VERIFY=true`.

---

## 9. What 27p does NOT do

- Send WhatsApp / Meta messages
- Call n8n
- Send guest confirmation copy
- Confirm booking (`bookings.status = confirmed`)
- Create a new payment record
- Process live-mode Stripe events

---

## 10. Next slice

**Confirmation dry-run** — preview confirmation copy from `confirmation_draft` without live WhatsApp send.

---

## 11. Verifier

```bash
npm run verify:stage27p-stripe-payment-truth
```

Static gate checks, webhook path references, session/amount matching, mock pg apply + idempotent replay, source hygiene.

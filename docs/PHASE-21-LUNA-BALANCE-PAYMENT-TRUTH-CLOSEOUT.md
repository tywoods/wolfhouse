# Phase 21 — Luna remaining balance payment truth (closeout)

**Status:** PASS (staging webhook proof; production cutover not done)  
**Proof slice:** 21a — signed balance `checkout.session.completed` fixture  
**Staging baseline:** `wh-staging-staff-api--stage20j-backfill-safe` (`893700c-stage20j-backfill-safe`)  
**Date:** 2026-06-06  
**Client anchor:** `wolfhouse-somo`

## 1. Scope summary

Phase 21a proves that the **remaining balance** Stripe Checkout session created in Phase 20g updates payment truth correctly through `POST /staff/stripe/webhook`, closing the full money loop:

**deposit paid → confirmation sent → balance link exists → balance payment paid → booking fully paid (`balance_due_cents = 0`).**

Proof used a **signed Stripe webhook fixture** targeting the existing balance payment row (same approach as Phase 20d). No browser Checkout completion, no manual DB updates, no WhatsApp send, no confirmation resend.

## 2. Full before / after

### Balance payment (`cec96e1f-2d07-4b26-9cdd-0273d763bb96`)

| Field | Before | After |
|-------|--------|-------|
| `status` | `checkout_created` | **`paid`** |
| `amount_due_cents` | 17000 | 17000 |
| `amount_paid_cents` | 0 | **17000** |
| `paid_at` | null | `2026-06-06T13:05:50.957Z` |
| `stripe_checkout_session_id` | `cs_test_a15ktjXydVOC9XDlskWqSQKJ2AiJqvrevC2hz2PBMK2qKyAgmTHDRrt0g6` | unchanged |

### Booking (`828538c7-c6cb-4c6f-b45a-57a641af37cc`)

| Field | Before | After |
|-------|--------|-------|
| `booking_code` | `MB-WOLFHO-20260924-e90132` | unchanged |
| `payment_status` | `deposit_paid` | **`paid`** |
| `amount_paid_cents` | 10000 | **27000** |
| `balance_due_cents` | 17000 | **0** |
| `confirmation_sent_at` | `2026-06-06T13:01:07.422Z` | **unchanged** |

### Deposit payment (unchanged)

| Field | Value |
|-------|--------|
| `payment_id` | `7659e304-64d4-47cf-82b9-4be1e37ac913` |
| `status` | `paid` |
| `amount_paid_cents` | 10000 |

Payment row count remained **2**. Booking count remained **1**.

## 3. Proof anchors

| Anchor | Value |
|--------|--------|
| `booking_id` | `828538c7-c6cb-4c6f-b45a-57a641af37cc` |
| `booking_code` | `MB-WOLFHO-20260924-e90132` |
| Deposit `payment_id` | `7659e304-64d4-47cf-82b9-4be1e37ac913` |
| Balance `payment_id` | `cec96e1f-2d07-4b26-9cdd-0273d763bb96` |
| Stripe checkout session id | `cs_test_a15ktjXydVOC9XDlskWqSQKJ2AiJqvrevC2hz2PBMK2qKyAgmTHDRrt0g6` |
| Webhook fixture event id | `evt_phase21a_1780751146736` |
| `confirmation_sent_at` (unchanged) | `2026-06-06T13:01:07.422Z` |

### Step A — first signed webhook

- Route: `POST /staff/stripe/webhook`
- HTTP **200**, `success: true`
- `payment_id`: balance payment row
- `amount_paid_cents`: **17000**
- `booking_amount_paid_cents`: **27000**
- `booking_balance_due_cents`: **0**
- `payment_status`: **paid**
- `no_whatsapp: true`, `no_confirmation_sent: true`

### Step B — replay / idempotency

- Same signed fixture replayed
- HTTP **200**, `idempotent: true`
- No double-count: balance `amount_paid_cents` stayed **17000**, booking `amount_paid_cents` stayed **27000**, `balance_due_cents` stayed **0**

## 4. Safety

| Constraint | Phase 21a result |
|------------|------------------|
| **No WhatsApp send** | `guest_message_sends` sent count during proof: **0** |
| **No confirmation resend** | `confirmation_sent_at` unchanged; no send-confirmation route called |
| **No Stripe link creation** | Existing balance session reused; no new Checkout session |
| **No n8n** | Webhook handler only; no n8n activation or workflow changes |
| **No Meta webhook change** | Meta config unchanged |
| **No env changes** | Safe baseline unchanged (`WHATSAPP_DRY_RUN=true`, live-send gates unset, `STRIPE_LINKS_ENABLED=false`) |
| **No double-count** | Replay returned `idempotent: true`; amounts stable |
| **No duplicate bookings/payments** | 1 booking, 2 payments before and after |

## 5. Caveats

1. **Signed fixture, not browser Checkout completion** — Proves Staff API webhook payment-truth handler; does not prove a guest completing Stripe Checkout in the browser.
2. **Stripe test mode only** — Session id prefix `cs_test_`; staging Key Vault secrets; not production Stripe.
3. **Anchor booking now fully paid** — Reusing this booking for another balance-link proof requires a new booking or reset fixture.
4. **Webhook may refresh `confirmation_draft` metadata** — Handler builds fully-paid draft shape in booking metadata; `confirmation_sent_at` was not rewritten.

## 6. Recommended Phase 22

Incremental inbound Meta → gated booking write bridge (preview/write-ready first):

| Step | Target |
|------|--------|
| 1 | Inbound Meta message → Luna plan / write-ready preview only |
| 2 | Gated booking write (`BOT_BOOKING_ENABLED` + explicit confirm) |
| 3 | Deposit payment link creation |
| 4 | Payment link send (WhatsApp, gated) |
| 5 | Stripe webhook payment truth (deposit, then balance) |
| 6 | Confirmation send via dedicated route |

Also consider: Staff Portal handoff queue, check-in day send route, production cutover checklist.

## Verifier

```bash
npm run verify:luna-agent-phase21-closeout
```

Runs static doc checks plus:

- `verify:staff-stripe-webhook-api`
- `verify:luna-agent-phase20-closeout`
- `verify:luna-agent-phase20-send-confirmation-route`

## Related closeouts

- Phase 20: [PHASE-20-LUNA-BOOKING-PAYMENT-CONFIRMATION-CLOSEOUT.md](./PHASE-20-LUNA-BOOKING-PAYMENT-CONFIRMATION-CLOSEOUT.md)

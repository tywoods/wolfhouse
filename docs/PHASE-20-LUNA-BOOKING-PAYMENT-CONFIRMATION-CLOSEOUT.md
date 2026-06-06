# Phase 20 — Luna booking / payment / confirmation chain (closeout)

**Status:** PASS (staging chain proven; production cutover not done)  
**Closeout commit:** `893700c` — backfill + prior 20j send route  
**Date:** 2026-06-06  
**Client anchor:** `wolfhouse-somo`

## 1. Scope summary

Phase 20 proves the end-to-end Wolfhouse Luna path from a gated booking write through deposit payment, Stripe Checkout, webhook payment truth, balance link creation, Cami confirmation preview, one live WhatsApp confirmation send, and a dedicated confirmation send route that backfills `bookings.confirmation_sent_at` from an existing sent audit — all without n8n, without Meta webhook changes for this slice, and with live-send gates reverted after proof.

This closeout captures the **staging proof chain** only. Full inbound Meta → auto-write automation remains gated off.

## 2. Full proven chain

| Step | Phase | What was proven | Route / mechanism |
|------|-------|-----------------|-------------------|
| Luna plan → booking write | **20b** | Gated booking + deposit payment draft from plan; bed assignment | `POST /staff/bot/booking-create-from-plan` (hosted staging) |
| Deposit Stripe Checkout link | **20c** | Bot Stripe link from draft payment row | `POST /staff/bot/payments/{id}/create-stripe-link` |
| Stripe webhook payment truth | **20d** | `checkout.session.completed` marks deposit paid; booking `deposit_paid` | `POST /staff/stripe/webhook` |
| Cami confirmation preview | **20f** | Playbook templates; balance link read-only; no send | `POST /staff/bot/bookings/confirmation-preview` — commit `e4def6f` |
| Balance payment link | **20g** | Staff-generated balance Stripe link (existing checkout URL in preview) | `POST /staff/bookings/generate-payment-link` (staff session; gates toggled during proof only) |
| WhatsApp confirmation send | **20h** | One live Cami confirmation via generic send path + idempotency | `POST /staff/bot/guest-reply-send` — commit `92e0740` |
| Dedicated confirmation route | **20j** | Preview + send + idempotency path (initially without backfill) | `POST /staff/bot/bookings/send-confirmation` — commit `434f1f6` |
| `confirmation_sent_at` backfill | **20j-backfill** | Sets timestamp from existing sent audit replay; no resend | same route — commit `893700c` |

Supporting code slices (committed, not separate hosted proofs):

| Phase | Commit | Summary |
|-------|--------|---------|
| 20i | `92e0740` | `confirmation` added to `ALLOWED_SEND_KINDS` on guest-reply-send |

## 3. Proof anchors

### Booking

| Field | Value |
|-------|--------|
| `booking_id` | `828538c7-c6cb-4c6f-b45a-57a641af37cc` |
| `booking_code` | `MB-WOLFHO-20260924-e90132` |
| Guest | Phase 20b Booking Proof |
| `payment_status` | `deposit_paid` |
| Paid | €100 deposit |
| `balance_due_cents` | `17000` (€170) |
| `confirmation_sent_at` | `2026-06-06T13:01:07.422Z` (backfill time; see caveats) |
| Booking write idempotency | `phase20b-booking-proof-001` |

### Payments

| Role | `payment_id` | Status |
|------|--------------|--------|
| Deposit | `7659e304-64d4-47cf-82b9-4be1e37ac913` | `paid` |
| Balance | `cec96e1f-2d07-4b26-9cdd-0273d763bb96` | `checkout_created` |

### Confirmation send audit

| Field | Value |
|-------|--------|
| `guest_message_send_id` | `a3676eb7-09e7-41c3-b5ba-3fcdbc05c2e6` |
| `send_kind` | `confirmation` |
| `status` | `sent` |
| `provider_message_id` | `wamid.HBgMNDkxNzI2NDIyMzA3FQIAERgSNTU2QUMyQTczRUNBQkNFNUU5AA==` |
| `idempotency_key` | `luna-confirmation:wolfhouse-somo:828538c7-c6cb-4c6f-b45a-57a641af37cc:v1` |
| `sent_at` (original WhatsApp) | `2026-06-06T12:43:51.419Z` |
| To | `+491726422307` |

### Metadata after backfill

| Field | Value |
|-------|--------|
| `confirmation_send_id` | `a3676eb7-09e7-41c3-b5ba-3fcdbc05c2e6` |
| `confirmation_provider_message_id` | `wamid.HBgMNDkxNzI2NDIyMzA3FQIAERgSNTU2QUMyQTczRUNBQkNFNUU5AA==` |
| `confirmation_sent_via` | `whatsapp` |
| `confirmation_sent_source` | `idempotent_replay_backfill` |

### Staging revisions (where known)

| Slice | Proof revision | Restored / safe revision | Image tag |
|-------|----------------|--------------------------|-----------|
| 20b booking write | `wh-staging-staff-api--stage20b-booking-proof` | `wh-staging-staff-api--stage20b-booking-safe` | `d2f4dae-stage19g11a-ui-fix` |
| 20c deposit link | `wh-staging-staff-api--stage20c-stripe-proof` | `wh-staging-staff-api--stage20c-stripe-safe` | `d2f4dae-stage19g11a-ui-fix` |
| 20g balance link | `wh-staging-staff-api--stage20g-balance-link-proof` | `wh-staging-staff-api--stage20g-balance-link-safe` | `e4def6f-stage20f-cami-confirmation-preview` |
| 20h confirmation send | `wh-staging-staff-api--stage20h-confirmation-send` | `wh-staging-staff-api--stage20h-confirmation-safe` | `92e0740-stage20h-confirmation-send` |
| 20j send route | — | `wh-staging-staff-api--stage20j-send-confirmation-safe` | `434f1f6-stage20j-send-confirmation-safe` |
| 20j-backfill (current) | — | **`wh-staging-staff-api--stage20j-backfill-safe`** | **`893700c-stage20j-backfill-safe`** |

## 4. Safety

| Constraint | Phase 20 behavior |
|------------|-------------------|
| **No n8n** | Booking/payment/confirmation chain uses Staff API only; no n8n workflow activation in this slice |
| **No Meta webhook change** | Confirmation send used existing Meta WhatsApp provider; webhook config unchanged for Phase 20 closeout |
| **Live-send gates reverted** | After 20h live send, env restored to dry-run safe baseline; 20j-backfill ran with gates off |
| **Stripe webhook truth only** | Deposit `paid` state from `checkout.session.completed` webhook — not manual DB edit |
| **Idempotency replay proof** | v1 confirmation key: first send (20h) → sent audit; replay (20j / 20j-backfill) → duplicate, no second WhatsApp; backfill sets `confirmation_sent_at`; second call → `confirmation_sent_at_already_set` |
| **No booking/payment creation in confirmation path** | Send-confirmation route reads preview + audit only |

### 20h live-send env (proof revision only — reverted after)

`LUNA_AUTO_SEND_ENABLED=true`, `WHATSAPP_DRY_RUN=false`, `WHATSAPP_LIVE_SENDS_ENABLED=true`, `LUNA_GUEST_LIVE_SEND_OWNER_APPROVED=true`, WhatsApp credential secret refs.

### 20g balance link env (proof window only — reverted after)

`STAFF_ACTIONS_ENABLED` + `STRIPE_LINKS_ENABLED` toggled briefly for staff balance link generation; reverted after proof.

## 5. Current safe env baseline (staging)

Active revision: **`wh-staging-staff-api--stage20j-backfill-safe`** (`893700c-stage20j-backfill-safe`)

| Env | Value |
|-----|--------|
| `WHATSAPP_DRY_RUN` | `true` |
| `LUNA_AUTO_SEND_ENABLED` | unset |
| `WHATSAPP_LIVE_SENDS_ENABLED` | unset |
| `LUNA_GUEST_LIVE_SEND_OWNER_APPROVED` | unset |
| `STRIPE_LINKS_ENABLED` | `false` |
| `BOT_BOOKING_ENABLED` | unset |
| WhatsApp credential env refs | unset on active revision |

## 6. Known caveats

1. **`confirmation_sent_at` vs `guest_message_sends.sent_at`** — Backfill sets `confirmation_sent_at` to the backfill timestamp (`2026-06-06T13:01:07.422Z`), not the original WhatsApp send time (`2026-06-06T12:43:51.419Z`). Original send time remains on the audit row.
2. **Balance payment still `checkout_created`** — €170 balance not paid via webhook yet; Phase 21 should prove balance webhook truth.
3. **Full automation not enabled** — Inbound Meta → Luna plan → booking write bridge is not production-ready; `BOT_BOOKING_ENABLED` remains unset.
4. **Long balance checkout URL** — Stripe checkout URL embedded in Cami message; short-link UX may be a future improvement.
5. **Production cutover not done** — All proofs are staging-only; prod env gates, webhook, and anchor booking differ.
6. **20b–20d hosted proofs** — Staging proofs executed; temp proof scripts not committed to repo.

## 7. Recommended Phase 21 options

| Priority | Option | Rationale |
|----------|--------|-----------|
| 1 | **Balance payment webhook proof** | Complete payment chain: `checkout_created` → `paid` for balance row `cec96e1f-...` |
| 2 | **Inbound Meta → write bridge behind explicit gates** | Chain phone-origin intake to gated booking write (reuse 20b pattern) |
| 3 | **Staff Portal handoff / action queue** | Surface `requires_staff` and confirmation/payment actions for operators |
| 4 | **Production cutover checklist** | Env gates, Meta webhook, one controlled anchor booking, rollback plan |
| 5 | **Check-in day send route** | Mirror confirmation pattern: preview + gated send + `checkin_sent_at` + audit backfill |

## Verifier

```bash
npm run verify:luna-agent-phase20-closeout
```

Runs static doc checks plus a limited downstream set (send-confirmation route, confirmation preview, Stripe webhook API, generate-payment-link, booking-write-bridge).

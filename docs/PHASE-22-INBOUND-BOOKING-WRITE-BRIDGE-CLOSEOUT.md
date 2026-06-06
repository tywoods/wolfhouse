# Phase 22 — Inbound Meta → booking write bridge (closeout)

**Status:** PASS (staging chain proven; inbound auto-write still gated)  
**Closeout commits:** `bf05031` (22a preview) · `3c81670` (22d result persistence)  
**Date:** 2026-06-06  
**Client anchor:** `wolfhouse-somo`

## 1. Scope summary

Phase 22 proves that an inbound Meta WhatsApp booking message can become a **write-ready booking preview** on `guest_message_events`, then — only when explicitly gated and confirmed — flow through **`POST /staff/bot/booking-create-from-plan`** to create a real booking, bed assignments, and a **draft deposit payment**, with the outcome **persisted back** onto the original inbound event as `booking_write_result`.

This closes the chain:

**Meta inbound message → `booking_write_preview` → gated `booking-create-from-plan` → booking + `booking_beds` + draft deposit payment → `booking_write_result` on `guest_message_events`.**

The inbound path does **not** automatically create bookings without explicit gate + `confirm: true`. Availability protection and default-deny gates remain in force.

## 2. Proof chain

| Step | Phase | What was proven | Route / mechanism |
|------|-------|-----------------|-------------------|
| Inbound write preview (local) | **22a** | `booking_write_preview` built and persisted on inbound process; no write bridge invoked | `scripts/lib/luna-inbound-booking-write-preview.js` — commit `bf05031` |
| Inbound write preview (hosted) | **22b** | Sep case correctly blocked; Oct supplementary case eligible preview persisted | Meta webhook → inbound process (staging) |
| Gated booking write (hosted) | **22c** | Persisted Oct preview → real booking + beds + draft deposit payment | `POST /staff/bot/booking-create-from-plan` (`BOT_BOOKING_ENABLED=true` proof window only) |
| Result persistence (hosted) | **22d** | Idempotent replay backfills `booking_write_result` onto original inbound event | same route + `scripts/lib/luna-inbound-booking-write-result.js` — commit `3c81670` |

Supporting verifiers (committed, run in closeout):

| Verifier | Summary |
|----------|---------|
| `verify:luna-agent-phase22-inbound-booking-write-preview` | Preview path safety; no write/send/Stripe |
| `verify:luna-agent-phase13-booking-write-bridge` | Gated write bridge default-deny + idempotent replay |
| `verify:luna-agent-phase22-booking-write-result-persistence` | Result merge onto `guest_message_events.normalized` |
| `verify:staff-bot-booking-create-api` | Bot booking create path (shared SQL helper) |

## 3. Important blocked proof (availability protection)

**Sep 24–27 (`wamid.phase22b.complete.001`) — correctly ineligible**

The Sep anchor booking `MB-WOLFHO-20260924-e90132` (`828538c7-c6cb-4c6f-b45a-57a641af37cc`) occupies beds such that a Sep 24–27 request leaves only **one** bed available — insufficient for a 2-guest booking.

Hosted Phase 22b result:

- `booking_write_preview.eligible` = **false**
- `blocked_reasons` include not enough beds / availability
- `handoff_to_staff` semantics — **no write performed**

This is **not a failure**; it proves availability protection on the inbound preview path before any gated write.

## 4. Happy path proof (Oct 6–9)

**Oct 6–9 (`wamid.phase22b.complete.oct.001`) — eligible → write → result linked**

1. **22b hosted:** Inbound produced `booking_write_preview` with `eligible: true` and a safe `booking_create_payload_preview` (confirm false at preview stage).
2. **22c hosted:** `POST /staff/bot/booking-create-from-plan` with `confirm: true` and idempotency key created:
   - booking row
   - 2 `booking_beds` rows
   - draft deposit payment (€100 / 10000 cents)
   - **no Stripe link**, **no WhatsApp send**
3. **22d hosted:** Idempotent replay with `source_wa_message_id` persisted `booking_write_result` back onto the original `guest_message_events` row while preserving `booking_write_preview`.

## 5. Proof anchors

### Inbound event

| Field | Value |
|-------|--------|
| `wa_message_id` | `wamid.phase22b.complete.oct.001` |
| `client_slug` | `wolfhouse-somo` |
| Guest (preview) | Phase 22 Booking Preview / `491726422307` |
| Dates | 2026-10-06 → 2026-10-09 |
| Package | `malibu` |
| Guests | 2 |

### Booking

| Field | Value |
|-------|--------|
| `booking_id` | `946cc3ba-70e9-4f9f-a6b8-140ca3d22a79` |
| `booking_code` | `MB-WOLFHO-20261006-5dbf98` |
| `idempotency_key` | `luna-booking:wolfhouse-somo:wamid.phase22b.complete.oct.001:v1` |
| Beds | `DEMO-R1-B1`, `DEMO-R1-B2` |

### Payment

| Field | Value |
|-------|--------|
| `payment_id` | `d0bb5fa9-7ecc-43b2-b0d9-181b5687ae0a` |
| Status | `draft` (deposit) |
| Amount due | €100 (10000 cents) |
| Stripe | **no Stripe link** — `checkout_url` null, no `stripe_checkout_session_id` |

### Staging revisions (Phase 22d — current safe baseline after closeout proof)

| Slice | Proof revision | Restored / safe revision | Image tag |
|-------|----------------|--------------------------|-----------|
| 22d result persistence | `wh-staging-staff-api--stage22d-write-result-persist` | **`wh-staging-staff-api--stage22d-write-result-safe`** | **`3c81670-stage22d-write-result`** |

Prior 22c proof revision: `wh-staging-staff-api--stage22c-booking-write-safe` (image `bf05031-stage22b-booking-preview`).

## 6. Safety

| Constraint | Phase 22 behavior |
|------------|-------------------|
| **No Stripe link** | Deposit payment remains `draft`; no checkout URL on payment row |
| **No Stripe API** | No `checkout.sessions.create` or payment-link calls in inbound → write → result chain |
| **No WhatsApp send** | No `guest_message_sends` with `status=sent` during 22c/22d proofs |
| **No Meta webhook change** | Webhook URL and handler config unchanged for Phase 22 closeout |
| **No n8n** | No workflow activation; Staff API only; no n8n in this slice |
| **Env reverted** | After each hosted proof window, `BOT_BOOKING_ENABLED` unset; dry-run safe baseline restored |
| **Idempotency replay held** | Second `booking-create-from-plan` call returned `idempotent_replay: true`; booking count for idempotency key remained **1**; payment count **1**; `booking_beds` count **2** |

### Current safe env baseline (staging)

Active revision: **`wh-staging-staff-api--stage22d-write-result-safe`**

| Env | Value |
|-----|--------|
| `WHATSAPP_DRY_RUN` | `true` |
| `LUNA_AUTO_SEND_ENABLED` | unset |
| `STRIPE_LINKS_ENABLED` | `false` |
| `BOT_BOOKING_ENABLED` | unset |
| Live-send / Graph token env refs | unset |

## 7. Current caveats

1. **`booking_write_result.created_at` refreshes on replay** — Idempotent re-merge of `booking_write_result` updates `created_at` to the replay timestamp; booking/payment IDs and flags remain stable.
2. **`bookings.metadata.source` still says `staff_manual`** — Existing bot-create convention; inbound origin is traceable via idempotency key and `guest_message_events` linkage.
3. **Deposit payment is draft** — No Stripe link yet; deposit Checkout is a separate gated step (Phase 20c pattern).
4. **Inbound flow does not auto-write** — Preview is automatic on inbound process; actual booking write requires explicit `BOT_BOOKING_ENABLED`, `confirm: true`, and eligibility pass.
5. **22b Sep case PARTIAL but acceptable** — Primary Sep fixture blocked correctly; Oct supplementary case used for write proof.
6. **Temp hosted proof scripts not committed** — `.tmp-stage22b-hosted-proof.js`, `.tmp-stage22c-hosted-proof.js`, `.tmp-stage22d-hosted-proof.js` remain local only.

## 8. Recommended next

| Priority | Option | Rationale |
|----------|--------|-----------|
| 1 | **Phase 22f or Phase 23 — deposit Stripe link from inbound-created booking** | Reuse Phase 20c bot Stripe link on payment `d0bb5fa9-7ecc-43b2-b0d9-181b5687ae0a` when `STRIPE_LINKS_ENABLED=true` |
| 2 | **Staff handoff / action queue** | Surface blocked Sep cases and Oct “payment pending” for operators |
| 3 | **Deploy latest `master`** | Includes `a1641e7` staff manual-booking Stripe-skip fix; staging currently on `3c81670-stage22d-write-result` |
| 4 | **Preserve `created_at` on idempotent result re-merge** | Optional hardening for 22d replay cosmetic drift |
| 5 | **Production cutover checklist** | Meta webhook, env gates, one anchor booking, rollback plan |

## Verifier

```bash
npm run verify:luna-agent-phase22-closeout
```

Runs static doc checks plus a limited downstream set:

- `verify:luna-agent-phase22-booking-write-result-persistence`
- `verify:luna-agent-phase22-inbound-booking-write-preview`
- `verify:luna-agent-phase13-booking-write-bridge`
- `verify:staff-bot-booking-create-api`

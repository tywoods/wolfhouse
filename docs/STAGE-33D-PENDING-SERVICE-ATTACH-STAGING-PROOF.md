# Stage 33d — Pending Service Attach Staging DB Proof

**Status:** **FAIL** (2026-06-11)  
**Deployed commit:** `4628dc4` — `fix(stage33): allow pending services through hold write`  
**Image:** `whstagingacr.azurecr.io/wh-staff-api:4628dc4-stage33d-pending-service-attach-proof`  
**Revision (proof window):** `wh-staging-staff-api--0000216`  
**Revision (after restore):** `wh-staging-staff-api--0000216`  
**Test handset:** `+491726422307`

---

## Result summary

| Area | Result |
|------|--------|
| Deploy + healthz 200 | **PASS** |
| Pre-proof hygiene (Jul 10–17) | **PASS** — stale cancelled holds cleared |
| Test A — conversation facts (yoga pending) | **PASS** |
| Test A — hold + payment draft | **PASS** |
| Test A — Stripe TEST checkout session | **PASS** (DB `payments.checkout_url`) |
| Test A — WhatsApp Stripe URL send | **FAIL** — composer ack only (“team will send … shortly”) |
| Test A — `booking_service_records` yoga row | **FAIL** — zero rows |
| Test A — `attached_manual_services` | **FAIL** — null / empty |
| Test B — meals attach | **SKIPPED** (Test A DB attach failed) |
| Gates restored | **PASS** |
| Post-restore verifiers | **PASS** |

**Overall: FAIL** — hold write path works; pending yoga never reaches attach because open-demo write chain passes empty `extracted_fields`.

---

## Deploy and gates

| Field | Value |
|-------|-------|
| Image tag | `4628dc4-stage33d-pending-service-attach-proof` |
| healthz (proof + restore) | **200** |
| Stripe | `sk_test_*` |
| n8n `stage27demoLWrite01` | **inactive** |

### Gates before proof

| Gate | Value |
|------|-------|
| `WHATSAPP_DRY_RUN` | `true` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` |

### Gates during proof

| Gate | Value |
|------|-------|
| `WHATSAPP_DRY_RUN` | `false` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `true` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `true` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `true` |
| `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` | **removed** |

### Gates after restore

| Gate | Value |
|------|-------|
| `WHATSAPP_DRY_RUN` | `true` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `false` |
| healthz | **200** |

---

## Pre-proof hygiene

- Phone `+491726422307`, window Jul 10–17 2026
- Found prior proof bookings `WH-G27-4C1BA48A9A`, `WH-G27-077CB90CDE` (cancelled/expired) — skipped archive (already cancelled)
- Conversation context reset via `freshStart`

---

## Test A — Yoga pending attach

**Flow:** Malibu July 10 to July 17 for 1 → just the stay → Can I add yoga? → deposit

### Conversation facts (PASS)

| Check | Result |
|-------|--------|
| Malibu preserved | **PASS** |
| `yoga_status=requested` | **PASS** |
| `services_pending_manual=[yoga]` | **PASS** |
| `service_interest` does not contain yoga | **PASS** |
| No confirmation | **PASS** |

### Transcript (abbreviated)

1. **Malibu July 10 to July 17 for 1** — Malibu €299 + surf add-ons question (`package_quote_ready`)
2. **just the stay** — deposit/full prompt, Malibu preserved
3. **Can I add yoga?** — “Yes, I'll note yoga…”, `yoga_status=requested`, `services_pending_manual=[yoga]`
4. **deposit** — “Thanks! Your stay is held… team will send your secure payment link shortly”, `payment_choice_ack`

### Write / payment (PASS)

| Field | Value |
|-------|-------|
| `booking_code` | `WH-G27-4C1BA48A9A` |
| `booking_id` | `4568e749-d907-45b7-ada7-1cb98ed73c09` |
| `payment_draft_id` | `4fa3e85c-08a7-4a60-8665-39c982ab4fad` |
| Stripe session | `cs_test_a1lfnoKxh11Zb9A2lEd2fBk377Iem9X0c5sNBUe8FmyXvEqHJGWejS7xlD` |
| Checkout URL | present on `payments` row |

### DB attach (FAIL)

```sql
SELECT * FROM booking_service_records
 WHERE booking_id = '4568e749-d907-45b7-ada7-1cb98ed73c09';
-- → []
```

Deposit event `open_demo_result`:

```json
{
  "yoga_status": "requested",
  "services_pending_manual": ["yoga"],
  "extracted_fields": {},
  "payment_choice_ready": true
}
```

**Root cause:** `buildOpenDemoWriteChainFromReview()` passes `review.result.extracted_fields` to hold write. On the deposit turn, `extracted_fields` is `{}` while yoga state lives only on top-level observability (`yoga_status`, `services_pending_manual`). `attachPendingManualGuestServices()` reads `yoga_request` / `services_pending_manual` from `extractedFields` only → no services collected → no `booking_service_records` insert.

Hold planner fix from 33c **did** unblock hold write; attach wiring on live open-demo path still drops pending service fields.

### Stripe WhatsApp send

- **Stripe TEST link in DB:** yes (`checkout_created`)
- **WhatsApp message with checkout URL:** no (composer deferral copy only)
- Harness `isStripePaymentLinkSend`: correctly **false**

---

## Test B — Meals

**Skipped** — Test A DB attach not proven.

---

## Safety

| Check | Result |
|-------|--------|
| Production untouched | **PASS** |
| n8n inactive | **PASS** |
| Stripe sk_test only | **PASS** |
| No confirmation sent | **PASS** |
| No live Stripe | **PASS** |

---

## Post-restore verifiers

| Verifier | Result |
|----------|--------|
| `verify:stage33c-pending-service-attach-hold-write` | 25/25 PASS |
| `verify:stage33-package-addons-and-service-attach` | 43/43 PASS |
| `verify:stage32b-meals-yoga-reactive-services` | 30/30 PASS |
| `luna:guest-flow-batch --local --fixture-set booking-core` | 26/26 PASS |

---

## Recommended Stage 33d.1 patch (smallest)

1. **Merge pending service fields into open-demo hold write chain** — in `buildOpenDemoWriteChainFromReview()` or immediately before `runGuestHoldPaymentDraftWriteDryRunApproved()`, set `result.extracted_fields` from merged conversation context (include `yoga_request`, `meals_request`, `services_pending_manual`), OR
2. **Extend `collectPendingManualServices()`** to derive yoga/meals from top-level `result` observability when `extracted_fields` is sparse.

Then re-run Test A only on staging with hygiene clearing `WH-G27-4C1BA48A9A` idempotency window.

**Do not broaden scope** — no payment-truth, confirmation, or n8n changes.

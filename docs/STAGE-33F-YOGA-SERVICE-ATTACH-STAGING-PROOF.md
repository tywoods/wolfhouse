# Stage 33f — Yoga Pending Service Attach Staging DB Proof

**Status:** **PASS** (2026-06-11)  
**Deployed commit:** `57a9954` — `fix(stage33): map pending service attach to allowed DB values`  
**Image:** `whstagingacr.azurecr.io/wh-staff-api:57a9954-stage33f-yoga-service-attach-proof`  
**Revision (proof window):** `wh-staging-staff-api--0000219`  
**Revision (after restore):** `wh-staging-staff-api--0000220`  
**Test handset:** `+491726422307`

---

## Result summary

| Area | Result |
|------|--------|
| Deploy + healthz 200 | **PASS** |
| Pre-proof hygiene (Jul 10–17) | **PASS** — prior holds already cancelled; conversation reset |
| Test A — conversation facts (yoga pending) | **PASS** |
| Test A — hold + payment draft | **PASS** |
| Test A — Stripe TEST checkout session | **PASS** (DB + WhatsApp URL) |
| Test A — `attached_manual_services` includes yoga | **PASS** |
| Test A — `booking_service_records` yoga row | **PASS** |
| Gates restored | **PASS** |
| Post-restore verifiers | **PASS** |

**Overall: PASS** — pending yoga requested before deposit attaches to `booking_service_records` on staging with DB-allowed `source=luna_guest` and `metadata.pending_origin=luna_guest_pending`.

---

## Deploy and gates

| Field | Value |
|-------|-------|
| Image tag | `57a9954-stage33f-yoga-service-attach-proof` |
| healthz (proof + restore) | **200** |
| Stripe | `sk_test_*` |
| n8n `stage27demoLWrite01` | **inactive** |

### Gates before proof

| Gate | Value |
|------|-------|
| `WHATSAPP_DRY_RUN` | `true` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `false` |

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
- Prior proof bookings `WH-G27-4C1BA48A9A`, `WH-G27-077CB90CDE` already cancelled/expired
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

### Transcript

1. **Malibu July 10 to July 17 for 1** — Malibu €299 + surf add-ons question
2. **just the stay** — deposit/full prompt, Malibu preserved
3. **Can I add yoga?** — “Yes, I'll note yoga…”, `yoga_status=requested`, `services_pending_manual=[yoga]`
4. **deposit** — hold ack + real Stripe TEST checkout URL in WhatsApp reply

### Write / payment (PASS)

| Field | Value |
|-------|-------|
| `booking_code` | `WH-G27-4C1BA48A9A` |
| `booking_id` | `4568e749-d907-45b7-ada7-1cb98ed73c09` |
| `payment_draft_id` | `325b5b58-a562-42dd-9341-32625e674e08` |
| Stripe session | `cs_test_a1aiNfaJePEXpQqtZ5MSgqB6NEE2BMoCpdnmluAzxFZxXnOMIOQ9QM0zHs` |
| `attached_manual_services` | `["yoga"]` |

### DB attach (PASS)

```sql
SELECT *
FROM booking_service_records
WHERE booking_id = '4568e749-d907-45b7-ada7-1cb98ed73c09'
  AND source = 'luna_guest'
  AND metadata->>'pending_origin' = 'luna_guest_pending';
```

**Row:**

| Field | Value |
|-------|-------|
| `id` | `8311eff5-b304-487c-ab09-76c61e5e90f3` |
| `service_type` | `yoga` |
| `source` | `luna_guest` |
| `status` | `requested` |
| `service_date` | `null` |
| `metadata.pending_origin` | `luna_guest_pending` |
| `metadata.intent_status` | `requested` |
| `metadata.original_status` | `requested` |
| `metadata.needs_scheduling` | `true` |
| `metadata.pending_manual` | `true` |
| `metadata.service_pending_manual` | `true` |
| `metadata.attach_source` | `yoga_request` |
| `created_at` | `2026-06-11 07:00:05+00` (within proof window) |

### Idempotency

- Exactly **one** yoga row for proof booking
- No duplicate rows on repeated attach path

### Stripe proof

- **Stripe TEST session on payments row:** yes
- **WhatsApp message with real checkout URL:** yes (`isStripePaymentLinkSend` true)

---

## Safety

| Check | Result |
|-------|-------|
| Production untouched | **PASS** |
| n8n inactive | **PASS** |
| Stripe sk_test only | **PASS** |
| No confirmation sent | **PASS** |
| No live Stripe | **PASS** |

---

## Post-restore verifiers

| Verifier | Result |
|----------|--------|
| `verify:stage33e1-pending-service-db-constraint-mapping` | 29/29 PASS |
| `verify:stage33d1-open-demo-pending-service-attach-wiring` | 24/24 PASS |
| `verify:stage33c-pending-service-attach-hold-write` | 25/25 PASS |
| `verify:stage33-package-addons-and-service-attach` | 43/43 PASS |
| `verify:stage32b-meals-yoga-reactive-services` | 30/30 PASS |
| `luna:guest-flow-batch --local --fixture-set booking-core` | 26/26 PASS |

---

## Stage arc complete

Pending yoga/meals manual service attach is proven end-to-end on staging:

| Stage | Outcome |
|-------|---------|
| 33c | Hold write unblocked with pending services |
| 33d | Wiring gap identified (empty `extracted_fields` on deposit) |
| 33d.1 | Open-demo context merge into attach |
| 33e | DB constraint mismatch identified (`luna_guest_pending` source) |
| 33e.1 | Map to allowed DB values + metadata origin |
| **33f** | **Staging DB row proven** |

---

## Next stage recommendation

**Stop looping on services attach.** Return to:

- Messy conversation intelligence / stale quote / reset polish, or
- Demo-readiness hardening (payment-truth UX, confirmation deferral polish, operator visibility of pending manual services)

Optional later (not blocking): meals pending attach staging proof (Test B) when needed; staging DB migration to add `luna_guest_pending` as explicit source enum value (cosmetic — metadata origin already sufficient).

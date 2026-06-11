# Stage 33e — Yoga Pending Attach Staging DB Proof

**Status:** **FAIL** (2026-06-11)  
**Deployed commit:** `6e78c63` — `fix(stage33): pass pending services into open demo attach`  
**Image:** `whstagingacr.azurecr.io/wh-staff-api:6e78c63-stage33e-yoga-pending-attach-proof`  
**Revision (proof window):** `wh-staging-staff-api--0000217`  
**Revision (after restore):** `wh-staging-staff-api--0000218`  
**Test handset:** `+491726422307`

---

## Result summary

| Area | Result |
|------|--------|
| Deploy + healthz 200 | **PASS** |
| Pre-proof hygiene (Jul 10–17) | **PASS** — prior holds already cancelled; conversation reset |
| Test A — conversation facts (yoga pending) | **PASS** |
| Test A — hold + payment draft | **PASS** (reused idempotency booking) |
| Test A — Stripe TEST checkout session (DB) | **PASS** |
| Test A — WhatsApp Stripe URL send | **PARTIAL** — deferral ack; real URL on `payments` row only |
| Test A — `attached_manual_services` observability | **FAIL** — null |
| Test A — `booking_service_records` yoga row | **FAIL** — zero rows |
| Gates restored | **PASS** |
| Post-restore verifiers | **PASS** |

**Overall: FAIL** — Stage 33d.1 wiring reaches attach with correct pending yoga context, but **INSERT fails** on staging due to DB check constraint (`source=luna_guest_pending` not allowed).

---

## Deploy and gates

| Field | Value |
|-------|-------|
| Image tag | `6e78c63-stage33e-yoga-pending-attach-proof` |
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
- Found prior proof bookings `WH-G27-4C1BA48A9A`, `WH-G27-077CB90CDE` — both already **cancelled/expired**; no new archive needed
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

1. **Malibu July 10 to July 17 for 1** — Malibu €299 + surf add-ons question (`package_quote_ready`)
2. **just the stay** — deposit/full prompt, Malibu preserved
3. **Can I add yoga?** — “Yes, I'll note yoga…”, `yoga_status=requested`, `services_pending_manual=[yoga]`
4. **deposit** — “Thanks! Your stay is held… team will send your secure payment link shortly”, `payment_choice_ack`

### Write / payment (PASS)

| Field | Value |
|-------|-------|
| `booking_code` | `WH-G27-4C1BA48A9A` |
| `booking_id` | `4568e749-d907-45b7-ada7-1cb98ed73c09` |
| `payment_draft_id` | `b2d466d5-af44-4d82-8d61-a1bb1299ec09` |
| Stripe session | `cs_test_a1GW9OkJFuf7brnPEIFlZvBUt5lQOF9JrE5Jjgfhk3p0Od88QSSDT2CQau` |
| Checkout URL | present on `payments` row |
| Deposit `open_demo_result.write_status` | **`error`** (attach failure surfaced as write error) |

### DB attach (FAIL)

```sql
SELECT * FROM booking_service_records
 WHERE booking_id = '4568e749-d907-45b7-ada7-1cb98ed73c09';
-- → []
```

Deposit event observability (yoga context present):

```json
{
  "yoga_status": "requested",
  "services_pending_manual": ["yoga"],
  "services_requested": ["yoga"],
  "attached_manual_services": null,
  "write_status": "error"
}
```

### Root cause (proven via direct attach probe on staging DB)

Attach function **is called** with merged pending yoga context, but INSERT throws:

```
new row for relation "booking_service_records" violates check constraint "booking_service_records_source_check"
```

Staging constraint allows only:

```sql
source = ANY (ARRAY['staff_manual','luna_guest','import','stripe','demo_fixture_stage888'])
```

Stage 33 attach code uses `source = 'luna_guest_pending'` (`PENDING_ATTACH_SOURCE`).

Hold write commits booking + payment draft, then attach INSERT fails post-commit → write path returns `write_status=error`, no yoga row, `attached_manual_services` empty.

**Not** an open-demo wiring regression (33d.1 fix is live). **Schema mismatch** between runtime attach source marker and staging DB constraint.

### Stripe WhatsApp send

- **Stripe TEST link in DB:** yes (`checkout_created` on payments row)
- **WhatsApp message with checkout URL:** no (composer deferral copy only; harness `isStripePaymentLinkSend` correctly false for ack text)
- Harness counted Stripe proof via DB session id (not WhatsApp send)

---

## Idempotency / duplicates

- No yoga rows exist → duplicate attach not applicable
- Same idempotency booking `WH-G27-4C1BA48A9A` reused from prior proof window

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
| `verify:stage33d1-open-demo-pending-service-attach-wiring` | 24/24 PASS |
| `verify:stage33c-pending-service-attach-hold-write` | 25/25 PASS |
| `verify:stage33-package-addons-and-service-attach` | 43/43 PASS |
| `verify:stage32b-meals-yoga-reactive-services` | 30/30 PASS |
| `luna:guest-flow-batch --local --fixture-set booking-core` | 26/26 PASS |

---

## Recommended Stage 33e.1 patch (smallest)

1. **Staging DB migration** — extend `booking_service_records_source_check` to include `luna_guest_pending` (preferred; preserves attach idempotency key and query filters), **or**
2. **Runtime source constant** — use allowed `luna_guest` with `metadata.pending_manual=true` + `metadata.attach_source` (no migration, but must update idempotency SELECT and verifiers).

Optional follow-up: `booking_service_records_status_check` allows only `requested|confirmed|paid|cancelled` — deferred meals with `status=interested` would also fail; align status enum or map interested → requested on insert.

After migration, redeploy `6e78c63` (or patch commit) and rerun **Test A only** with hygiene clearing `WH-G27-4C1BA48A9A` idempotency window.

**Do not broaden scope** — no payment-truth, confirmation, n8n, or meals proof until yoga row inserts cleanly.

---

## Next stage after 33e.1 PASS

Return to messy conversation intelligence / stale quote / reset polish, or demo-readiness — services attach loop complete once yoga row proven on staging.

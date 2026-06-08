# Phase 26j.2 — Manual Booking Services Hotfix

**Status:** PASS — local verifiers (2026-06-08).  
**Verifier:** `npm run verify:luna-agent-phase26-manual-booking-services-hotfix`

## Root cause

1. **UI `buildAddOns()`** skipped individual board/wetsuit rentals when a combo was selected (`wsActive` / `wbActive` gates).
2. **`buildManualBookingServiceRecordRows()`** used `MANUAL_BOOKING_COMBO_REPLACES` to drop individual rental codes from service rows.
3. **`calculateWolfhouseQuote()`** skipped add-ons listed in combo `replaces` config — quote and records diverged from form selections.
4. **Meals** were explicitly excluded from service record creation (`/meal/i.test` skip).
5. **New booking services** used `service_date = check_in` instead of `null` (unscheduled default).

## Fixes

| Area | Change |
|------|--------|
| Create New Booking title | `Create New Booking` — no “Preview”, no preview-only banner |
| Labels | `Soft board rental`; combo `Wetsuit + Soft board combo`; pricing name `Soft board rental` |
| Form payload | Combos + individual rentals sent independently when qty > 0 |
| Quote engine | Removed combo `replaces` dedupe — each selected line bills |
| Service records | New lib `manual-booking-service-records.js`; meals → `meal`; `service_date: null`; board_variant metadata |
| Pricing config | Removed `replaces` arrays; meal name singular `Meal` |

## Safety

No Stripe · no payment link generation from service create · no WhatsApp/Meta/n8n · no guest AI intake · no schema changes.

## Hosted proof (after deploy)

1. Create New Booking — confirm title/banner cleanup and Add Services labels.
2. Select all combo + individual board services + meal; calculate quote; create booking.
3. Services tab: every selection in Paid/Requested, Unscheduled, correct totals.
4. Payments tab: invoice + balance due include services; no extra payment rows from services alone.

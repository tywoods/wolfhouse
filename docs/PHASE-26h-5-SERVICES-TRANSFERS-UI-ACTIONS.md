# Phase 26h.5 — Nullable service dates, drawer polish, transfer override

## Summary

Stage 26h.5 unblocks service unschedule on staging and adds targeted drawer/calendar/transfer UI polish before the next hosted proof.

## Nullable service_date migration

Migration `018_booking_service_records_nullable_service_date.sql`:

```sql
ALTER TABLE booking_service_records
  ALTER COLUMN service_date DROP NOT NULL;
```

- `service_date = NULL` means a paid/requested service exists but is not scheduled to a stay date yet.
- No row updates/deletes; no payment or price/status changes.

## Overview ordering

Overview tab order:

1. Booking Details (no Room / Bed duplicate)
2. Move Bed
3. Payment Summary
4. Conversation / Handoff
5. Footer actions

## Booking Calendar legend

- Legend moved to the right on the same row as date shortcut chips.
- “Legend” title removed.
- Compact inline width; wraps under controls on narrow screens.

## Transfer Exception Override

- Each arrival/departure card has **Exception Override** under Transfer date/time.
- When open, staff enter **Transfer charge** in euros (e.g. `25`).
- Save persists to existing `booking_transfers` fields:
  - `price_cents` (integer cents, EUR)
  - `included_in_package = false`
  - `pricing_note = Manual transfer override`
- When override is off/empty, normal `priceBookingTransfer` pricing applies.
- Invalid amount (< 0 or non-numeric) returns safe UI/API error.
- **No payment records** are created from override.

## Transfer header pebble

- Drawer header purple pebble uses **Transfer Required** (single direction) or **Transfer: Arrival + Departure** (both).
- Saving or removing a transfer updates the header pebble immediately without full page refresh.

## Staging env — STAFF_ACTIONS_ENABLED

Staging should set `STAFF_ACTIONS_ENABLED=true` after deploy so **Generate Payment Link** can be tested. This does not change Stripe code. Keep `WHATSAPP_DRY_RUN=true` and no WhatsApp live-send env.

## Safety

- No payment writes from transfer override.
- No Stripe code changes in this stage.
- No WhatsApp, Meta webhook, n8n, or guest AI intake changes.

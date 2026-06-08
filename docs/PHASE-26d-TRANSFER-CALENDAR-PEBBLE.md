# Phase 26d — Booking Calendar Transfer Pebble

## Goal

Show a light-purple **Transfer** pebble on Booking Calendar booking blocks when a booking has an active airport transfer (arrival and/or departure), and surface transfer details in the booking drawer.

## Transfer range loading

`GET /staff/bed-calendar` loads booking blocks for the requested client and date range. In the same handler, one additional query loads transfer rows via `listBookingTransfersForCalendarRange` (same `client_slug`, `start_date`, `end_date`).

Results are grouped by `booking_id` with `buildTransferSummariesByBookingId` and attached to each calendar block as `transfer_summary`:

```json
{
  "has_transfer": true,
  "transfer_count": 2,
  "directions": ["arrival", "departure"],
  "statuses": ["requested", "confirmed"],
  "airports": ["SDR", "BIO"]
}
```

No per-booking transfer fetch on calendar load (no N+1).

## Active statuses

The calendar pebble appears only when `has_transfer` is true — i.e. at least one transfer row with status:

- `requested`
- `confirmed`

Not shown for:

- `cancelled`
- `not_needed`

`listBookingTransfersForCalendarRange` already filters to requested/confirmed at the SQL layer.

## Light-purple Transfer pebble

Booking blocks with `transfer_summary.has_transfer` render a compact `.transfer-pebble` badge with text **Transfer** inside the block (alongside guest label and payment badges). Styling: light purple background (`#EDE7F6`), purple text (`#5E35B1`).

## Drawer summary

When a booking block is opened:

- Header meta shows a compact label when transfers are active, e.g. `Transfer: Arrival SDR requested` or `Transfer: Arrival + Departure`.
- **Flight / Transfer Details** (Phase 26c) loads arrival/departure rows via the existing per-booking GET transfer route and remains editable under Package.

## Out of scope / safety

- No payment writes
- No Stripe
- No WhatsApp / Meta webhook changes
- No n8n workflow changes
- No guest AI intake
- No migrations or env changes
- Aviationstack flight lookup deferred to Phase 26e

## Hosted proof

1. Deploy staff API to staging.
2. Open Booking Calendar for `wolfhouse-somo`, range `2029-10-01`–`2029-10-04`.
3. Confirm test booking `MB-WOLFHO-20291001-9dcb42` shows the Transfer pebble.
4. Click booking — Flight / Transfer Details populated; header shows transfer summary.
5. Set one transfer to `cancelled` or `not_needed` — pebble hides when no active transfers remain (after calendar reload).
6. Confirm `/healthz` returns 200.

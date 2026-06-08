# Phase 26h.1 — Drawer Transfers/Payments polish + remove transfer

## Summary

Stage 26h.1 polishes the booking drawer **Transfers** and **Payments** tabs before staging deploy: lighter Overview-style cards, a **Remove transfer** action per direction, responsive Payments layout, and a bottom spacer to prevent tab-switch collapse.

## Transfers tab

### Card styling

- Arrival and Departure cards use `bc-drawer-overview-card` soft cream styling (`var(--surface)`), matching Overview.
- Compact two-column grid layout unchanged.
- Existing fields retained: airport, flight number, transfer date/time, notes, Lookup flight, Save transfer.
- Beige/cream bottom spacer (`bc-transfer-tab-spacer`, ~280px) unchanged.

### Remove transfer

```
DELETE /staff/bookings/:booking_id/transfers/:direction?client_slug=wolfhouse-somo
```

- `:direction` is `arrival` or `departure`.
- Operator+ auth.
- Validates `client_slug`, booking ownership, and direction.
- Deletes the `booking_transfers` row for that booking + direction only.
- Returns `{ success: true, deleted: true|false, no_payment_write: true }`.
- Does not touch payments, services, or the other direction.

### UI behavior

- **Remove arrival transfer** / **Remove departure transfer** button bottom-right when a saved transfer exists.
- Confirm: “Remove this transfer from the booking?”
- On success: clears that direction’s form (airport → default Santander/SDR, flight/date/notes cleared), refreshes Transfer pebble summary (requested/confirmed only).
- Removed transfers no longer count for the calendar Transfer pebble.

## Payments tab

### Layout

- Two-column responsive grid on wide drawer:
  - **Left:** Accommodation, Services (renamed from Add-ons), Totals, Generate Payment Link, Record cash payment.
  - **Right:** Payment History card with receipt cards stacked vertically.
- Stacks to a single column below ~860px width.

### Styling

- Invoice and Payment History cards use Overview-style soft cream cards.
- Visible breakdown label **Services** replaces **Add-ons** (API product strings elsewhere unchanged).

### Bottom spacer

- `bc-payments-tab-spacer` (~280px, transparent) below payment content inside the unified tab panel background — prevents tab content collapse/jump when switching tabs.

## Safety

- No DB schema changes.
- No new payment writes; existing payment routes unchanged.
- No Stripe, WhatsApp, Meta, n8n, or guest AI intake changes.
- Full service editor deferred.

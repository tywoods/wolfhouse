# Phase 26h — Services tab polish + schedule paid services to dates

## Summary

Stage 26h improves the booking drawer **Services** tab styling to match Overview soft cards and adds a minimal **service_date** scheduling write so staff can assign unscheduled paid/requested services to a stay night.

## Services tab styling

- Uses the same `bc-drawer-overview-card` cream/beige card treatment as Overview.
- Top summary shows a single headline line, e.g. `Malibu · 7 nights` or `No Package · 3 nights` — no repeated “Package” labels.
- **Paid / requested services** list appears directly under the headline (all `booking_service_records` for the booking).
- **Service schedule** section follows, with one row per stay night (check-in through day before checkout).
- Each date row includes a small `+` button to schedule an unscheduled service onto that date.
- **Unscheduled services** section lists records with no date or an out-of-stay date.
- Existing **Add or remove** controls remain at the bottom (manage services, not “Add-ons”).

## PATCH route — service_date only

```
PATCH /staff/bookings/:booking_id/services/:service_record_id/date
```

Body:

```json
{
  "client_slug": "wolfhouse-somo",
  "service_date": "2026-06-09"
}
```

### Auth

- Operator role or higher (`requireAuth(..., 'operator')`).

### Validation

- `client_slug` required.
- Booking must exist for the client context.
- Service record must belong to the booking and client.
- `service_date` must be `YYYY-MM-DD` and fall within stay nights (check-in through checkout − 1).
- Invalid date → `400` with a safe error message.

### Write scope

- Updates **only** `booking_service_records.service_date` (and `updated_at`).
- Returns refreshed schedule payload (same shape as GET services).
- **No payment writes**, no price recalculation, no Stripe, no WhatsApp/Meta/n8n.

## UI scheduling flow

1. Staff opens booking drawer → **Services** tab.
2. Clicks `+` on a date row.
3. Inline picker lists unscheduled paid/requested services (name, quantity, price, status).
4. Selecting an option sends PATCH; on success the Services tab body refreshes from the response (no full drawer/page reload).
5. If no unscheduled services: “No unscheduled services to schedule.”

## Deferred

- Full service editor (quantity, price, payment status, notes).
- Drag-and-drop scheduling.
- Payment or Stripe integration from this flow.

## Safety

- Staging feature; no DB schema changes.
- No guest AI intake changes.
- Existing GET `/staff/bookings/:booking_id/services` remains read-only aside from the new PATCH sub-route.

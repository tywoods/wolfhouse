# Phase 26h.3 — Service unschedule + drawer cleanup

## Summary

Stage 26h.3 adds the companion **unschedule** action (− button) on Services date rows and polishes drawer layout copy/placement before the next staging deploy.

## Services unschedule

### API

Extends existing route:

```
PATCH /staff/bookings/:booking_id/services/:service_record_id/date
```

Schedule:

```json
{ "client_slug": "wolfhouse-somo", "service_date": "2026-06-09" }
```

Unschedule:

```json
{ "client_slug": "wolfhouse-somo", "service_date": null }
```

- Operator+ auth; validates `client_slug`, booking ownership, record ownership.
- Non-null dates must fall within stay nights (400 if invalid).
- `null` clears `booking_service_records.service_date` only (+ `updated_at`).
- No delete, no payment writes, no price recalculation.

### UI

- Each date row has **+** and **−** buttons side by side.
- **+** schedules an unscheduled service onto that date (26h).
- **−** opens a picker of services on that date; selecting one PATCHes `service_date: null`.
- Services tab body refreshes only (summary + schedule sections); no full drawer reload.

## Services tab layout

1. Headline (`Malibu · 7 nights`)
2. Paid / requested services
3. **Add** / **Remove** buttons (no “Add or remove” title)
4. Service schedule
5. Unscheduled services

## Transfers cleanup

- After successful transfer delete, no “Transfer removed” success message.
- Form clears silently; errors on save/lookup remain.

## Payments cleanup

- Button order: **Record Cash Payment** then **Generate Payment Link**.
- Label updated to “Record Cash Payment”.
- No payment route or Stripe behavior changes.

## Overview cleanup

- Room / bed assignment removed from Booking Details (shown in Move Bed card).
- Payment Summary moved below Conversation / Handoff, above footer actions.

## Safety

- No DB schema changes.
- No payment writes beyond existing actions.
- No Stripe, WhatsApp, Meta, n8n, or guest AI intake.

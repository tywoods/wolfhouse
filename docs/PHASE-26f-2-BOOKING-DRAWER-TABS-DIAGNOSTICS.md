# Phase 26f.2 — Booking Drawer Tabs + Lookup Diagnostics

**Status:** IMPLEMENTED

## Drawer tabs

Staff booking drawer uses in-place tabs (no full page reload):

| Tab | Contents |
|-----|----------|
| **Overview** (default) | Contact, dates, guests, package, room/bed, brief payment summary, Move bed, Conversation/Handoff, cancel footer |
| **Services** | Package services / schedule / unscheduled placeholders + existing add/remove service controls (label **Services**) |
| **Transfers** | Compact Flight / Transfer Details editor (26f.1) |
| **Payments** | Full running invoice, payment history, generate link, record cash |

Overview keeps a **Payment summary** block (invoice total, paid, balance due, status). Full ledger stays on Payments tab.

## Lookup diagnostics

`POST /staff/bookings/:booking_id/transfers/lookup-flight` returns safe categories:

- `aviationstack_not_configured`
- `aviationstack_auth_error`
- `aviationstack_quota_or_plan_error`
- `aviationstack_rate_limited`
- `aviationstack_bad_request`
- `flight_not_found`
- `airport_mismatch`
- `aviationstack_api_error`

Failure payload includes:

- `message` — staff-safe text
- `diagnostic` — `{ provider, http_status, lookup_dates_tried, flight_number, direction, airport_code, provider_error_code, provider_error_type }`
- `no_transfer_write: true`, `no_payment_write: true`

Lookup tries booking check-in/check-out date, then one day earlier on `flight_not_found`.

Server logs `[flight-lookup]` JSON with category, http status, flight number, dates tried — **no API key, no raw payload**.

## Safety

- No migrations, Stripe writes, WhatsApp, Meta, n8n, or guest AI intake.
- No raw Aviationstack payload or API key in responses or logs.

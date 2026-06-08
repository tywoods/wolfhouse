# Phase 26g — Services Tab Schedule (read-only MVP)

**Status:** IMPLEMENTED

## Goal

Populate the Staff booking drawer **Services** tab from existing `booking_service_records`, grouped by stay date, with a separate unscheduled section. Read-only display only — no service editing or scheduling in this slice.

## API

`GET /staff/bookings/:booking_id/services?client_slug=...`

Returns:

- `package_summary` — package code/name, nights, included note
- `stay_dates` — half-open nights from check-in through check-out−1
- `services_by_date` — one row per stay date with scheduled services (or empty)
- `unscheduled_services` — records without a valid in-stay date
- `totals` — scheduled/unscheduled counts

Service rows expose safe business fields only (type, name, date, quantity, prices, status, notes). No raw JSON blobs.

## UI — Services tab

1. **Package** card — package name/code, nights, brief note
2. **Service schedule** — date-by-date list with service chips
3. **Unscheduled services** — paid/requested services without a date
4. Existing **add/remove service** controls remain below (label **Services**, not Add-ons)

Empty states:

- No records: “No services recorded yet.”
- No unscheduled: “No unscheduled services.”
- Empty day: “No services scheduled”

## Date grouping

- `stay_dates` built from booking `check_in` → `check_out` using `normalizeBookingDateOnly`
- Checkout day excluded from stay nights unless services exist on checkout date
- Invalid or out-of-stay `service_date` values appear under unscheduled

## Deferred

- Service editing, scheduling, drag-and-drop, or write APIs in this tab
- Payment writes, Stripe, WhatsApp, Meta, n8n, guest AI intake
- DB schema changes

## Safety

- `no_payment_write: true` on route response
- GET-only services route; operator auth required
- No Stripe, WhatsApp, Meta, or n8n changes

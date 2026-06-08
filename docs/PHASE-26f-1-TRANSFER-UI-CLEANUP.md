# Phase 26f.1 — Transfer UI Cleanup

**Status:** IMPLEMENTED — compact Flight / Transfer Details editor; implicit status; booking-date lookup.

## UI changes

Removed from Staff Portal transfer cards:

- Status dropdown (status is implicit)
- Guest count (from booking on save)
- Lookup date (from booking check-in / check-out)
- Pickup / dropoff location fields (use Notes)

Retained per direction (arrival / departure):

- Airport dropdown — **defaults to Santander (SDR)** on empty forms
- Flight number (optional)
- Transfer date/time
- Notes
- Compact pricing line (Included in package / €25 / Bilbao rules)
- **Lookup flight** — autofill only; **Save** persists
- **Save arrival/departure transfer**

Layout: two-column grid inside each card on desktop (`Airport | Flight`, `Date/time | Notes`); stacks on narrow screens. Cards sit side-by-side on wide viewports.

## Implicit status

| Visible fields | Saved status |
|----------------|--------------|
| Empty | `not_needed` |
| Any airport, flight, time, or notes | `requested` |
| Existing `confirmed` / `cancelled` | Preserved on save |

No status dropdown in MVP.

## Lookup route

`POST /staff/bookings/:booking_id/transfers/lookup-flight`

Body (UI):

```json
{
  "client_slug": "wolfhouse-somo",
  "direction": "arrival",
  "flight_number": "IB1234",
  "airport_code": "SDR"
}
```

- `lookup_date` is **not required** from UI.
- Arrival defaults to booking **check-in** date; departure to **check-out**.
- If Aviationstack returns `flight_not_found` for that date, retry **one day earlier**.
- If both fail: `error: flight_not_found`, message: *Couldn't find that flight. Enter the flight details manually.*
- **No DB write** on lookup (`no_transfer_write: true`).

## Save route

`POST /staff/bookings/:booking_id/transfers` unchanged schema:

- Infers status when UI omits it
- `guest_count` from booking when omitted
- `pickup_location` / `dropoff_location` set null from staff UI path
- Sanitized `flight_lookup_summary` only (no raw Aviationstack payload)

## Placement

Flight / Transfer Details remains under Package; **Add-ons** remains below **Move Bed**.

## Safety

- No migrations, Stripe, payment writes, WhatsApp, Meta, n8n, or guest AI intake in this stage.

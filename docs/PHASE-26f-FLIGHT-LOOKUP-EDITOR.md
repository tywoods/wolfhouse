# Phase 26f — Flight Lookup Editor

**Status:** IMPLEMENTED (Staff Portal lookup button + autofill; save persists sanitized summary)

## Lookup route

`POST /staff/bookings/:booking_id/transfers/lookup-flight` (operator+ auth)

Body:

```json
{
  "client_slug": "wolfhouse-somo",
  "direction": "arrival",
  "flight_number": "IB1234",
  "lookup_date": "2029-10-01",
  "airport_code": "SDR"
}
```

Behavior:

- Validates direction and normalizes flight number.
- Uses supplied `lookup_date`, or defaults from booking check-in/check-out via `defaultTransferLookupDate()`.
- Calls `lookupAviationstackFlight` with `flight_number`, `flight_date`, `direction`, `airport_code`.
- **Does not write** `booking_transfers` (`no_transfer_write: true`).
- Returns sanitized lookup + `suggested_transfer_patch` for UI autofill.

Errors (no write): `missing_flight_number`, `missing_lookup_date`, `aviationstack_not_configured`, `flight_not_found`, `aviationstack_api_error`.

## Mapping

| Direction | Airport | Scheduled time |
|-----------|---------|----------------|
| Arrival | `best_match.arrival_iata` if in client config | `arrival_estimated` → `arrival_scheduled` |
| Departure | `best_match.departure_iata` if in client config | `departure_estimated` → `departure_scheduled` |

`flight_lookup_summary` stores sanitized fields only (no raw Aviationstack payload).

## Staff Portal UI

- **Lookup flight** button on each arrival/departure card.
- Disabled until flight number and lookup date are set.
- On success: autofills airport, scheduled datetime-local, stores lookup metadata for save.
- Shows note e.g. `Flight found: IB1234 arriving SDR at 18:25`.
- Fields remain editable; user clicks **Save** to persist via existing POST transfer route.

## Save

`POST /staff/bookings/:booking_id/transfers` accepts:

- `flight_lookup_provider`
- `flight_lookup_status`
- `flight_lookup_summary` (sanitized object only)

Pricing recalculates as before. No payment writes.

## Safety

- No Stripe, payment writes, WhatsApp, Meta, n8n, guest AI intake.
- No migrations.
- Lookup route is read-only for transfer rows.

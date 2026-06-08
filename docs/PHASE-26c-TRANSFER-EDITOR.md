# Phase 26c — Staff Portal transfer editor

**Status:** IMPLEMENTED  
**Depends on:** 26b foundation + 26b.2 date normalization  
**Slice:** 26c — API routes + booking drawer editor

## API routes

| Method | Path | Auth |
|--------|------|------|
| GET | `/staff/bookings/:booking_id/transfers?client_slug=` | operator+ |
| POST | `/staff/bookings/:booking_id/transfers` | operator+ |

Module: `scripts/lib/staff-booking-transfers-routes.js`

### GET response

- `airports` from `getClientAirports(client_slug)`
- `transfers` from `listBookingTransfersForBooking`
- `defaults`: `arrival_lookup_date`, `departure_lookup_date`, `guest_count` (from booking)
- Date fields formatted with `normalizeBookingDateOnly` (client timezone, Wolfhouse `Europe/Madrid`)

### POST behavior

- Loads booking by `booking_id` + `client_slug`
- `upsertBookingTransfer` on `UNIQUE (booking_id, direction)`
- Recalculates pricing via `priceBookingTransfer` — **no payment writes**
- Returns saved transfer + pricing metadata

## UI placement (booking drawer)

Order:

1. Contact / dates / guests
2. Package
3. **Flight / Transfer Details** ← new
4. Move bed
5. **Add-ons** ← below Move bed
6. Payment / running invoice
7. Conversation / handoff

Section title: **Flight / Transfer Details**

Placeholder: “Flight lookup coming next.” (Aviationstack deferred to 26e/26f)

## Editable fields (per direction)

| Field | Control |
|-------|---------|
| Status | dropdown: requested, confirmed, cancelled, not_needed |
| Airport | dropdown from API airports |
| Flight number | optional text |
| Lookup date | `date` input (defaults check-in / check-out) |
| Transfer date/time | `datetime-local` |
| Pickup / dropoff | text (arrival pickup, departure dropoff) |
| Guest count | number (defaults booking guest_count) |
| Notes | textarea |
| Pricing note | read-only from pricing helper |

Save button per direction; inline success/error.

## Date normalization

- API uses `normalizeBookingDateOnly` for booking `check_in`/`check_out` and transfer `lookup_date` in JSON
- Avoids UTC one-day shift when pg returns Date objects
- Wolfhouse timezone from `getClientTransferConfig`

## Out of scope (26c)

- Booking Calendar Transfer pebble → **26d**
- Aviationstack flight lookup → **26e/26f**
- Luna transfer wording → **26g**
- Stripe / payment writes
- WhatsApp / Meta / n8n
- Guest AI intake (Stage 27)

## Next slice: 26d

Booking Calendar light-purple **Transfer** pebble when transfer requested/confirmed.

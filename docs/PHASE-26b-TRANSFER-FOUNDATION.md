# Phase 26b — Transfer foundation

**Status:** IMPLEMENTED (foundation only — no UI, no Aviationstack, no Luna wording)  
**Design lock:** `docs/PHASE-26-AIRPORT-TRANSFERS-DESIGN.md` (commit `8d62285`)  
**Slice:** 26b — migration + config module + booking transfer helpers

## Multi-client rule

**Only config data changes per client.** Runtime logic in `scripts/lib/booking-transfers.js` and pricing reads `scripts/lib/client-transfer-config.js` — never branches on Wolfhouse airport codes.

Future clients: add an entry to `CLIENT_TRANSFER_CONFIGS` only.

Unknown client → empty airports/rules (safe default).

## Table: `booking_transfers`

Migration: `database/migrations/017_booking_transfers.sql`

| Column | Purpose |
|--------|---------|
| `client_slug` | Tenant scope (required on every query) |
| `booking_id` | FK to `bookings(id)` ON DELETE CASCADE |
| `direction` | `arrival` \| `departure` |
| `status` | `requested` \| `confirmed` \| `cancelled` \| `not_needed` |
| `airport_code` / `airport_label` | From client config |
| `flight_number` | Optional, normalized uppercase |
| `lookup_date` | Flight lookup date; defaults check-in (arrival) / check-out (departure) |
| `scheduled_at` | Transfer date/time (timestamptz) |
| `pickup_location` / `dropoff_location` | Operational locations |
| `guest_count` | Defaults from booking; per-transfer override allowed |
| `price_cents` / `currency` / `included_in_package` / `pricing_note` | Calculated metadata only — no payment writes |
| `source` | `staff` \| `luna` \| `owner` \| `import` \| `flight_lookup` |
| `flight_lookup_provider` / `flight_lookup_status` / `flight_lookup_summary` | Sanitized lookup metadata only — no raw provider payload |

**Unique:** `(booking_id, direction)` — max one arrival + one departure per booking.

**Indexes:** `(client_slug, booking_id)`, `(client_slug, lookup_date)`, `(client_slug, scheduled_at)`, `(client_slug, airport_code)`, `(client_slug, status)`.

## Config-first design

Module: `scripts/lib/client-transfer-config.js`

| Export | Purpose |
|--------|---------|
| `getClientTransferConfig(client_slug)` | Full config clone |
| `getClientAirports(client_slug)` | Airport list |
| `getClientAirportOption(client_slug, airport_code)` | Single airport |
| `normalizeAirportCode(client_slug, input)` | Code / IATA / label alias → code |
| `getTransferRules(client_slug)` | Pricing/inclusion rules |

### Wolfhouse (`wolfhouse-somo`)

| Airport | Package | Guests | Result |
|---------|---------|--------|--------|
| SDR Santander | Yes | any | Included (`price_cents=0`) |
| SDR Santander | No | any | €25 flat (`price_cents=2500`) |
| BIO Bilbao | No | any | Unavailable — `bilbao_package_required`, recommend bus |
| BIO Bilbao | Yes | ≥ 4 | €15/person extra (`1500 × guest_count`) |
| BIO Bilbao | Yes | < 4 | Unavailable — `bilbao_min_group`, staff exception |

No generic non-package Bilbao price.

## Helper API

Module: `scripts/lib/booking-transfers.js`

| Export | Purpose |
|--------|---------|
| `normalizeTransferDirection` | `arrival` / `departure` |
| `normalizeTransferStatus` | status enum |
| `normalizeFlightNumber` | trim + uppercase |
| `defaultTransferLookupDate({ direction, booking })` | check-in / check-out default |
| `priceBookingTransfer({ client_slug, booking, transfer })` | Pricing metadata only |
| `buildBookingTransferUpsertPayload({ client_slug, booking, transferInput, source })` | Normalized row payload |
| `upsertBookingTransfer(pg, { client_slug, booking_id, direction, transfer, booking, source })` | INSERT … ON CONFLICT |
| `listBookingTransfersForBooking(pg, { client_slug, booking_id })` | Client-scoped list |
| `listBookingTransfersForCalendarRange(pg, { client_slug, start_date, end_date })` | Calendar range query |

### Pricing behavior (Wolfhouse)

- **SDR + package** → `included_in_package=true`, `price_cents=0`
- **SDR + no package** → `included_in_package=false`, `price_cents=2500`
- **BIO + package + 4 guests** → `price_cents=6000`
- **BIO + package + 3 guests** → `available=false`, `error_code=bilbao_min_group`
- **BIO + no package** → `available=false`, `error_code=bilbao_package_required`
- **Unknown airport** → `available=false`, `error_code=airport_not_supported`

### MVP decisions (26b)

- **Config storage:** code module first; Admin DB tab later.
- **Flight lookup status:** lookup does not auto-change transfer `status` (explicit later slice).
- **Guest count:** default from `booking.guest_count`; per-transfer override allowed.
- **Free-text import:** skipped.
- **Calendar purple token:** deferred to 26d UI.

## Out of scope (26b)

- Staff Portal UI — **26c**
- Booking Calendar pebble — **26d**
- Aviationstack provider — **26e–26f**
- Luna transfer wording — **26g**
- Payment / Stripe integration — **26h**
- Guest AI intake — **Stage 27**
- WhatsApp / Meta / n8n changes
- Production data

## Hosted proof (staging)

After migration apply:

1. Apply `database/migrations/017_booking_transfers.sql` to staging DB.
2. Pick a disposable booking (`wolfhouse-somo`).
3. Upsert arrival transfer (SDR, package booking) via helper or SQL.
4. Upsert departure transfer for same booking.
5. Confirm second upsert on same direction updates (no duplicate).
6. Confirm conflicting direction insert succeeds (arrival + departure).
7. Run pricing helper checks for SDR/BIO scenarios.
8. Confirm no payment rows / Stripe / WhatsApp side effects.
9. `GET /healthz` → 200.

## Next slice: 26c

Staff Portal booking detail — **Flight / Transfer Details** under Package, editable fields, Add-ons below Move Bed.

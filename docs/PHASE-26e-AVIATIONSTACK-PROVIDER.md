# Phase 26e — Aviationstack Flight Lookup Provider

**Status:** IMPLEMENTED (provider foundation only — no UI lookup button, no DB writes)

## Configuration

| Item | Value |
|------|-------|
| Azure Key Vault secret | `aviationstack-api-key` |
| Container env var | `AVIATIONSTACK_API_KEY` (secretRef → Key Vault) |
| Provider module | `scripts/lib/aviationstack-flight-lookup.js` |

Whitespace-only keys are treated as missing. Raw keys are never logged or returned by status/lookup helpers.

## Lookup inputs

Aviationstack requires **flight number + flight date** — flight number alone is not unique across dates.

| Transfer direction | Default `lookup_date` (from Phase 26b) |
|--------------------|----------------------------------------|
| `arrival` | Booking check-in date |
| `departure` | Booking check-out date |

Staff can override lookup date in the transfer editor (26c); provider accepts explicit `flight_date` in `YYYY-MM-DD`.

## Provider behavior

`lookupAviationstackFlight({ flight_number, flight_date, direction, airport_code, env, fetchImpl })`:

1. Resolves `AVIATIONSTACK_API_KEY`.
2. Normalizes flight number (trim, uppercase, remove spaces).
3. Calls Aviationstack `GET /v1/flights` with `access_key`, `flight_iata`, `flight_date`, small `limit`.
4. Sanitizes candidates — no raw API payload stored (`raw_payload_stored: false`).
5. Picks `best_match` using direction + airport when provided:
   - **Arrival** + `airport_code` → prefer `arrival.iata === airport_code`
   - **Departure** + `airport_code` → prefer `departure.iata === airport_code`

### Result shape (success)

```json
{
  "success": true,
  "provider": "aviationstack",
  "flight_number": "FR1234",
  "flight_date": "2029-10-01",
  "match_count": 1,
  "best_match": { "flight_iata": "FR1234", "arrival_iata": "SDR", "...": "..." },
  "candidates": [],
  "raw_payload_stored": false
}
```

### Errors (no throw)

| Condition | `error` |
|-----------|---------|
| Missing/blank API key | `aviationstack_not_configured` |
| No matching flights | `flight_not_found` |
| HTTP/API failure | `aviationstack_api_error` / `aviationstack_request_failed` |

## Status route

`GET /staff/transfers/flight-lookup/status` (operator+ auth)

Returns configured/key fingerprint only — **no live Aviationstack call**, no raw key:

```json
{
  "success": true,
  "configured": true,
  "provider": "aviationstack",
  "key_present": true,
  "key_source": "AVIATIONSTACK_API_KEY",
  "key_fingerprint": "a1b2c3d4"
}
```

## Out of scope (26e)

- Staff Portal “Lookup flight” button → **26f**
- Writing `booking_transfers` or `flight_lookup_summary` from provider → **26f**
- Live hosted lookup unless key present and explicitly requested
- Stripe, payment writes, WhatsApp, Meta, n8n, guest AI intake
- Migrations

## Hosted proof (when requested)

1. Add Key Vault secret `aviationstack-api-key`.
2. Set staging env `AVIATIONSTACK_API_KEY=secretRef:aviationstack-api-key`.
3. Deploy staff API.
4. `GET /staff/transfers/flight-lookup/status` → `configured: true`, fingerprint only.
5. Optional one live lookup with approved flight/date — no transfer row writes in 26e.
6. `/healthz` 200.

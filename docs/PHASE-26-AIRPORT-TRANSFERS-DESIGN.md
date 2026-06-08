# Phase 26 — Airport Transfers (design lock)

**Status:** DESIGN LOCK (no implementation in this document)  
**Date:** 2026-06-08  
**Scope:** First-class, multi-client airport transfer booking operations  
**Explicitly out of scope:** Guest AI intake/extraction → **Stage 27**

---

## 1. Product direction

| Stage | Focus |
|-------|-------|
| **Stage 25** | Owner Command Center |
| **Stage 26** | Airport transfers |
| **Stage 27** | Guest AI intake/extraction |

**Stage 26 is NOT guest-facing AI.** Transfers must be built **before** guest AI tries to extract transfer details in Stage 27.

**Stage 26 delivers:**

- First-class airport transfer records per booking (arrival + departure)
- Multi-client transfer config (airports, pricing, inclusion rules)
- Staff Portal transfer editor in booking detail drawer
- Booking Calendar “Transfer” pebble indicator
- Flight lookup integration design (Aviationstack) — implementation in later slices
- Deterministic Luna wording only — no AI extraction

**Luna wording (deterministic, Stage 26):**

> “If you need airport transfer, send over your flight number when you have it, or let us know when and where to pick you up.”

Luna must **not invent flight times**. Flight lookup fills scheduled times only via Aviationstack after staff/guest provides flight number and a lookup date can be derived or supplied.

---

## 2. Business requirements

### 2.1 Core transfer behavior

- Support both **arrival** and **departure** transfers per booking.
- **Flight number is optional.**
- **Flight number alone does not uniquely identify the flight date** — always pair with a lookup date.
- **Default flight lookup date:**
  - **Arrival transfer** → booking **check-in date**
  - **Departure transfer** → booking **check-out date**
- Flight lookup may fill transfer data directly, but **all fields remain manually editable**.
- **No staff review gate** for flight lookup results in this MVP — lookup/autofill applies immediately; staff can edit afterward.
- Staff can manually edit/change flight info at any time.

### 2.2 Wolfhouse transfer business rules (client config, not hard-coded)

**Airport options:**

| Code | Label |
|------|-------|
| SDR | Santander |
| BIO | Bilbao |

**Santander (SDR):**

| Booking type | Rule |
|--------------|------|
| Package booking | Transfer **included** in package |
| Non-package booking | Transfer costs **€25** flat |

**Bilbao (BIO):**

| Condition | Rule |
|-----------|------|
| No package | **Unavailable** — recommend bus instead; no generic non-package Bilbao price |
| Package + guest_count ≥ 4 | Available — **€15/person extra** on top of package price |
| Package + guest_count < 4 | **Not normally offered** — document as unavailable; staff/manual exception allowed |

These are **Wolfhouse config/business rules**, not hard-coded product rules. Future clients can define different airports and pricing.

---

## 3. Data model

### 3.1 `booking_transfers` table

```sql
CREATE TABLE booking_transfers (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug             TEXT NOT NULL,
  booking_id              UUID NOT NULL REFERENCES bookings(id),
  direction               TEXT NOT NULL CHECK (direction IN ('arrival', 'departure')),
  status                  TEXT NOT NULL DEFAULT 'requested'
                            CHECK (status IN ('requested', 'confirmed', 'cancelled', 'not_needed')),
  airport_code            TEXT,
  airport_label           TEXT,
  flight_number           TEXT,
  lookup_date             DATE,
  scheduled_at            TIMESTAMPTZ,
  pickup_location         TEXT,
  dropoff_location        TEXT,
  guest_count             INTEGER,
  price_cents             INTEGER,
  currency                TEXT NOT NULL DEFAULT 'EUR',
  included_in_package     BOOLEAN,
  pricing_note            TEXT,
  notes                   TEXT,
  source                  TEXT CHECK (source IN ('staff', 'luna', 'owner', 'import', 'flight_lookup')),
  flight_lookup_provider  TEXT,
  flight_lookup_payload   JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (booking_id, direction)
);

CREATE INDEX idx_booking_transfers_client_booking
  ON booking_transfers (client_slug, booking_id);

CREATE INDEX idx_booking_transfers_status
  ON booking_transfers (client_slug, status)
  WHERE status IN ('requested', 'confirmed');
```

### 3.2 Field semantics

| Field | Notes |
|-------|-------|
| `direction` | `arrival` or `departure` |
| `status` | `requested`, `confirmed`, `cancelled`, `not_needed` |
| `airport_code` | IATA or client-defined code (e.g. `SDR`, `BIO`) |
| `airport_label` | Display label denormalized at write time |
| `flight_number` | Optional — e.g. `FR1234` |
| `lookup_date` | Date used for flight lookup; defaults from check-in/check-out by direction; editable |
| `scheduled_at` | Transfer date/time (timestamptz); editable |
| `pickup_location` | Arrival: airport → property; Departure: property → airport |
| `dropoff_location` | Complement to pickup as needed |
| `guest_count` | Useful for per-person pricing (Bilbao) |
| `price_cents` | Calculated or overridden charge |
| `included_in_package` | Whether transfer is included in package price |
| `pricing_note` | Human-readable pricing explanation |
| `source` | `staff`, `luna`, `owner`, `import`, `flight_lookup` |
| `flight_lookup_provider` | e.g. `aviationstack` |
| `flight_lookup_payload` | Sanitized lookup response metadata — avoid raw sensitive payloads |

### 3.3 Uniqueness decision: `UNIQUE (booking_id, direction)`

**Decision:** Each booking has at most **one arrival transfer** and **one departure transfer**.

**Rationale:**

- Wolfhouse operational model is one airport pickup on arrival and one airport dropoff on departure per guest group.
- Staff UI is simpler: two fixed sections (Arrival / Departure) in booking drawer.
- Calendar pebble logic is binary: “has transfer” if either row exists with status `requested` or `confirmed`.

**Why not multiple transfers per booking now:**

- No current business case for split groups, multi-leg journeys, or separate vehicle bookings.
- If needed later: drop the unique constraint, add `sequence` or `transfer_group_id`, and extend UI — migration path is documented but deferred.

---

## 4. Client transfer config

Generic, client-scoped transfer configuration — **not hard-coded Wolfhouse rules in engine code**.

### 4.1 Config shape (JSON or DB table)

```json
{
  "client_slug": "wolfhouse-somo",
  "timezone": "Europe/Madrid",
  "currency": "EUR",
  "airports": [
    { "code": "SDR", "label": "Santander", "iata": "SDR" },
    { "code": "BIO", "label": "Bilbao", "iata": "BIO" }
  ],
  "rules": [
    {
      "airport_code": "SDR",
      "requires_package": false,
      "min_guest_count": null,
      "included_when_package": true,
      "flat_price_cents": 2500,
      "per_person_price_cents": null,
      "unavailable_message": null
    },
    {
      "airport_code": "BIO",
      "requires_package": true,
      "min_guest_count": 4,
      "included_when_package": false,
      "flat_price_cents": null,
      "per_person_price_cents": 1500,
      "unavailable_no_package_message": "Bilbao transfer is only available for package bookings. We recommend the bus from Bilbao.",
      "unavailable_below_min_guests_message": "Bilbao transfer is normally available for groups of 4 or more. Contact staff for exceptions."
    }
  ],
  "recommendations": {
    "no_package_bilbao": "bus"
  }
}
```

### 4.2 Wolfhouse config summary

| Airport | Package | Guests | Result |
|---------|---------|--------|--------|
| SDR | Yes | any | Included |
| SDR | No | any | €25 flat |
| BIO | No | any | Unavailable — recommend bus |
| BIO | Yes | ≥ 4 | €15/person extra |
| BIO | Yes | < 4 | Not normally offered — staff exception |

**No generic non-package Bilbao price** — if no package, Bilbao is unavailable.

### 4.3 Pricing helper (26b design, no payment writes)

`scripts/lib/transfer-pricing.js` (future slice):

- Input: `client_slug`, `airport_code`, `is_package_booking`, `guest_count`
- Output: `{ available, included_in_package, price_cents, pricing_note, currency }`
- Rules read from client config — engine never branches on `"SDR"` or `"BIO"` directly.

---

## 5. Staff Portal UI

### 5.1 Booking detail drawer layout

**Section order (revised for Stage 26):**

1. Main booking info / guest / dates
2. **Package**
3. **Flight / Transfer Details** ← new, directly under Package
4. Move Bed
5. **Add-ons** ← moved below Move Bed (was above)
6. Payment / balance (read-only in 26)
7. Conversation / notes

### 5.2 Flight / Transfer Details section

Two sub-sections: **Arrival transfer** and **Departure transfer**.

Each sub-section fields (all **editable** in drawer):

| Field | Control | Notes |
|-------|---------|-------|
| Direction | Read-only label | Arrival / Departure |
| Airport | Dropdown from client config | Santander / Bilbao for Wolfhouse |
| Flight number | Text input, optional | |
| Lookup date | Date input | Defaults: check-in (arrival), check-out (departure) |
| Transfer date/time | `datetime-local` | Stored as ISO timestamptz; display in Europe/Madrid for Wolfhouse |
| Pickup location | Text | |
| Dropoff location | Text | |
| Guest count | Number (optional) | Pre-fill from booking guest count |
| Status | Dropdown | requested / confirmed / cancelled / not_needed |
| Price / included | Read-only summary + pricing_note | From pricing helper |
| Notes | Textarea | |
| Source | Read-only badge | staff / luna / owner / import / flight_lookup |

**Save behavior:** PATCH per transfer row or combined booking transfer endpoint; optimistic UI with validation errors inline.

**Flight lookup button (26f):** “Look up flight” uses `flight_number` + `lookup_date`; fills `scheduled_at`, airport if matched, and sets `source=flight_lookup`. **No staff review gate** — results apply immediately; all fields remain editable.

### 5.3 Date-time UX

- MVP: native **`datetime-local`** input unless project already has a preferred date/time component.
- Server stores **`timestamptz`** (ISO 8601).
- Client timezone: **Europe/Madrid** for Wolfhouse (from client config).
- `lookup_date` defaults from booking check-in/check-out by direction but is **always editable**.

---

## 6. Booking Calendar

### 6.1 Transfer pebble

- **When:** Booking has an arrival or departure transfer with status `requested` or `confirmed` (or any non-`not_needed` / non-`cancelled` active transfer — exact rule in 26d).
- **Visual:** Small **light-purple** pebble/bubble on booking block.
- **Text:** `"Transfer"` only — no airport code in pebble.

### 6.2 Details panel (drawer)

When clicking a booking with transfers, show:

**Arrival:**

- Airport, flight number, arrival/scheduled time, pickup location, included/price summary

**Departure:**

- Airport, flight number, departure/scheduled time, dropoff location, included/price summary

---

## 7. Aviationstack integration (later slice 26e–26f)

### 7.1 Configuration

| Item | Value |
|------|-------|
| Key Vault secret | `aviationstack-api-key` |
| Env var | `AVIATIONSTACK_API_KEY` |
| Provider module | `scripts/lib/aviationstack-flight-lookup.js` |

### 7.2 Lookup behavior

- Lookup by **`flight_number` + `lookup_date`** (not flight number alone).
- `lookup_date` defaults from booking check-in (arrival) or check-out (departure) by transfer direction.
- Response may fill: `scheduled_at`, airport code/label, pickup/dropoff hints.
- Staff can edit all fields after lookup.
- Store `flight_lookup_provider='aviationstack'` and sanitized `flight_lookup_payload` (no raw API keys, minimal PII).
- **Do not claim flight number alone determines date.**

### 7.3 MVP safety

- No automatic WhatsApp sends with lookup results.
- No guest-facing lookup in Stage 26 Luna flow (deterministic wording only).

---

## 8. Luna flow (Stage 26 — deterministic only)

| Allowed | Not allowed (Stage 27+) |
|---------|-------------------------|
| Ask guest for transfer info via template | AI extraction of flight details from free text |
| Store transfer request via staff action | Auto-create transfer from guest message parsing |
| Deterministic wording above | Invent flight times or airports |
| Hand off to staff for flight lookup | Live Aviationstack call from guest WhatsApp |

Flight lookup runs only when staff (or later guest AI with explicit flight number + date) triggers it — not from Luna guessing.

---

## 9. Pricing / inclusion behavior

Calculated by client config + pricing helper — **no Stripe, no payment writes in Stage 26**.

| Scenario | Result |
|----------|--------|
| Package + Santander | Included (`included_in_package=true`, `price_cents=0`) |
| Non-package + Santander | €25 flat (`price_cents=2500`) |
| Package + Bilbao + guest_count ≥ 4 | €15/person extra (`price_cents=1500 * guest_count`) |
| No package + Bilbao | Unavailable — recommend bus |
| Package + Bilbao + guest_count < 4 | Unavailable or staff/manual exception |

Payment integration deferred to **26h** if needed.

---

## 10. Safety rails (Stage 26)

| Forbidden in Stage 26 | Notes |
|-----------------------|-------|
| Stripe | No payment writes |
| n8n | No n8n workflow changes |
| Live WhatsApp sends | No production messaging |
| Production data | Staging/test only |
| Guest AI intake | Deferred to Stage 27 |

---

## 11. Multi-client architecture

**Do not hard-code Wolfhouse in the engine.**

| Concern | Approach |
|---------|----------|
| Airports | Client config `airports[]` |
| Pricing/inclusion | Client config `rules[]` |
| Timezone | Client config `timezone` |
| Unavailable messages | Client config per rule |
| Recommendations (bus) | Client config `recommendations` |

Wolfhouse uses Santander/Bilbao and rules in §2.2. Future clients supply their own config without code changes.

---

## 12. Implementation roadmap

| Slice | Deliverable |
|-------|-------------|
| **26a** | This design doc + verifier (current) |
| **26b** | Migration (`booking_transfers`) + client transfer config seed + `transfer-pricing.js` helper |
| **26c** | Staff Portal booking detail transfer editor (Flight / Transfer Details under Package; Add-ons below Move Bed) |
| **26d** | Booking Calendar light-purple Transfer pebble + drawer summary |
| **26e** | Aviationstack Key Vault secret + env + `aviationstack-flight-lookup.js` provider |
| **26f** | Flight lookup button + autofill (no staff review gate) |
| **26g** | Luna deterministic transfer wording/templates |
| **26h** | Transfer pricing/payment integration (later, if needed) |
| **26i** | Hosted proof |
| **26j** | Closeout |

---

## 13. Open questions

1. **Config storage:** JSON file under `config/clients/` vs dedicated `client_transfer_config` DB table — recommend DB table for admin UI later, JSON seed for 26b MVP.
2. **Transfer status workflow:** Should `requested` auto-promote to `confirmed` when flight lookup succeeds, or stay `requested` until staff confirms?
3. **Guest count source:** Always mirror booking guest count, or allow per-transfer override for split pickups?
4. **Import path:** Do existing bookings with transfer notes in free text need a one-time import slice, or staff enters manually?
5. **Calendar pebble color token:** Confirm light-purple CSS variable name with existing design system in 26d.

---

## 14. Recommended next slice: 26b

**26b — Migration + transfer config + pricing helper**

1. Add `booking_transfers` migration with `UNIQUE (booking_id, direction)`.
2. Seed Wolfhouse transfer config (SDR/BIO rules from §2.2).
3. Implement `scripts/lib/transfer-pricing.js` reading client config.
4. Add query helpers: `getBookingTransfers`, `upsertBookingTransfer`.
5. Verifier: `verify:luna-agent-phase26-transfer-migration`.

No UI, no Aviationstack, no Luna changes in 26b.

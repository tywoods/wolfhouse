# Phase 2 — Generic rental booking-acceptance path (scoping spec)

**Status:** steps 1–2 landed as pure, additive libs (no live path wired yet);
steps 3–4 remain. Additive doc — describes the wall and a safe implementation
order. No behavior change ships from this file.

**Progress:**
- ✅ Step 1 — `scripts/lib/tenant-rental-price-resolver.js` `resolveGenericRentalPrice()`
  (offering_key-native, reuses the proven `loadRule` contract, fail-closed,
  duration/item-integrity guard for #3). Verifier: `verify-tenant-rental-price-resolver.js`.
- ✅ P0b — standalone SSoT is exact `tenant_price_rules` identity only
  (`item_type=rental`, `item_code=<offering_key>__<duration_key>`, unit/location/active).
  After concrete catalog selection there is **no** `rentalOfferingKeyCandidates`
  alias borrow (fixes `surfboard_wetsuit_rental` vs `board_and_suit_rental` €0 collision).
  amount_cents <= 0 fails closed for standalone; CE during_course included €0 stays on
  equipment_options. Read-only operator audit (not production authority):
  `scripts/lib/sunset-rental-standalone-price-audit.js`.
  Focused verifier: `verify-sunset-combo-pricing-p0b.js` (never substitutes SUP).
- ✅ Step 2 — same lib, `buildGenericRentalServiceRecord()` maps a priced generic
  rental to a first-class `booking_service_records` descriptor under the existing
  `addon_service` bucket (migration 029 + runtime twin — no new migration).
- ✅ Step 3 — foundation + live wiring: `partitionRentalsForCreate()` splits
  rentals into canonical vs generic lanes by catalog membership (unknown keys
  fail closed). Create/Edit use `prepareGenericRentalsForCreate` with safety
  gates of active catalog + location + authoritative price + stock. The former
  `GENERIC_RENTAL_CREATE_ENABLED` env toggle is deprecated and unused at runtime
  (`isGenericRentalCreateEnabled` export always returns true for compatibility).
- ✅ Step 3 — generic-rental create wiring is live-verified: generic lane priced
  by `resolveGenericRentalPrice`, persisted as `addon_service`, own authoritative
  quote lines (claimed, counted once), idempotency + 409. No env toggle.
- ✅ Step 4 (#5) — frozen browser keys retired in
  `scripts/browser/sunset-schedule-rental-availability.js`:
  `scheduleActiveRentalsForDuration` now includes generic rental-category
  offerings (excludes the full-day add-on), `scheduleRentalOfferingsMode` renders
  generic-only sets, and `scheduleSerializeRentalsSelection` passes allowlisted
  generic keys through to the submit payload (unknown keys still dropped; server
  re-validates). Drawer caller passes the rendered catalog keys as the allowlist.
  Verifier: **49/49** (incl. 7 generic cases); served-page inline scripts parse 6/6.
- Combined resolver verifier: **54/54** offline.

### Note on the create coupling (why the generic lane is separate)
`prepareCanonicalRentalsForCreate()` maps every rental into legacy
`components.{surfboard,wetsuit}` and derives duration from the booking date range
(`:462`). Generic items have no such component and price on their own period, so
they take a parallel lane (partition → resolver → service record), leaving the
canonical board/wetsuit/bundle path untouched.

**Context:** Phase 2 gave the staff catalog data-driven rentable-item identity
(`tenant_rental_offerings`, migration 051) and per-period money
(`tenant_price_rules`, `offering_key__period` item_code). The catalog CRUD + seed
+ mutual-exclusion resolver are live and green. What is *not* built is the path
that lets a booking actually **accept and persist a generic offering** (e.g.
`kayak_rental`) the way it accepts the hardcoded board/wetsuit bundle today.

This is the "UI last-mile fails because the booking-acceptance path fails" from
the Captain handoff. Blocker #4 (CRUD location validation) is done separately
(`verify-rental-offerings-location-guard.js`).

## The wall (verified in code)

1. **Pricing resolver is closed + tenant-hardcoded.**
   `staffAddonResolvePricing(uiServiceType, quantity, clientSlug)`
   (scripts/staff-query-api.js) rejects anything outside
   `STAFF_ADDON_UI_SERVICE_TYPES` = {wetsuit, soft_board, hard_board, surf_lesson,
   yoga, meals} and returns `pricing not configured for client` unless
   `clientSlug === 'wolfhouse-somo'`. It prices from a static
   `config/clients/wolfhouse-somo.pricing.json` `add_ons` map, not from
   `tenant_price_rules`. A generic `offering_key` has no entry here → rejected.

2. **Bundle logic is key-literal, not data.** The create/summary/quote path
   branches on literal keys — `board_and_suit_rental`, `board_rental`,
   `wetsuit_rental` (e.g. staff-query-api.js ~22141, ~23154, ~23519). The
   data-driven replacement (`applyRentalMutualExclusion` in
   scripts/lib/tenant-rental-offerings.js) exists but is not wired into the
   server create path.

3. **Duration is bundle-centric.** The drawer emits
   `rentals:[{offering_key, duration_key, quantity}]`, but pricing keys off the
   frozen canonical period windows, so a generic offering's `duration_key` can
   mismatch its real `tenant_price_rules` row (`offering_key__period`). See the
   `item_code = offering_key + '__' + period` convention (verified pattern:
   `surf_pack_<id>__<tier>` at ~22506 / ~24183; rental rows follow
   `board_and_suit_rental__half_day`).

4. **No first-class persistence.** Generic rentals never reach
   `booking_service_records` as their own rows; only the hardcoded add-on service
   types resolve a `db_service_type` + `pricing_addon_code`.

## Safe implementation order (each step additive + offline-verifiable)

1. **Data-driven price resolver (read-only, no write path yet).** Add a resolver
   that, given `{clientSlug, locationId, offering_key, duration_key, quantity}`,
   looks up `tenant_price_rules` by `offering_key__duration_key` and returns
   `{ok, amount_cents, unit, item_code}` or fail-closed `not_found`. Mirror the
   fail-closed contract already proven in
   `verify-sunset-rental-location-boundaries.js`. Ship with a pure verifier using
   an injected `loadRule` spy — **no DB, no live pricing.json.**

2. **Generic → service-record mapping (pure).** Map a resolved generic offering
   to a `booking_service_records` shape (db_service_type fallback = `rental`,
   metadata carries `offering_key`, `duration_key`, `location_id`). Pure function
   + verifier; no INSERT wired yet.

3. **Wire into create behind existing gates.** Only after 1+2 are green, extend
   the create handler to accept `rentals[]` with generic keys, reusing
   `applyRentalMutualExclusion` for exclusion instead of the key literals. Keep
   the hardcoded wolfhouse add-on path intact (do not regress
   `verify-sunset-admin-rental-availability` once its pre-existing 8 UI failures
   are addressed by the parked UI last-mile).

4. **Retire frozen browser keys (#5) last.** The client-JS validation in the
   staff template literal still whitelists canonical keys; swap to the catalog
   feed once the server accepts generic offerings. Fragile (template-literal
   escaping — fetch served page + parse `<script>` blocks to verify).

## Step 3 — exact integration point (for the supervised change)

The server-side create wall is a single gate, now located:

- **`scripts/lib/sunset-schedule-booking-writes.js` → `prepareCanonicalRentalsForCreate()`**
  - **Line ~468:** `if (!CANONICAL_RENTAL_OFFERING_KEYS.includes(offeringKey)) → invalid_rental_offering`.
    This is blocker #1 in the create path. Replace with a catalog check
    (`listRentalOfferings` / offering exists + active for client+location),
    then price via `resolveGenericRentalPrice()`.
  - **Line ~462:** `expectedDuration = rentalDurationKeyFromDateRange(dateFrom, dateTo)`
    — duration derived from the booking date range, not the item's own pricing
    period (blocker #3). For generic items, take `row.duration_key` and let the
    resolver's item-integrity guard reject mismatches instead of forcing the
    range-derived window.
  - Persist each priced generic row via `buildGenericRentalServiceRecord()` →
    the existing `insertServiceRecord()` path (money-bearing shape at
    staff-query-api.js ~9167). Keep the canonical board/wetsuit/bundle branch
    intact; generic is an *additional* accepted case, not a replacement.
  - `CLIENT_RENTAL_MONEY_FIELDS` already rejects client-supplied money — keep
    that; the resolver is the sole price authority.
- Suggested rollout: land behind a default-OFF flag so the diff is inert until
  flipped; verify both flag states offline before enabling.

### Validation ask (needs Skipper / in-environment DB)
This host cannot reach the Sunset Postgres; the resolver is proven offline only.
To validate step 3 end-to-end, Skipper (or a Container Apps job) should, on
Sunset staging: (1) seed a disposable generic offering `kayak_rental` in
`tenant_rental_offerings` + a `tenant_price_rules` row
`kayak_rental__half_day` (unit `session`, location `sunset-somo`); (2) run the
loopback Staff API create with `rentals:[{offering_key:'kayak_rental',
duration_key:'half_day', quantity:N}]`; (3) confirm it prices and persists a
`booking_service_records` `addon_service` row with `metadata.offering_key`; (4)
deactivate the disposable offering + price. Same disposable pattern used in the
original handoff.

## Guardrails
- Do **not** flip the audited vertical-tenant isolation boundary as part of this.
- Money copy stays owned by the composer/resolver, never model memory.
- Every step lands with an offline verifier (no API key, no network, no DB).

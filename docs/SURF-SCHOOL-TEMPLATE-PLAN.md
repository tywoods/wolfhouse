# Surf-School Template Plan

**Goal:** Make the Sunset admin panel + booking brain reusable for other surf schools, so a
new school differs only by `client_slug` + its config. Sunset becomes "the first
`surf_school_shop` client," not a hardcoded special case.

Owner: Captain. Decisions locked with Earthling 2026-07-28.

## Decisions (locked)

1. **Scope (1a):** Surf-school template first. Architect the seams so any business type can
   follow later, but do not build the full multi-business-type factory now.
2. **Catalog model (refined):** Keep the **three offering types first-class** — group lessons,
   private lessons, rentals. Do **not** flatten them into one generic table; group classes hold
   rich domain info (schedule, capacity, age band, beaches, tiers) and that stays. Instead:
   - Items **within** each type become data you can add/delete (rentals get real CRUD).
   - Hardcoded lists become per-client config (beaches, age bands, group sizes).
   - Everything gets client-scoped so a new school gets its own set.
3. **Provisioning (a, Crowsnest-driven):** Crowsnest creates the new client. Build provisioning
   as a callable "create client + seed catalog" API/seed that Crowsnest triggers. No hand-written
   per-client config file, no self-serve wizard yet (add later if needed).
4. **Sunset risk (4a):** Nothing is live on Sunset staging yet (WIP, no real client). So migrate
   Sunset itself onto the generic layer — one code path, no long-lived fork. A real second school
   is lined up but will not be added for some time.

## Guiding rules

- Three offering types stay first-class. No flattening.
- Client-scope everything — remove `EXPECTED_TENANT === 'sunset'` guards; thread `client_slug`.
- Enums/lists move from code -> per-client config.
- Fail-closed pricing stays exactly as is (no active positive-amount row = not bookable).
- Every phase ends **green on both Sunset and a synthetic second client**, and is independently
  shippable + reversible.

## Phase 0 inventory (measured 2026-07-28, `feat/surf-school-template`)

- **44** files in `scripts/lib` reference `sunset`.
- **83** hard tenant guards (`clientSlug !== 'sunset'` / `=== EXPECTED_TENANT` / `tenant_mismatch`).
- **36** rental literals (`board_and_suit_rental` / `board_rental` / `wetsuit_rental` /
  `RENTAL_GROUP*`) in `scripts/staff-query-api.js` — the trickiest de-hardcode.
- **14** hardcoded enum-list definitions (`PACK_BEACHES`, `PACK_AGE_BANDS`, `PACK_GROUP_SIZES`,
  `RENTAL_GROUP_KEYS`, `RENTAL_GROUP_OFFERING`).

Highest-hit files (candidates for careful, non-mechanical work): `sunset-luna-school-context.js`,
`sunset-stripe-payment-links.js`, `sunset-schedule-booking-writes.js`,
`sunset-catalog-tool-executor.js`, `luna-front-desk-quote-service.js`, `tenant-business-config.js`.

## Admin panel surface (8 sections, all under `/staff/admin/config`)

Business Info · Surf Packs (courses) · Lesson Times + Capacity (group lessons) · Private Lesson ·
Prices (rentals — 4 hardcoded groups) · Course Equipment · Full-day Equipment add-on · Change History.

## Current pricing architecture (what we keep)

- Admin-owned DB tables scoped by `client_slug='sunset'` + `location_id`:
  `tenant_surf_pack_rules` (course defs + `config_json.price_tiers`) and `tenant_price_rules`
  (authoritative money rows). Nothing quotes/charges off pack JSON.
- Admin write path syncs pack tiers -> `tenant_price_rules` in the same transaction
  (`sunset-admin-price-sync.js`).
- Canonical identity: one active row per `client_slug + location_id + item_type + item_code + unit`.
  Duration/tier is baked INTO `item_code` (`surf_pack_<id>__<tier>`, `board_rental__1_day`);
  `unit` is billing grain only (person/day/session/item). **Latent footgun** — querying bare code
  + `unit=<duration>` returns 0 rows; already broke one branch. Phase 1 adds a guard test.
- Single resolver `resolveActiveSunsetAdminPrice` -> `loadTenantPriceRuleFromDb`, fail-closed.

## Phases

### Phase 0 — Foundations & safety net (do first, small)
- Categorize the 44 sunset files into: tenant-guard, enum/list, display-string, item_code convention.
- Add one `client_config` resolver: `client_slug -> { business_type, beaches, age_bands,
  group_sizes, currency, locations, offering_types }`. Single source of truth.
- Stand up a **template smoke gate**: run the full admin + booking verify suite for Sunset AND a
  synthetic `template-school` client. This backstops every later phase.

### Phase 1 — De-tenant the vertical→tenant binding + pricing spine
**Linchpin (do first): `scripts/lib/luna-front-desk-vertical-scope.js`.** Its `VERTICAL_TENANT`
map is a 1:1 `surf_school -> 'sunset'` binding enforced inside `assertResolvedVerticalScope` (a
**403 cross-tenant isolation boundary**). To allow multiple surf schools it must become a
*membership* check: `resolved.clientSlug` must be a valid tenant for the vertical
(`isSurfSchoolClient(slug)` for surf_school, `isWolfhouseClientSlug` for accommodation) rather
than `=== THE_ONE_TENANT`. This PRESERVES isolation (a wolfhouse slug still 403s on surf_school)
while widening surf_school from {sunset} to {configured surf schools}.

⚠️ **This is an audited security boundary.** `scripts/verify-fortress-tenant-identity-boundary-matrix.js`
(97 checks, pure-logic, currently GREEN) documents isolation verdicts + an assertion floor. Any
change here must: (a) keep that gate green, (b) extend it to prove a *second* surf school passes
surf_school scope while a wolfhouse slug still fails, and (c) run the full booking/auth regression
(needs DB — run on Lunabox/staging, not the laptop). **Requires Skipper review before merge.** Not
done solo.

Then, lower-risk: generalize `sunset-admin-price-identity` / `-resolve` to take `client_slug`;
drop the `!== 'sunset'` gate; keep `sunset-*` as thin callers during migration. Add the item_code
convention guard test.

### Phase 2 — Rentals become a real catalog (the concrete win)
- New `tenant_rental_offerings` table (client+location scoped): `offering_key, label, group,
  mutual_exclusion, active`.
- Panel renders rentals from that table + gains add / rename / delete item actions.
- Replace hardcoded `RENTAL_GROUP_*` maps and every `if (key === 'board_and_suit_rental')`
  exclusion in `staff-query-api.js` with data reads.
- Migration seeds Sunset's current 4 items -> Sunset looks identical; smoke client can add e.g. "kayak".

### Phase 3 — Group + private lessons: keep structure, client-scope + de-enum
- Keep surf_pack / lesson-times / private-lesson tables and all their fields.
- Move beaches, age bands, group sizes, schedule presets into archetype-default + per-client config.
- Client-scope their read/write paths (remove sunset literals).

### Phase 4 — Provisioning API for Crowsnest
- `POST /internal/clients` (idempotent, fail-closed): creates client_config, locations,
  starter/empty catalog, staff-portal access. Crowsnest calls this.
- Phase-1 form is a seed script the endpoint wraps; verify by provisioning a throwaway school in
  staging, walking the panel, tearing it down.

### Phase 5 — Migrate Sunset fully + retire dead code
- Flip Sunset to read entirely from client_config; delete dead `sunset-*` hardcoded branches once
  parity is proven by the smoke gate.

## Risks / notes

- `staff-query-api.js` (~39k lines) is the hard part — 36 rental literals through the booking-drawer
  logic. Phase 2 must route all of it through data reads carefully.
- The item_code convention is a latent trap — Phase 1's guard test is non-negotiable.
- **Delegation:** mechanical sweeps (Phase 0 inventory, Phase 2/3 literal replacement) go to Skipper
  / cheap subagents. Captain owns schema design, resolver generalization, and review.
- Related prior groundwork: `config/archetypes/surf_school_shop/` (FACTORY 1B static templates,
  disabled) and `factory-slice1c-dry-run-generator.js` — reuse where it fits Phase 4.

## Phase 2 wiring spec (exact call-sites to swap onto `tenant_rental_offerings`)

Groundwork already landed (additive, unwired): migration `051_tenant_rental_offerings.sql`,
`scripts/lib/tenant-rental-offerings-seed.js` (+ its gate). Remaining wiring:

**Admin write path — `scripts/lib/tenant-admin-writes.js`:**
- `RENTAL_GROUP_KEYS`/`RENTAL_GROUP_OFFERING`/`RENTAL_GROUP_DISPLAY` (lines 38-50) become reads
  from `tenant_rental_offerings` for the client+location.
- `resolveRentalGroupOffering` (389) resolves against the table, not the frozen map.
- display-name resolution (761-762, 840) reads the row `label`.
- Add create/rename/delete-item endpoints (today only price add/edit exists).

**Booking drawer exclusion logic — `scripts/staff-query-api.js`:** replace hardcoded
`board_and_suit_rental` checks + `scheduleApplyRentalMutualExclusion` with reads of each row's
`excludes[]`:
- 22135-22136 (board/wetsuit-on derivation), 23148/23160/23201/23217 (bundle detection),
  23287-23288 & 23513-23517 (mutual-exclusion apply), 23400/23414-23417 (bundle-only filter),
  23455 (label fallback).

**Gate:** extend the template smoke gate to prove a NEW item (e.g. `kayak_rental`) added to
`tenant_rental_offerings` renders + books + honours exclusions, with Sunset's 4-item catalog
byte-identical. Needs DB (run on Lunabox/staging) → Skipper.

## Phase 1 pricing-resolver spec (exact de-tenant sites, lower-risk half)

Separate from the linchpin boundary above. The pricing resolver is fail-closed (not a 403
isolation gate), and its tenant coupling is small and contained:
- `scripts/lib/sunset-admin-price-identity.js:21` — `const EXPECTED_TENANT = 'sunset'`.
- `scripts/lib/sunset-admin-price-resolve.js:39-45` — defaults `clientSlug` to `EXPECTED_TENANT`
  and returns `tenant_mismatch` when `clientSlug !== EXPECTED_TENANT`.
- `scripts/lib/sunset-bookable-offerings.js:422` — `tenant_mismatch` guard.

**Change:** accept `client_slug` as an input; replace the `=== EXPECTED_TENANT` equality with a
membership check (`isSurfSchoolClient(slug)` from `surf-school-config.js`), keeping the fail-closed
default. Identity building already keys on `client_slug + location_id`, so no schema change.

**Blast radius:** 13 importers of `resolveActiveSunsetAdminPrice` — mostly verify scripts, plus
`sunset-bookable-offerings.js`, `sunset-course-lesson-price-lookup.js`,
`sunset-schedule-booking-writes.js`. Thread the resolved slug through; keep `sunset` behaviour
byte-identical (parity gate), then prove a second surf school resolves prices from its own rows.
Needs the DB pricing regression → Skipper.

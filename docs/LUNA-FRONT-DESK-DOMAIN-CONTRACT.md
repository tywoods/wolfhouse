# Luna Front Desk — domain / application contract

**Status:** Canonical for Sunset surf-school booking (Slice 1 proven, Slice 2 documented)  
**Base SHA:** `dd9201baf4e318948802ee0da4020ac705b24d6b`  
**Scope:** Describes what the **working code** does today — not a target rewrite.

This contract separates:

| Layer | What it covers |
|-------|----------------|
| **Luna Front Desk platform** | Tenant/location isolation, offering projection, schedule eligibility, authoritative pricing, quote vs write, idempotency, error surfacing, Staff + Luna sharing the same application operations |
| **Surf-school vertical (Sunset)** | Admin surf packs / course tiers, capacity, weekend rules, course join on write, waiver/payment links |
| **Accommodation vertical (Wolfhouse)** | Out of scope here — Sunset bot routes **reject** accommodation fields |
| **Tenant configuration** | Admin JSON + `tenant_*` DB tables per `client_slug` + `location_id` |

---

## 1. Proven journey (Slice 1)

End-to-end path exercised on Sunset staging:

```
Admin offering (surf pack + tier + price)
  → schedule eligibility (Schedule create selector)
  → availability / capacity (write-time join gate)
  → authoritative quote (catalog + offering-quote)
  → booking creation (staff manual OR Luna bot)
  → persisted service rows + payment link (Stripe TEST)
```

**Evidence:** live probe `slice1-wo-mrl5n572` — weekend-only course @ **€199** (`19900` cents), identity `surf_pack_<pack_id>__1_week`, date **2026-07-18**.

**Payment artifacts (Slice 1 gap closed):** Luna conversational bookings created `cs_test_*` Stripe Checkout sessions only; bookings cancelled via `POST /staff/bot/bookings/cancel`; `paid=false`, `amount_paid_cents=0`. See `scripts/audit-slice1-synthetic-payments.js` (operator audit tool, not deployed).

---

## 2. Canonical entities

### 2.1 Offering

A **bookable product surface** projected from Admin config + DB price rules.

| Field | Owner | Notes |
|-------|--------|------|
| `offering_id` | Platform projection | Stable string; for course tiers equals `item_code` |
| `offering_type` | Projection | `course` \| `private_lesson` \| `rental` \| `addon` |
| `label`, `guest_description` | Admin config | Display only |
| `bookable` | Projection | Requires resolvable price + (when dates given) schedule eligibility |
| `eligible_on_requested_dates` | ScheduleRule eval | Course may appear but be ineligible on weekdays |
| `schedule_rejection` | ScheduleRule | Staff/guest-safe message when ineligible |
| `price_identity` | PriceRule | `{ item_type, item_code, unit }` |
| `unit_amount_cents`, `currency`, `price_source` | PriceRule | `admin_db` preferred; config JSON fallback in read-only paths |
| `location_id` | Tenant config | `sunset-somo` \| `sunset-sardinero` |

**Module owner:** `scripts/lib/sunset-bookable-offerings.js` — `projectSunsetBookableOfferingsFromConfig`, `loadSunsetBookableOfferings`.

### 2.2 OfferingTier (course)

A duration/price tier on an Admin **surf pack**.

| Field | Owner | Notes |
|-------|--------|------|
| `course_id` / `pack_id` | Admin `tenant_surf_pack_rules.id` | UUID; never minted on write |
| `tier_key` | Admin `config_json.price_tiers[].key` | e.g. `1_week`, `single_class` |
| `offering_id` / `item_code` | Platform identity | `surf_pack_<pack_id>__<tier_key>` |
| `billing_unit` | Identity resolver | `day` for multi-day tiers; `session` for `single_class` |
| `amount_cents` | PriceRule (`tenant_price_rules`) | Authoritative on write |

**Module owner:** `scripts/lib/sunset-admin-price-identity.js` — `courseTierIdentity`, `packPriceItemCode`.

### 2.3 ScheduleRule

When an offering may be booked.

| Field | Owner | Notes |
|-------|--------|------|
| `weekly` | Admin pack | `mon_fri`, `sat_sun`, `daily`, … |
| `allowed_weekdays` | Derived | e.g. `[0,6]` for weekends |
| `specific_dates`, `excluded_dates` | Admin pack | Optional overrides |
| `starts_on`, `ends_on` | Admin pack | Effective window |
| `time_slots` | Admin `schedules[]` | Keys like `0930_1130` |
| `timezone` | Platform default | `Europe/Madrid` |

**Evaluation:** `scripts/lib/sunset-offering-schedule.js` — `evaluateSunsetOfferingDates`, `datesBelongToPackSchedule`.

**Reason codes:** `service_dates_not_on_course_schedule`, `excluded_date`, `outside_effective_range`, `offering_not_available_on_dates`, `course_schedule_not_configured`.

### 2.4 PriceRule

Authoritative money for an identity.

| Field | Owner | Storage |
|-------|--------|---------|
| `client_slug` | Tenant | `sunset` |
| `location_id` | Tenant config | Required for lookup |
| `item_type` | Identity | `package`, `lesson`, `rental`, … |
| `item_code` | Identity | e.g. `surf_pack_<uuid>__1_week` |
| `unit` | Identity | Must match tier billing unit (`day`, `session`, …) |
| `amount_cents` | Admin / DB | Positive integer |
| `effective_from` / `effective_to` | DB | Window check on read |

**Module owner:** `scripts/lib/sunset-admin-price-resolve.js` — `resolveActiveSunsetAdminPrice`.

### 2.5 Quote

Read-only priced intent **before** a write.

| Field | Present on success |
|-------|-------------------|
| `offering_id`, `course_id`, `tier_key`, `offering_item_code` | Identity parity |
| `service_dates[]`, `quantity` | Inputs |
| `unit_amount_cents`, `total_cents`, `billable_units` | Computed |
| `price_source`, `billing_mode`, `billing_unit` | Authority trace |
| `schedule_summary` | When dates provided |

**Module owner:** `scripts/lib/luna-front-desk-quote-service.js` — `executeSunsetQuote`, `buildQuoteProvenance`.

**HTTP:** `POST /staff/bot/sunset/offering-quote`, `POST /staff/schedule/bookings/quote` (Staff preview).

### 2.7 Catalog (offering discovery)

Read-only projection of bookable offerings shared by Schedule, Luna, and Staff quote prep.

| Field | Notes |
|-------|--------|
| `offerings[]` | Nested guest/staff shape; priced offerings for booking surfaces |
| `courses[]` | Schedule create-menu projection (tiers + schedule summary) |
| `excluded_offerings[]` | Operator mode only — inactive/unpriced/ineligible with `exclusion_reason` |
| `eligible_on_requested_dates` | When `service_dates` provided |
| `schedule_rejection` | Canonical weekday/date rejection (never reinterpreted per consumer) |

**Module owner:** `scripts/lib/luna-front-desk-catalog-service.js` — `buildSunsetCatalogCommand`, `executeSunsetCatalog`.

**HTTP:** `POST /staff/bot/sunset/catalog`, `GET|POST /staff/schedule/bookings/catalog`.

When `SUNSET_ADMIN_DB_READ_ENABLED`, catalog **does not** treat config-json tier amounts as bookable without a matching Admin DB price row.

### 2.6 Booking

Header row + attribution.

| Field | Owner | Notes |
|-------|--------|------|
| `booking_id`, `booking_code` | Write layer | `SUNSET-YYYYMMDD-HEX` (Somo) |
| `guest_name`, `guest_phone` | Request | Required name |
| `payment_status` | Request | `unpaid` \| `paid` \| `pending` |
| `total_cents` | Server after pricing | Never trust client |
| `metadata.source` | Attribution | `staff_manual_schedule` vs `luna_guest_whatsapp` |
| `idempotency_key` | Request (optional) | Max 120 chars; replay returns same booking |

**Module owner:** `scripts/lib/sunset-schedule-booking-writes.js` — `createSunsetScheduleBooking`.

### 2.7 BookingService

Per-date service line (`booking_service_records`).

| Field | Owner | Notes |
|-------|--------|------|
| `service_type` | Write mapper | Course → `surf_lesson` |
| `service_date` | Request dates | ISO date |
| `quantity` | Component | Surfers |
| `metadata.course_id`, `metadata.tier_key`, `metadata.offering_id` | Write layer | Canonical identity persisted |
| `amount_due_cents` | Post-create pricing | DB-authoritative |
| `source` | Attribution | `staff_manual` \| `luna_guest` |

---

## 3. Application operations (shared by Staff and Luna)

| Operation | Staff surface | Luna surface | Write? |
|-----------|---------------|--------------|--------|
| **Load admin catalog** | `GET /staff/admin/config` | — | No |
| **Project offerings** | Schedule UI cache | — | No |
| **Guest catalog** | — | `POST /staff/bot/sunset/catalog` | No |
| **Schedule catalog (create menu)** | `GET /staff/schedule/bookings/catalog` | — | No |
| **Quote offering** | Manual preflight (internal) | `POST /staff/bot/sunset/offering-quote` | No |
| **Joinable courses / capacity** | Schedule ops | `POST /staff/bot/sunset/joinable-courses` | No |
| **Create booking** | `POST /staff/schedule/bookings` | `POST /staff/bot/sunset/booking-create` | Yes |
| **Payment link** | Schedule drawer / GET payment-link | Luna tool `create_sunset_booking` path | Yes (Stripe TEST on staging) |
| **Payment status** | Drawer | `POST /staff/bot/sunset/payment-status` | No (reconcile advisory) |

Both create paths call **`createSunsetScheduleBooking`** with the same body shape; only **actor attribution** differs.

---

## 4. Validation order (before writes)

### 4.1 Request normalization

1. `normalizeSunsetBookingDatesInBody` — ISO dates, omitted-year rules  
2. `validateScheduleBookingBody` — guest, components, dates (≤31), payment_status  
3. `normalizeComponents` — **reject client money fields** on any component  
4. Course component requires `course_id` + `tier_key` (or derivable from `offering_id`)

### 4.2 Course write gate (`createSunsetScheduleBooking`)

1. Tenant `client_slug === 'sunset'`  
2. Idempotency replay (if key present)  
3. Full-day equipment addon price (if component present)  
4. **`assertCourseAssignable`** — pack exists, dates on schedule, capacity  
5. Tier belongs to pack; server sets `offering_id = packPriceItemCode(course_id, tier_key)`  
6. **`resolveActiveSunsetAdminPrice`** preflight (+ optional `syncPackTierToPriceRules` heal)  
7. **Transaction:** insert booking + service records → **`priceSunsetBookingServices`** (rollback on fail)

### 4.3 Luna-only HTTP gates (`handleBotSunsetBookingCreate`)

- `BOT_BOOKING_ENABLED`  
- `guest_confirmed_booking === true` (literal boolean)  
- Rejects accommodation fields (`check_in`, `bed`, `package`, …)  
- Forces `actor.source = agent_luna_whatsapp_bot`

---

## 5. Pricing and billing invariants

1. **Clients never supply money fields** — rejected in `normalizeComponents`.  
2. **DB price rules win on write** — `price_source: admin_db`.  
3. **Course tier billing:** multi-day tiers use **`whole_offering_x_qty`** (once per surfer, not × dates); `single_class` uses session × qty × dates.  
4. **Quote total must match write total** for the same identity + dates + quantity (Slice 1 proved @ 19900).  
5. **Missing price fails closed** — booking rolled back; staff message via `staffFacingSunsetAdminPriceError`.  
6. **Stripe on Sunset staging:** TEST keys only; checkout sessions `cs_test_*`; livemode refused in bot cancel expire path.

---

## 6. Date and timezone rules

- **Timezone tag:** `Europe/Madrid` on schedule evaluation responses.  
- **Weekday math:** ISO date + `T12:00:00Z` anchor (`weekdayOfIsoDate`) — avoids local DST drift.  
- **Guest intake:** `normalizeSunsetBookingDatesInBody` may require clarification (`needs_clarification`) before write.  
- **Schedule copy:** weekend-only courses → *"This course runs on weekends. Choose a Saturday or Sunday."*

---

## 7. Transactions and idempotency

- **Booking create:** single DB transaction; pricing failure → rollback / cancel provisional booking.  
- **Idempotency:** `idempotency_key` stored on service record metadata; replay returns `{ idempotent: true, booking_id, booking_code, records }`.  
- **Pack create/update:** pack + linked `tenant_price_rules` rows in one transaction (`createSurfPackRule`).  
- **Bot test cancel:** neutralizes unpaid TEST checkout rows; never touches paid bookings.

---

## 8. Tenant and location isolation

| Rule | Enforcement |
|------|-------------|
| Sunset-only writes | `SUNSET_CLIENT_SLUG = 'sunset'`; staff schedule POST 403 otherwise |
| Location whitelist | `sunset-somo`, `sunset-sardinero` via `normalizeSunsetLocationId` |
| Bot location | `resolveSunsetBotBodyLocation`; default Somo |
| Price / capacity SQL | Filter `client_slug`, `metadata->>'location_id'` |
| Cross-tenant price lookup | `tenant_mismatch` |

---

## 9. Error codes and safe messages

### Schedule (guest/staff)

| Code | Safe message (typical) |
|------|------------------------|
| `service_dates_not_on_course_schedule` | Weekend/weekday hint via `staffFacingOfferingScheduleError` |
| `course_full` | Capacity exceeded (includes date, seats) |
| `unknown_course_id` | Unknown / invented course |
| `components.course.tier_key is required` | Select course duration |

### Price

| Code | Safe message |
|------|--------------|
| `price_not_configured` / `no_price_for_*` | Missing Admin price — contact team |
| `ambiguous_price` | Duplicate Admin prices |
| `tier_key is required` / `course_tier_mismatch` | Duration selection errors |

### Luna bot HTTP

| Code | Meaning |
|------|---------|
| `guest_confirmed_booking_required` | Must confirm before create |
| `accommodation_fields_not_supported` | Sunset is surf-only |
| `unknown_location` | Bad `location_id` |

**Rule:** Guest-facing copy comes from tool results / Luna SOUL — never SQL or internal table names.

---

## 10. Compatibility — current tables and metadata

| Concept | Current storage |
|---------|-----------------|
| Admin course | `tenant_surf_pack_rules` + `config_json` |
| Admin price | `tenant_price_rules` linked on pack create |
| Booking | `bookings` + `booking_service_records` |
| Course identity on row | `metadata.course_id`, `metadata.tier_key`, `metadata.offering_id` |
| Location | `metadata.location_id` on services |
| Luna attribution | `source = luna_guest`, metadata `luna_guest_whatsapp` |
| Staff manual | `source = staff_manual`, metadata `staff_manual_schedule` |
| Payment | `payments` + Stripe session id in metadata / `checkout_url` |

---

## 11. Migration notes (known inconsistencies)

Documented gaps — **not blockers for Slice 1** — for future platform extraction:

1. **~~Stale checkout URL after cancel~~ (fixed Slice 10):** ~~Cancelled Luna probe bookings may still expose `cs_test_*` URL via `GET /staff/schedule/bookings/payment-link` while `payments` row is neutralized (`payment_id: null` in API).~~ Canonical `getPaymentStatus` / `resolveActionableCheckoutUrl` in `luna-front-desk-payment-link-service.js` never returns metadata fallback when booking or payment link is invalidated.  
2. **~~Schedule drawer read~~ (fixed Slice 11):** ~~`GET .../bookings/detail` returns 403 for Luna-attributed bookings~~ Staff and Luna persisted bookings share the canonical drawer when `record_source` is trusted (`staff_manual` / `luna_guest`) and tenant/location match. Untrusted legacy/demo rows remain blocked (`drawer_untrusted_booking_source`).  
3. **Dual price paths:** ~~Read-only catalog can fall back to config JSON amounts~~ Catalog service disables config-json bookability when `SUNSET_ADMIN_DB_READ_ENABLED`; **writes require DB** when flag is on.  
4. **Group lesson slots:** Legacy `lesson_slot_*` identities exist in code but Luna catalog policy returns **courses + private only** (`group_lessons: []`).  
5. **Wolfhouse bot token vs Sunset:** Staging KV `luna-bot-internal-token` may differ from `hermes-sunset-luna` container token — Sunset bot routes require the Sunset deployment token.  
6. **Accommodation vertical:** Wolfhouse booking fields explicitly rejected on Sunset bot create — shared platform contract for accommodation not yet unified in this doc.

---

## 12. Module map (implementation)

| Concern | Module |
|---------|--------|
| Offering projection | `scripts/lib/sunset-bookable-offerings.js` |
| Schedule rules | `scripts/lib/sunset-offering-schedule.js` |
| Catalog (discovery) | `scripts/lib/luna-front-desk-catalog-service.js` — `buildSunsetCatalogCommand`, `executeSunsetCatalog` |
| Catalog adapters | `scripts/lib/sunset-luna-admin-catalog.js` |
| Course join / capacity | `scripts/lib/sunset-admin-course-join.js` |
| Price resolve | `scripts/lib/sunset-admin-price-resolve.js`, `sunset-course-lesson-price-lookup.js` |
| Booking writes | `scripts/lib/sunset-schedule-booking-writes.js` |
| **Booking create application service** | `scripts/lib/luna-front-desk-booking-create-service.js` — `buildSunsetBookingCreateCommand`, `executeSunsetBookingCreate` |
| **Payment-link application service** | `scripts/lib/luna-front-desk-payment-link-service.js` — `createPaymentLink`, `getPaymentStatus`, `cancelOrInvalidatePaymentLink` |
| **Quote application service** | `scripts/lib/luna-front-desk-quote-service.js` — `buildSunsetQuoteCommand`, `executeSunsetQuote`, `validateQuoteProvenanceForCreate` |
| **Vertical resolver + adapter** | `scripts/lib/luna-front-desk-business-vertical.js`, `scripts/lib/verticals/surf-school-vertical-adapter.js` |
| HTTP surface | `scripts/staff-query-api.js` |
| Contract verifier | `scripts/verify-luna-front-desk-domain-contract.js` |
| Sunset pipeline gate | `scripts/verify-sunset-canonical-offering-pipeline.js` |

---

## 13. Vertical boundaries

### Platform (this contract)

Offering identity, schedule eligibility, authoritative quote, shared write pipeline, idempotency, tenant/location guards, error taxonomy.

### Surf-school (Sunset tenant config)

Surf packs, tier keys, weekly schedules, beaches, group size, waiver + surf lesson service types, Stripe payment short links on `sunset-staging.lunafrontdesk.com`.

### Accommodation (Wolfhouse)

Bed codes, nights, packages — **not accepted** on Sunset bot booking create; separate Staff API tenant and Hermes runtime.

### Tenant configuration

Per-location Admin JSON overlays + DB migrations; not hard-coded in this contract. Sunset locations: `sunset-somo`, `sunset-sardinero`.

---

## 14. Business vertical adapter (Slice 6)

HTTP routes resolve a **trusted tenant context** (auth-scoped `client_slug` + `location_id`) to a vertical adapter. Application services stay vertical-specific; the adapter is a thin delegation boundary.

### Resolver

**Module:** `scripts/lib/luna-front-desk-business-vertical.js` — `resolveBusinessVertical`, `invokeVerticalOperation`.

| `client_slug` | Vertical | Status |
|---------------|----------|--------|
| `sunset` | `surf_school` | **Migrated** — delegates to Slice 3–5 services |
| `wolfhouse-somo` (`wolfhouse` alias) | `accommodation` | **Migrated** — delegates to Wolfhouse application helpers |
| other | — | Fail closed (`unknown_tenant`) |

Location for Sunset must pass `isSunsetLocationId`; unknown locations fail closed (`unknown_location`). Body-supplied tenant/location never override auth-scoped context.

### Vertical operations (interface)

| Operation | Surf-school delegate | Accommodation delegate | Write? |
|-----------|---------------------|------------------------|--------|
| `listOfferings` | `luna-front-desk-catalog-service` | `wolfhouse-accommodation-application` (+ pricing config) | No |
| `quoteOffering` | `luna-front-desk-quote-service` | `wolfhouse-accommodation-application` → `calculateWolfhouseQuote` | No |
| `createBooking` | `luna-front-desk-booking-create-service` | `luna-front-desk-accommodation-booking-create-service` → dry-run or live write | Dry-run or live |
| `evaluateDates` | `sunset-offering-schedule` | `wolfhouse-package-night-rules` + season quote gate | No |
| `checkAvailability` | catalog + capacity enrichment | `runAvailabilityCheckDryRun` | No |

**Adapters:** `scripts/lib/verticals/surf-school-vertical-adapter.js`, `scripts/lib/verticals/accommodation-vertical-adapter.js`.

**Application layer:** `scripts/lib/wolfhouse-accommodation-application.js` — single delegation target for Wolfhouse stay/package/availability/create; no Sunset catalog or price resolver imports.

**Accommodation booking create (Slice 8):** `scripts/lib/luna-front-desk-accommodation-booking-create-service.js`

| Export | Role |
|--------|------|
| `BOOKING_CREATE_CHANNELS` | `manual_staff` \| `luna_whatsapp` |
| `buildWolfhouseBookingCreateCommand(opts)` | Normalize transport → trusted command; dry-run when `confirm !== true` |
| `executeWolfhouseBookingCreate(pg, command, execOpts?)` | BEGIN/COMMIT transaction: booking + beds + quote metadata + payments |

**Accommodation availability (Slice 9):** `scripts/lib/luna-front-desk-accommodation-availability-service.js`

| Export | Role |
|--------|------|
| `AVAILABILITY_CHANNELS` | `bot_http` \| `luna_whatsapp` \| `vertical_adapter` \| `booking_preflight` \| `manual_staff` |
| `AVAILABILITY_PROVENANCE_VERSION` | Fingerprint schema version (currently `1`) |
| `buildWolfhouseAvailabilityCommand(opts)` | Normalize transport → trusted read-only command |
| `executeWolfhouseAvailabilityCheck(pg, command)` | Authoritative bed/capacity check — **zero writes** |
| `mapBotHttpAvailabilityResponse(canonical, httpOpts?)` | Route-only HTTP enrichment (`auth_mode`, `elapsed_ms`, `next_action`) |
| `buildAvailabilityProvenance(canonical)` / `computeAvailabilityFingerprint` | Material-change detection for booking preflight |
| `validateAvailabilityProvenanceForCreate(pg, command, provenance)` | Re-check before commit; rejects stale inventory |

**Availability command (trusted):** `channel`, `clientSlug` (`wolfhouse-somo` only), `checkIn`, `checkOut`, `guestCount`, `roomType`, package/room/gender preferences, `demoCalendarEnrichment` (Wolfhouse demo-calendar row/block filter), `assignmentMode` (gender-aware bed pick for Luna preflight).

**Availability result (canonical):** `has_enough_beds`, `available_count`, `selected_bed_codes`, `blockers`, `warnings`, `occupied_bed_codes`, `provenance`, `domain_next_action`. HTTP route adds `auth_mode`, `elapsed_ms`, bot-specific `next_action` only.

**Write-time recheck invariant:** Booking create stores `availabilityProvenance` at command build. `executeWolfhouseBookingCreate` calls `validateAvailabilityProvenanceForCreate` **before** `BEGIN`; SQL overlap guard in `buildManualBookingCreateSql` remains the final defense-in-depth lock.

**Command inputs (trusted):** `channel`, `trustedClientSlug` (`wolfhouse-somo` only), `transportBody`, `actorHints`, optional `pgClient` (bot bed auto-assign), `stripeConfig` / `privateRoomHooks` (manual execute).

**Rejected before write:** surf-school transport fields; client-supplied money (`total_cents`, `deposit_required_cents`, …); tenant mismatch.

**Result shape:** `{ ok, status, body }` with outcome flags `_duplicate`, `_blocked`, `_safety_violation`, `_payment_failed`, plus `quote`, `assignedBedCodes`, `booking_id`, etc.

**Staff routes:** `POST /staff/bot/bookings/create`, `POST /staff/manual-bookings/create` — feature flags + HTTP mapping only; transaction delegated to this service.

### Shared platform vs surf-school

| Layer | Owns |
|-------|------|
| **Platform** | Vertical resolver, tenant/location guards, channel normalization, invoke wiring |
| **Surf-school** | Sunset catalog/quote/create services, schedule rules, course join, Admin surf packs |
| **Accommodation (Slice 7)** | Wolfhouse nights, packages, beds — `wolfhouse-somo` tenant; rejects surf-school transport fields |

### Migration status

- **Slice 6 (done):** Sunset Staff/Luna catalog, quote, create, joinable-courses routes call `invokeVerticalOperation` — no direct imports of catalog/quote/create services in `staff-query-api.js`.
- **Slice 7 (done):** Wolfhouse accommodation adapter replaces `not_migrated` placeholder. Migrated routes: `POST /staff/quote-preview` (application quote helper), `POST /staff/bot/package-price-preview` (vertical `listOfferings`).
- **Slice 8 (done):** Live accommodation `createBooking` extracted to `luna-front-desk-accommodation-booking-create-service.js`. Bot/manual Staff routes delegate to `buildWolfhouseBookingCreateCommand` + `executeWolfhouseBookingCreate`.
- **Slice 9 (done):** Canonical accommodation availability in `luna-front-desk-accommodation-availability-service.js`. `POST /staff/bot/availability-check`, vertical `checkAvailability`, Luna dry-run, and booking-create preflight share one read-only engine with provenance + write-time recheck.

### Accommodation capabilities (Slice 9)

| Capability | Status | Notes |
|------------|--------|-------|
| Live `createBooking` writes | **Migrated** | Adapter + Staff bot/manual routes use accommodation booking-create service |
| `POST /staff/bot/availability-check` parity | **Migrated** | Route delegates to availability service; HTTP enrichment via `mapBotHttpAvailabilityResponse` |
| Availability provenance + preflight recheck | **Migrated** | `availabilityProvenance` on booking command; `validateAvailabilityProvenanceForCreate` before transaction |
| Payment link / Stripe orchestration | **Migrated (Slice 10)** | Staff generate/cancel, draft Stripe link (Staff + Luna bot), Sunset schedule read/create delegate to payment-link service |
| Cross-vertical body tenant override | **Rejected** | Trusted auth-scoped `client_slug` only |

### Accommodation capabilities (Slice 8 — historical)

| Capability | Status | Notes |
|------------|--------|-------|
| Live `createBooking` writes | **Migrated** | Adapter + Staff bot/manual routes use accommodation booking-create service |
| Full HTTP parity on `POST /staff/bot/availability-check` | **Migrated (Slice 9)** | See accommodation availability service |
| Payment link / Stripe orchestration | **Migrated (Slice 10)** | Staff generate/cancel, draft Stripe link (Staff + Luna bot), Sunset schedule read/create delegate to payment-link service |
| Cross-vertical body tenant override | **Rejected** | Trusted auth-scoped `client_slug` only |

---

## 15. Payment-link application service (Slice 10)

Canonical payment-link lifecycle shared by Staff portal, Luna bot, and Sunset schedule drawer.

**Module:** `scripts/lib/luna-front-desk-payment-link-service.js`

### Operations

| Operation | Entry | Purpose |
|-----------|-------|---------|
| `createPaymentLink` | Staff `POST .../generate-payment-link`, Staff/bot `POST .../payments/:id/create-stripe-link`, Sunset schedule create | Create or reuse checkout session for booking balance or draft payment row |
| `getPaymentStatus` | Sunset `GET .../payment-link`, internal reads | Authoritative actionable URL + lifecycle for a booking |
| `cancelOrInvalidatePaymentLink` | Staff `POST .../cancel-payment-link`, Sunset delete-link | Cancel unpaid link row + invalidate booking metadata fallback |

### Lifecycle states (`PAYMENT_LINK_LIFECYCLE`)

| State | Meaning | Actionable URL? |
|-------|---------|-----------------|
| `no_payment_due` | Booking balance ≤ 0 | No |
| `draft` | Payment row exists; Stripe session not yet created | No (until checkout_created) |
| `checkout_created` | Unpaid checkout session on payment row | Yes |
| `paid` | Payment row or booking paid truth | No |
| `cancelled` | Payment row cancelled locally | No |
| `invalidated` | Booking metadata link neutralized (`payment_link_invalidated`) | No |
| `booking_cancelled` | Booking status cancelled/expired | No |
| `not_found` | No active unpaid payment row | No |

### Invariants

- Browser/model **cannot** supply trusted `amount_due_cents`, `currency`, or balance fields — rejected at command build.
- **Booking total / ledger balance** is authoritative for balance links; draft rows use persisted `payments.amount_due_cents`.
- **Paid bookings** cannot receive a replacement link (existing paid rows skipped; create fails closed on non-draft rows).
- **Duplicate create** with same idempotency key or compatible active link returns existing URL (`idempotent: true`).
- **Cancelled bookings** never return an actionable URL — metadata `last_payment_link_url` is ignored when invalidated.
- **Cancellation** sets payment row `cancelled`, clears `checkout_url`, patches booking metadata (`payment_link_invalidated`, `last_payment_link_url: null`; Sunset also `sunset_stripe_link_stale`).
- Stripe sessions **cannot be deleted remotely** — stale `cs_test_*` / `cs_live_*` sessions are treated as invalid locally once cancelled.
- **Tenant/location** and Stripe account come from trusted runtime config (`trustedClientSlug`, env secret key) — never caller-selected.
- **Test/live modes cannot cross** — `assertStripeRuntime` rejects mode/key mismatches; live keys blocked on staging tenants.
- **Stripe failure** on balance-link create deletes draft payment row (no partial local state).

### Cancellation semantics

1. Unpaid `checkout_created` / `draft` row → status `cancelled`, `checkout_url` cleared, metadata records cancel audit fields.
2. Booking metadata patched to prevent metadata-only URL fallback on subsequent reads.
3. Idempotent re-cancel returns success without mutation.
4. Paid rows reject cancel (`payment_already_paid`).

### Route delegation (Slice 10)

| Route | Service op | Retained in route |
|-------|------------|-------------------|
| `POST /staff/bookings/generate-payment-link` | `createPaymentLink` (balance) | Feature flags, ledger preflight, audit log, HTTP response envelope |
| `POST /staff/bookings/cancel-payment-link` | `cancelOrInvalidatePaymentLink` | Audit log, HTTP envelope |
| `POST /staff/payments/:id/create-stripe-link` | `createPaymentLink` (draft) | Guest short-link observability fields |
| `POST /staff/bot/payments/:id/create-stripe-link` | `createPaymentLink` (draft, Luna channel) | Bot response fields (`guest_payment_url`, `next_action`) |
| Sunset schedule GET/CREATE payment link | `getPaymentStatus` / `createSunsetScheduleStripeLink` via service | Guest payment URL attachment |

**Out of scope (unchanged):** service-records addon payment links, refunds, portal UI, room moves, waivers.

---

## 16. Schedule portal module (Slice 11)

Browser Schedule drawer data layer extracted to `scripts/browser/sunset-schedule-portal-module.js` (injected at portal runtime via `scripts/lib/sunset-schedule-browser-source.js`).

### Canonical browser API calls

| Operation | HTTP | Browser function |
|-----------|------|------------------|
| Catalog | `GET/POST /staff/schedule/bookings/catalog` | `schedulePortalFetchCatalog` |
| Quote | `POST /staff/schedule/bookings/quote` | `schedulePortalFetchQuote` |
| Create | `POST /staff/schedule/bookings` | `schedulePortalSubmitCreate` (includes `quote_provenance`) |
| Drawer detail | `GET /staff/schedule/bookings/detail` | `schedulePortalFetchDrawerDetail` |
| Payment status | `GET /staff/schedule/bookings/payment-link` | `schedulePortalFetchPaymentLink` |

### Browser must not decide

Offering identity, schedule weekday eligibility, price, billing units, totals, or payment lifecycle — all from server quote/catalog/detail/payment-link responses.

### Drawer access

`scheduleDrawerCanLoadCanonical` — trusted persisted `staff_manual` or `luna_guest` rows with `booking_id`/`booking_code`. Demo/unknown sources use legacy read-only inline drawer or 403 on detail API (`bundleHasTrustedScheduleDrawerAttribution`).

### Compatibility wrappers (documented)

- `scheduleCoursesFromConfig` — used only when canonical catalog POST fails (offline/degraded).
- `scheduleCourseEligibleOnDates` — retained for legacy schedule board helpers; create flow uses catalog `eligible_on_requested_dates`.

---

## 17. Schedule drawer view UI (Slice 12)

Read-only Schedule booking drawer presentation extracted to `scripts/browser/sunset-schedule-drawer-view-ui.js` (injected via `scripts/lib/sunset-schedule-browser-source.js` immediately after the portal module).

### View module owns

Booking header/status shell, guest details, offering/course/tier labels, dates/participants, service line rows, authoritative totals display, payment state + actionable link display, attribution labels, loading/empty/typed-error states.

### View module must not

Fetch data, calculate prices, reinterpret schedules, decide payment validity, or encode tenant-specific business rules. It consumes canonical drawer-detail `ctx` from Slice 11 fetch layer only.

### Compatibility wrapper (edit path)

`scheduleRenderDrawerPaymentSectionHtml(ctx, editable)` remains in `staff-query-api.js` — delegates to view or edit injected modules.

### Staff + Luna parity

Both sources render through `scheduleRenderViewDrawerHtml` / `scheduleRenderSunsetViewDrawerHtml` with the same canonical fields; untrusted sources fail closed server-side (`drawer_untrusted_booking_source`).

**Render helpers** for drawer read-only view live in `scripts/browser/sunset-schedule-drawer-view-ui.js` (Slice 12). Payment stripe section uses `schedulePortalStripeLinkFromCtx` for non-actionable invalidated links.

---

## 18. Schedule drawer edit UI (Slice 13)

Edit-mode Schedule booking drawer controller extracted to `scripts/browser/sunset-schedule-drawer-edit-ui.js` (injected after portal + view modules).

### Edit module owns

Edit form rendering, enter/cancel/save lifecycle, payload read + client-side validation, PATCH orchestration with refetch, payment-status select in edit mode, course/tier/component field helpers.

### Edit module must not

Duplicate fetch contracts, calculate authoritative prices, reinterpret eligibility, or invent payment balances. Successful save refetches canonical drawer detail before returning to Slice 12 view renderer.

### Compatibility hooks (monolith)

`scheduleWireViewDrawer`, conversation/customer wiring — orchestration unchanged. Payment/waiver/delete mutations live in the drawer-actions module.

---

## 19. Schedule drawer mutation actions (Slice 25)

Stripe-link, manual payment, waiver, and booking-delete mutation controllers consolidated into `scripts/browser/sunset-schedule-drawer-actions.js` (injected after portal, view and edit; before controller). One closure owns in-flight guards and a shared authenticated JSON request helper (`SunsetScheduleDrawerActions`). Compatibility `schedule*` wrappers are exported for view/edit/controller — not attached to `window`.

### Actions module owns

- Payment section router / Stripe link section / manual payment form rendering helpers used by view/edit
- Stripe-link create/delete, manual-payment submit, waiver load/create/copy/answers, booking delete
- Duplicate-click in-flight guards, stale drawer generation (`openGen` / `activeBookingKey`) protection
- Shared `requestJson` helper; tenant/location from `getClient()` + `sunsetLocationQuerySuffix()` only
- Canonical detail / waiver refetch after successful mutations; delete closes drawer then refreshes (cannot reopen removed row)

### Actions module must not

Calculate authoritative balances, infer Stripe/waiver status from URL presence alone, accept booking identity or tenant/location from DOM inputs, send WhatsApp, or own drawer open/close/edit form / Schedule board rendering.

### Compatibility hooks

View/edit call payment renderers and `scheduleLoadDrawerWaiver` / wire hooks after injection. Controller wires stripe/manual/waiver/delete at mount. `scheduleCopyTextFallback` remains shared outside this module. Waiver section shell (`scheduleRenderDrawerWaiverSectionHtml`) remains in view module.

---

## 20. Schedule drawer orchestration controller (Slice 16)

Drawer open/close/refresh lifecycle extracted to `scripts/browser/sunset-schedule-drawer-controller.js` (injected after portal, view, edit and drawer-actions).

### Controller module owns

`scheduleDrawerState`, `openScheduleDetailDrawer`, `closeScheduleDetailDrawer`, `scheduleRefreshDrawer`, `scheduleMountDrawerBody`, `scheduleOpenEditableDrawer`, `scheduleWireViewDrawer`, header/conversation/customer wiring hooks, stale-response protection (`openGen` / `refreshGen` / `activeBookingKey`), and legacy read-only fallback for untrusted non-canonical rows.

### Controller module must not

Own edit form logic, payment/waiver/delete mutations, Schedule board rendering, or client-side price/balance/eligibility calculation.

### Compatibility hooks (monolith)

Schedule chip click handlers call `openScheduleDetailDrawer(row)` via IIFE closure. `scheduleCopyTextFallback` and `scheduleDrawerFlashCopied` remain in monolith.


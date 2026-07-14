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

**Module owner:** `scripts/lib/sunset-luna-admin-catalog.js` — `quoteSunsetOfferingFromCatalog`.

**HTTP:** `POST /staff/bot/sunset/offering-quote` (`handleBotSunsetOfferingQuote`).

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

1. **Stale checkout URL after cancel:** Cancelled Luna probe bookings may still expose `cs_test_*` URL via `GET /staff/schedule/bookings/payment-link` while `payments` row is neutralized (`payment_id: null` in API). Payment truth: `paid=false`.  
2. **Schedule drawer read:** `GET .../bookings/detail` returns 403 for Luna-attributed bookings (`drawer_edits_limited_to_staff_manual_schedule`) — staff UI cannot inspect Luna writes via drawer; bot/status endpoints still work.  
3. **Dual price paths:** Read-only catalog can fall back to config JSON amounts; **writes require DB** when `SUNSET_ADMIN_DB_READ_ENABLED`.  
4. **Group lesson slots:** Legacy `lesson_slot_*` identities exist in code but Luna catalog policy returns **courses + private only** (`group_lessons: []`).  
5. **Wolfhouse bot token vs Sunset:** Staging KV `luna-bot-internal-token` may differ from `hermes-sunset-luna` container token — Sunset bot routes require the Sunset deployment token.  
6. **Accommodation vertical:** Wolfhouse booking fields explicitly rejected on Sunset bot create — shared platform contract for accommodation not yet unified in this doc.

---

## 12. Module map (implementation)

| Concern | Module |
|---------|--------|
| Offering projection | `scripts/lib/sunset-bookable-offerings.js` |
| Schedule rules | `scripts/lib/sunset-offering-schedule.js` |
| Catalog + quote | `scripts/lib/sunset-luna-admin-catalog.js` |
| Course join / capacity | `scripts/lib/sunset-admin-course-join.js` |
| Price resolve | `scripts/lib/sunset-admin-price-resolve.js`, `sunset-course-lesson-price-lookup.js` |
| Booking writes | `scripts/lib/sunset-schedule-booking-writes.js` |
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

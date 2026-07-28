# Surf-School Template — Tenant-Coupling Inventory

Companion to `docs/SURF-SCHOOL-TEMPLATE-PLAN.md`. Generated 2026-07-28 on branch
`feat/surf-school-template` by a read-only sweep of every `scripts/lib` file referencing
`sunset`, plus `scripts/staff-query-api.js` and `scripts/browser/sunset-admin-ui.js`.

Scope note: `grep -rl sunset scripts/lib` returns ~162 files, but most are infra/evidence
noise (radar, phase-d DB plumbing, messi/factory scaffolding, IaC/observer/crowsnest). The
genuine runtime-coupling set is ~55 files, classified below. Categories: TENANT_GUARD,
ENUM_LIST, DISPLAY_STRING, ITEM_CODE_CONVENTION, RENTAL_LITERAL, LUNA_RUNTIME, LOCATION_MODEL.

## Design-sensitive hubs — fix these first (everything keys off them)

1. **`scripts/lib/luna-front-desk-vertical-scope.js`** — THE LINCHPIN. `VERTICAL_TENANT` map
   hardcodes `SURF_SCHOOL: 'sunset'`, `ACCOMMODATION: 'wolfhouse-somo'`. Must become a lookup
   over enabled clients, not a 1:1 map. Phase 1 starts here.
2. **`scripts/lib/sunset-school-locations.js`** — the location model (`sunset-somo`/
   `sunset-sardinero` + display names + SQL location-match builders). Sunset-shaped; needs the
   multi-location-per-client schema decision. ~15 importers.
3. **`scripts/lib/sunset-bookable-offerings.js`** — root export of `SUNSET_CLIENT_SLUG` +
   rental-literal / `offering__duration` logic; ~15 importers.
4. **`scripts/lib/tenant-business-config.js`** — meant to be the per-client resolver but still
   `slug === 'sunset'`-gated in ~7 spots (lines 288, 386, 587, 697, 949, 999, 1038).
5. **`scripts/staff-query-api.js`** — 19 raw `'sunset'` string gates that should collapse into
   the existing `is_surf_vertical` profile flag (already 33 uses). Complicated by the giant
   single-template-literal structure (see MEMORY: staff-ui-template-literal-escaping).
6. **item_code / enum contract** — `sunset-admin-price-identity.js`, `sunset-admin-duration-keys.js`,
   `tenant-admin-writes.js`, `sunset-admin-pack-rules.js` (`PACK_BEACHES`/`PACK_AGE_BANDS`/
   `group_size:16`). These enums are **DUPLICATED** into `scripts/browser/sunset-admin-ui.js`, so
   the schema decision and the UI must move together. (Phase 0 `surf-school-config.js` now owns
   the canonical values.)
7. **`scripts/lib/verticals/surf-school-vertical-adapter.js`** + `luna-front-desk-catalog-service.js`
   / `-quote-service.js` / `-booking-create-service.js` — right abstraction, but
   `SUNSET_CLIENT_SLUG` is threaded through every command.

## Safe MECHANICAL sweeps (delegate to Skipper / cheap subagents)

- **Cluster 1 — `SunsetXxx`→generic rename + slug param-threading:** `sunset-waiver-*` (6),
  `sunset-finance-*` (2), `sunset-schedule-{drawer,queries,ops,browser-source}`,
  `sunset-catalog-response-preview`, `sunset-luna-admin-catalog`, `sunset-private-lesson-luna-catalog`,
  `sunset-group-lesson-quote`, `sunset-customer-profile-writes`, `sunset-course-display-label`,
  `sunset-guest-date-intake`.
- **Cluster 2 — Luna guest-runtime plumbing:** `luna-guest-*` executors/planners/orchestrator/
  handoff/addon-attach — thread the resolved slug instead of the constant.
- **Cluster 3 — Channel/i18n/config wiring:** `sunset-inbox-channel-config`,
  `sunset-hermes-tenant-router`, `staff-portal-i18n*`, `luna-hermes-whatsapp-thread-mirror`.
- **Cluster 4 — Admin browser-source generators:** `sunset-admin-browser-source`,
  `sunset-admin-ui-helpers`, `sunset-admin-helper-extract`, `sunset-admin-verify-ui-html` — move in
  lockstep with the (design-sensitive) `sunset-admin-ui.js` enum decision.

## Key enablers already present (reduce risk)

- `is_surf_vertical` portal-profile flag already exists — the intended replacement for raw
  `=== 'sunset'` gates.
- `staff-portal-clients.js` already loads per-slug baselines (Phase 0 resolver builds on it).
- `config/clients/` already has `surf-school.sample.json`, `surf-shop-rental.sample.json`,
  `lawave.baseline.json`, `mirleft.baseline.json` — per-client direction is scaffolded, just not
  wired through the sunset-gated runtime.

## Note

`sunset-stripe-payment-links.js` is a runtime file (RENTAL_LITERAL + ITEM_CODE + TENANT_GUARD,
mechanical) despite sitting near fortress deploy tooling — keep it in scope.

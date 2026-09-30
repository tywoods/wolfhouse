# Configurable package minimum — CORE handoff

## Scope and implementation

Owned production files:
- `scripts/lib/wolfhouse-package-night-rules.js`
- `scripts/lib/wolfhouse-accommodation-application.js`
- `scripts/lib/wolfhouse-quote-calculator.js`
- `scripts/lib/booking-guests.js`
- `scripts/lib/bot-booking-package-normalize.js`

New verifier: `scripts/verify-package-minimum-core.js`.

No commits, deployments, external requests, guest writes, or payment execution.
Other workers' files were not edited. `core.patch` contains only owned production changes.

The shared night-rule owner validates positive safe-integer `config.package_min_nights` and exposes eligibility. Omitted config loads the JSON seed for legacy callers; a supplied invalid/missing minimum (including explicit null config) does not fall back to a policy number. All named package selections are minimum-checked, including arbitrary catalog additions and minority guest selections. Catalog existence remains the calculator's responsibility. Explicit no-package aliases and mixed guest selections survive normalization; missing choice remains distinct from explicit accommodation. No explicit named package becomes `package_none` for a short stay.

Previews enumerate the effective catalog instead of the three legacy names. Every preview reports `package_min_nights` (integer or null) and `package_eligible` (boolean); ineligible previews contain no successful package entries. Invalid-minimum catalogs expose accommodation only. Application checks forward config and inspect every guest selection. Weekly price arithmetic and existing deposit tier arithmetic were not changed.

## Integration signatures

- `getPackageMinimumNights(config?) -> integer | null`
- `evaluatePackageEligibility(nights, config?) -> {package_min_nights, package_eligible}`
- `validateStaffPackageNightRule(checkIn, checkOut, packageCode, config?)`
- `evaluatePackageNightContext(fields, {config, guest_directly_named_package}?)`
- `calculateWolfhouseQuote(input, config?)`
- `computePackagePricePreview(input, config?)`
- `buildWolfhouseAccommodationCatalog(config?)`
- `executeWolfhouseAccommodationListOfferings(body, {config}?)`
- `executeWolfhouseAccommodationQuote(body, {config}?)`
- `evaluateWolfhouseAccommodationDates(fields, {config}?)`
- `resolveBotBookingPackageContext({packageCode, guestPackages, checkIn, checkOut, guestCount, config})`
- `buildWeeklyPackageBlockedReply(lang, packageCode, config?)`
- `buildShortStayAccommodationGuidanceReply(lang, config?)`

Minimum violations use `package_min_nights_violation`; invalid policy uses `package_min_nights_configuration_invalid`. Quote failures return zero totals/no line items and retain the requested package code; successful quotes also expose minimum/eligibility metadata.

## TDD evidence

`01`–`10` logs record five successive RED/GREEN cycles: shared rules, pricing/preview, application/normalization, null-config/localized-copy hardening, and missing-choice compatibility. The final `verify-package-minimum-core.log` reports **11 registered tests; 0 failures**. Cases cover minima 4 and 10, below/equal/above boundaries, Rincon plus the full seed catalog, invalid values, explicit accommodation aliases, minority mixed selection, unchanged weekly arithmetic, unchanged deposit tiers, and localized policy copy.

`node --check` passed all six owned/new JS files. `git diff --check` passed.

## Existing regression results and precise conflicts

See `regression-results.json` and individual logs for actual execution.

Passed on the final sweep:
- `verify-staff-admin-packages-quote`
- `verify-per-guest-booking-payments`
- `verify-luna-front-desk-accommodation-availability-service`
- `verify-guest-addon-pricing`
- `verify-guest-room-type-supplement`
- `verify-per-person-gear-room-pref`

Unmodified tests needing parent integration/fixture attention:
1. `verify-short-stay-booking-create`: only C3a/C3c fail. Its legacy wrapper `scripts/lib/luna-guest-booking-dry-run.js:286` passes `fields.quote_config || null` even when no configuration was supplied. Explicit null now fails closed instead of silently loading the seed; for accommodation the observed caught error is `config.seasons is not iterable`. Parent should forward effective request config and preserve undefined for an intentionally seed-backed legacy invocation. Also pass effective config into that wrapper's normalization call at lines 245–251. A4/E2 (missing-choice compatibility) were restored in the owned normalizer and now pass.
2. `verify-luna-front-desk-accommodation-adapter`: passed earlier, but the final shared-worktree sweep fails catalog parity and Malibu presence, then accesses a missing package entry. The parent's newly wired adapter calls `loadBookingQuoteConfigWithOverlay(null)` in an old test that supplies neither pg nor effective config. That is now an invalid-policy result, not the seed catalog expected by this old test. Its date-evaluation legacy fixture also omits request config. Supply explicit seeded effective config for the offline parity fixture, or decide the intended legacy adapter default; do not weaken package fail-closed behavior.
3. `verify-invoice-pebbles-perguest-deposit`: stops at line 87, expecting a 5-night Malibu quote to carry an admin short deposit. The seed minimum is now 7, so this package quote is correctly blocked with deposit 0. Keep deposit testing independent by explicitly configuring a minimum permitting that fixture or by selecting accommodation-only. Browser phase was not reached.

No existing verifier assertions were rewritten by this worker.

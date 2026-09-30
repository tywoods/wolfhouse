'use strict';

// Local-only regression verifier. No DB, HTTP, booking writes, or payment flows.
const assert = require('node:assert/strict');
const { loadConfig, calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
const rules = require('./lib/wolfhouse-package-night-rules');
const { computePackagePricePreview } = require('./lib/booking-guests');
const app = require('./lib/wolfhouse-accommodation-application');
const { resolveBotBookingPackageContext } = require('./lib/bot-booking-package-normalize');
const tests = [];
function test(name, run) { tests.push({ name, run }); }
function config(minimum) {
  const cfg = loadConfig();
  cfg.package_min_nights = minimum;
  cfg.packages.push({ ...structuredClone(cfg.packages.find(p => p.code === 'uluwatu')), code: 'rincon', name: 'Rincon' });
  return cfg;
}
function stay(nights, code = 'rincon') {
  return { client_slug: 'wolfhouse-somo', check_in: '2026-07-01', check_out: `2026-07-${String(nights + 1).padStart(2, '0')}`, guest_count: 1, package_code: code, room_type: 'shared' };
}

test('rules: configurable lower/higher boundary and arbitrary catalog package', () => {
  for (const minimum of [4, 10]) {
    const cfg = config(minimum);
    for (const nights of [minimum - 1, minimum, minimum + 1]) {
      const input = stay(nights);
      const expected = nights >= minimum;
      const result = rules.validateStaffPackageNightRule(input.check_in, input.check_out, input.package_code, cfg);
      assert.equal(result.ok, expected, `staff minimum=${minimum} nights=${nights}`);
      assert.equal(result.package_min_nights, minimum);
      assert.equal(result.package_eligible, expected);
      const context = rules.evaluatePackageNightContext({ ...input, package_interest: input.package_code }, { config: cfg });
      assert.equal(context.blocks_weekly_package_quote, !expected);
      assert.equal(context.ready_for_package_quote, expected);
      assert.equal(context.package_code, 'rincon');
      assert.equal(context.package_min_nights, minimum);
    }
  }
});

test('rules: missing/invalid config fails closed but explicit accommodation remains allowed', () => {
  for (const value of [undefined, null, 0, -1, 2.5, '4', NaN, Infinity, true]) {
    const cfg = config(value);
    if (value === undefined) delete cfg.package_min_nights;
    const input = stay(11);
    const result = rules.validateStaffPackageNightRule(input.check_in, input.check_out, 'rincon', cfg);
    assert.equal(result.ok, false, `invalid ${String(value)}`);
    assert.equal(result.package_min_nights, null);
    assert.equal(result.reason_code, 'package_min_nights_configuration_invalid');
    const context = rules.evaluatePackageNightContext({ ...input, package_interest: 'rincon' }, { config: cfg });
    assert.equal(context.blocks_weekly_package_quote, true);
    for (const code of ['package_none', 'no_package', 'accommodation_only', 'accommodation-only', 'custom', 'manual_override']) {
      assert.equal(rules.validateStaffPackageNightRule(input.check_in, input.check_out, code, cfg).ok, true);
    }
  }
  for (const minimum of [4, 10]) {
    for (const code of ['package_none', 'no_package', 'accommodation_only']) {
      const input = stay(minimum + 1, code);
      const context = rules.evaluatePackageNightContext({ ...input, package_interest: code }, { config: config(minimum) });
      assert.equal(context.ready_for_package_quote, true, `explicit ${code} must not prompt for package`);
      assert.equal(context.needs_package_explanation, false);
    }
  }
});

test('pricing: preview and direct quote enforce configured boundaries for every catalog package', () => {
  for (const minimum of [4, 10]) {
    const cfg = config(minimum);
    for (const nights of [minimum - 1, minimum, minimum + 1]) {
      const input = stay(nights);
      const expected = nights >= minimum;
      const preview = computePackagePricePreview(input, cfg);
      assert.equal(preview.package_min_nights, minimum);
      assert.equal(preview.package_eligible, expected);
      assert.equal(preview.success, expected);
      assert.equal(preview.nights, nights);
      for (const pkg of cfg.packages.filter(p => !p.code.startsWith('_'))) {
        const quote = calculateWolfhouseQuote({ ...input, package_code: pkg.code }, cfg);
        assert.equal(quote.success, expected, `${pkg.code}: min=${minimum}, nights=${nights}`);
        assert.equal(quote.package_min_nights, minimum);
        assert.equal(quote.package_eligible, expected);
        if (expected) assert.equal(preview.packages[pkg.code].success, true);
        else {
          assert.equal(quote.total_cents, 0);
          assert.equal(quote.reason_code, 'package_min_nights_violation');
        }
      }
      if (!expected) assert.equal(Object.values(preview.packages).some(p => p.success), false);
    }
  }
});

test('pricing: invalid minimum blocks packages, not accommodation; mixed choices preserved', () => {
  for (const value of [undefined, null, 0, -2, 1.5, '4', true]) {
    const cfg = config(value);
    if (value === undefined) delete cfg.package_min_nights;
    const input = stay(11);
    const preview = computePackagePricePreview(input, cfg);
    assert.equal(preview.package_min_nights, null);
    assert.equal(preview.package_eligible, false);
    assert.equal(Object.values(preview.packages).some(p => p.success), false);
    const quote = calculateWolfhouseQuote(input, cfg);
    assert.equal(quote.success, false);
    assert.equal(quote.missing_config, true);
    for (const code of ['package_none', 'no_package', 'accommodation_only', 'accommodation-only']) {
      assert.equal(calculateWolfhouseQuote({ ...input, package_code: code }, cfg).success, true, code);
    }
  }
  const guest_packages = [{ guest_number: 1, package_code: 'package_none' }, { guest_number: 2, package_code: 'rincon' }];
  const snapshot = structuredClone(guest_packages);
  for (const minimum of [4, 10]) {
    for (const nights of [minimum - 1, minimum]) {
      const quote = calculateWolfhouseQuote({ ...stay(nights, 'package_none'), guest_count: 2, guest_packages }, config(minimum));
      assert.equal(quote.success, nights >= minimum);
      if (quote.success) assert.deepEqual(quote.guest_packages, snapshot);
    }
  }
  assert.deepEqual(guest_packages, snapshot);
});

test('pricing: eligibility never changes weekly arithmetic or deposit tiers', () => {
  const lower = config(4);
  for (const nights of [4, 5, 6, 7, 10, 11]) {
    const quote = calculateWolfhouseQuote(stay(nights), lower);
    assert.equal(quote.success, true);
    const weekly = lower.packages.find(p => p.code === 'rincon').seasonal_prices[quote.season_code].weekly_per_person_cents;
    assert.equal(quote.total_cents, nights === 7 ? weekly : Math.ceil(weekly / 7 / 500) * 500 * nights);
    const accommodation = calculateWolfhouseQuote(stay(nights, 'package_none'), lower);
    assert.equal(quote.deposit_required_cents, accommodation.deposit_required_cents);
    const changed = calculateWolfhouseQuote(stay(nights), config(nights));
    assert.equal(changed.total_cents, quote.total_cents);
    assert.equal(changed.deposit_required_cents, quote.deposit_required_cents);
  }
});

test('application: config reaches catalog, dates, preview, quote and normalization', () => {
  for (const minimum of [4, 10]) {
    const cfg = config(minimum);
    const catalog = app.buildWolfhouseAccommodationCatalog(cfg);
    assert.equal(catalog.offerings.find(p => p.package_code === 'rincon').min_nights, minimum);
    assert.equal(catalog.offerings.find(p => p.package_code === 'accommodation_only').min_nights, 1);
    for (const nights of [minimum - 1, minimum, minimum + 1]) {
      const input = stay(nights);
      const expected = nights >= minimum;
      const context = resolveBotBookingPackageContext({ packageCode: 'rincon', checkIn: input.check_in, checkOut: input.check_out, guestCount: 1, config: cfg });
      assert.equal(context.quotePackageCode, 'rincon');
      assert.equal(context.storagePackageCode, 'rincon');
      assert.equal(context.isShortStay, !expected);
      assert.deepEqual(context.guestPackagesForQuote, []);
      const dates = app.evaluateWolfhouseAccommodationDates(input, { config: cfg });
      assert.equal(dates.ok, expected, `dates min=${minimum} nights=${nights}`);
      assert.equal(dates.package_min_nights, minimum);
      assert.equal(dates.package_eligible, expected);
      const preview = app.executeWolfhouseAccommodationListOfferings(input, { config: cfg }).body;
      assert.equal(preview.package_min_nights, minimum);
      assert.equal(preview.package_eligible, expected);
      assert.equal(Object.values(preview.packages).some(p => p.success), expected);
      const result = app.executeWolfhouseAccommodationQuote(input, { config: cfg });
      assert.equal(result.ok, expected, `quote min=${minimum} nights=${nights}`);
      if (expected) assert.equal(result.body.quote.package_code, 'rincon');
      else assert.equal(result.body.reason_code, 'package_min_nights_violation');
    }
  }
});

test('application: preserve explicit no-package and mixed guest selections without majority bypass', () => {
  for (const minimum of [4, 10]) {
    const cfg = config(minimum);
    for (const nights of [minimum - 1, minimum + 1]) {
      for (const code of ['package_none', 'no_package', 'accommodation_only']) {
        const result = app.executeWolfhouseAccommodationQuote(stay(nights, code), { config: cfg });
        assert.equal(result.ok, true, `${code} nights=${nights}`);
        assert.equal(result.body.quote.package_code, 'package_none');
      }
      const guest_packages = [{ guest_number: 1, package_code: 'package_none' }, { guest_number: 2, package_code: 'package_none' }, { guest_number: 3, package_code: 'rincon' }];
      const input = { ...stay(nights, 'package_none'), guest_count: 3, guest_packages };
      const result = app.executeWolfhouseAccommodationQuote(input, { config: cfg });
      assert.equal(result.ok, nights >= minimum);
      assert.equal(result.body.success, nights >= minimum);
      if (result.ok) assert.deepEqual(result.body.quote.guest_packages, guest_packages);
      else assert.equal(result.body.reason_code, 'package_min_nights_violation');
    }
  }
});

test('application: invalid config exposes no eligible catalog offering or quote', () => {
  const cfg = config(undefined);
  delete cfg.package_min_nights;
  assert.equal(app.buildWolfhouseAccommodationCatalog(cfg).offerings.some(p => p.offering_kind === 'stay_package'), false);
  const result = app.executeWolfhouseAccommodationQuote(stay(11), { config: cfg });
  assert.equal(result.ok, false);
  assert.equal(result.body.reason_code, 'package_min_nights_configuration_invalid');
});

test('hardening: explicit null config never loads seed and mixed date checks never use majority', () => {
  assert.equal(computePackagePricePreview(stay(11), null).package_eligible, false);
  assert.equal(calculateWolfhouseQuote(stay(11), null).success, false);
  assert.equal(app.buildWolfhouseAccommodationCatalog(null).offerings.some(p => p.offering_kind === 'stay_package'), false);
  const guest_packages = [{ guest_number: 1, package_code: 'package_none' }, { guest_number: 2, package_code: 'rincon' }];
  const result = app.evaluateWolfhouseAccommodationDates({ ...stay(9, 'package_none'), guest_count: 2, guest_packages }, { config: config(10) });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'package_min_nights_violation');
});

test('hardening: localized blocked replies use configured minimum, never numeric fallback', () => {
  for (const language of ['en', 'it', 'es', 'de', 'fr']) {
    for (const minimum of [4, 10]) {
      const blocked = rules.buildWeeklyPackageBlockedReply(language, 'rincon', config(minimum));
      const guidance = rules.buildShortStayAccommodationGuidanceReply(language, config(minimum));
      assert.match(blocked, new RegExp(`\\b${minimum}\\b`));
      assert.match(guidance, new RegExp(`\\b${minimum}\\b`));
      assert.doesNotMatch(blocked + guidance, /\b7\b/);
    }
    assert.doesNotMatch(rules.buildWeeklyPackageBlockedReply(language, 'rincon', {}), /\d/);
    assert.doesNotMatch(rules.buildShortStayAccommodationGuidanceReply(language, {}), /\d/);
  }
});

test('normalization: missing choice is distinct from explicit accommodation', () => {
  const cfg = config(10);
  const short = stay(9);
  const eligible = stay(10);
  const context = input => resolveBotBookingPackageContext({ checkIn: input.check_in, checkOut: input.check_out, guestCount: 2, packageCode: null, config: cfg });
  assert.equal(context(eligible).quotePackageCode, null);
  assert.equal(context(short).quotePackageCode, 'package_none');
  assert.deepEqual(context(short).guestPackagesForQuote, [{ guest_number: 1, package_code: 'package_none' }, { guest_number: 2, package_code: 'package_none' }]);
});

let failures = 0;
for (const { name, run } of tests) {
  if (process.argv[2] && !name.startsWith(process.argv[2])) continue;
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
}
console.log(`${tests.length} registered tests; ${failures} failures`);
process.exitCode = failures ? 1 : 0;

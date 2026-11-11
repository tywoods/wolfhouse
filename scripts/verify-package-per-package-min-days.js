'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
const { applyOverlayPackageItemsToConfig } = require('./lib/wolfhouse-pricing-resolve');
const rules = require('./lib/wolfhouse-package-night-rules');
const { computePackagePricePreview } = require('./lib/booking-guests');

function overlayConfig() {
  const cfg = loadConfig();
  delete cfg.package_min_nights;
  cfg.seasons = [{
    code: 'summer', active: true, bookable: true, priority: 0, sort_order: 1,
    ranges: [{ start_month: 1, start_day: 1, end_month: 12, end_day: 31 }],
  }];
  return applyOverlayPackageItemsToConfig(cfg, [
    { item_type: 'policy', item_code: 'package_min_nights', metadata: { minimum_nights: 7 }, active: true },
    { item_type: 'package', item_code: 'malibu', label: 'Malibu', metadata: { min_days: 1 }, active: true },
    { item_type: 'package', item_code: 'waimea', label: 'Waimea', metadata: {}, active: true },
    { item_type: 'package', item_code: 'uluwatu', label: 'Uluwatu', metadata: { min_days: 7 }, active: true },
  ]);
}

const seed = fs.readFileSync(path.join(__dirname, '..', 'config', 'clients', 'wolfhouse-somo.pricing.json'), 'utf8');
assert.equal(/"package_min_nights"\s*:/.test(seed), false, 'do not seed house-wide package_min_nights');

const extrasUi = fs.readFileSync(path.join(__dirname, 'browser', 'wolfhouse-admin-pricing-ui.js'), 'utf8');
assert.equal(extrasUi.includes('Package Night minimum'), false);
assert.equal(extrasUi.includes('data-wh-package-minimum'), false);
assert.equal(extrasUi.includes('save-package-minimum'), false);

const cfg = overlayConfig();
const malibuPkg = (cfg.packages || []).find((p) => p && p.code === 'malibu');
assert.ok(malibuPkg, 'malibu in overlay catalog');
assert.equal(malibuPkg.min_days, 1);
assert.equal(rules.getPackageMinimumNights({ package_min_nights: 7, packages: [{ code: 'waimea' }] }, 'waimea'), null);

const four = {
  client_slug: 'wolfhouse-somo',
  check_in: '2026-07-01',
  check_out: '2026-07-05',
  guest_count: 1,
  room_type: 'shared',
};

const malibu = rules.validateStaffPackageNightRule(four.check_in, four.check_out, 'malibu', cfg);
assert.equal(malibu.ok, true, JSON.stringify(malibu));
assert.equal(malibu.package_eligible, true);
assert.equal(malibu.package_min_nights, 1);
assert.equal(malibu.nights, 4);

const ctx = rules.evaluatePackageNightContext(
  { ...four, package_interest: 'malibu' },
  { config: cfg, guest_directly_named_package: true },
);
assert.equal(ctx.blocks_weekly_package_quote, false, JSON.stringify(ctx));
assert.equal(ctx.ready_for_package_quote, true);
assert.equal(ctx.package_min_nights, 1);

const noMin = rules.validateStaffPackageNightRule(four.check_in, four.check_out, 'waimea', cfg);
assert.equal(noMin.ok, true, JSON.stringify(noMin));
assert.equal(noMin.package_eligible, true);
assert.equal(noMin.package_min_nights, null);

const blocked = rules.validateStaffPackageNightRule(four.check_in, four.check_out, 'uluwatu', cfg);
assert.equal(blocked.ok, false);
assert.equal(blocked.package_min_nights, 7);

const preview = computePackagePricePreview({ ...four, package_code: 'malibu' }, cfg);
assert.equal(preview.packages.malibu.success, true, JSON.stringify(preview.packages.malibu));
assert.equal(preview.packages.malibu.package_min_nights, 1);
assert.equal(preview.packages.waimea.success, true, JSON.stringify(preview.packages.waimea));
assert.equal(preview.packages.waimea.package_min_nights, null);
assert.equal(preview.packages.uluwatu.success, false);
assert.equal(preview.packages.uluwatu.package_min_nights, 7);

const quote = calculateWolfhouseQuote({ ...four, package_code: 'malibu', payment_choice: 'deposit' }, cfg);
assert.equal(quote.success, true, JSON.stringify({ success: quote.success, blockers: quote.blockers, reason_code: quote.reason_code }));
assert.equal(quote.package_min_nights, 1);

const openQuote = calculateWolfhouseQuote({ ...four, package_code: 'waimea', payment_choice: 'deposit' }, cfg);
assert.equal(openQuote.success, true, JSON.stringify({ success: openQuote.success, blockers: openQuote.blockers }));
assert.equal(openQuote.package_min_nights, null);

const blockedQuote = calculateWolfhouseQuote({ ...four, package_code: 'uluwatu', payment_choice: 'deposit' }, cfg);
assert.equal(blockedQuote.success, false);
assert.equal(blockedQuote.package_min_nights, 7);
assert.equal(blockedQuote.reason_code, 'package_min_nights_violation');

console.log('verify-package-per-package-min-days: PASS');

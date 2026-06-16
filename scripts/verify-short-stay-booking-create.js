'use strict';

/**
 * Short-stay (no-package) booking create gate — unit tests.
 */

const fs = require('fs');
const path = require('path');
const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
const { resolveBotBookingPackageContext } = require('./lib/bot-booking-package-normalize');
const { normalizeQuoteAddOnsForCombo } = require('./lib/guest-addon-pricing');

const staffApiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-short-stay-booking-create.js\n');

section('A. Package context — short stay defaults to package_none');
{
  const ctx = resolveBotBookingPackageContext({
    packageCode: null,
    guestPackages: [],
    checkIn: '2026-07-10',
    checkOut: '2026-07-13',
    guestCount: 2,
  });
  check('A1', ctx.isShortStay === true, '3-night stay is short');
  check('A2', ctx.quotePackageCode === 'package_none', 'defaults to package_none');
  check('A3', ctx.storagePackageCode === null, 'DB storage is null');
  check('A4', ctx.guestPackagesForQuote.length === 2, 'auto guest_packages for quote');
}

section('B. Quote — accommodation-only + €100 deposit');
{
  const quote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-07-10',
    check_out: '2026-07-13',
    guest_count: 1,
    package_code: 'package_none',
    payment_choice: 'deposit',
    add_ons: [],
  });
  check('B1', quote.success === true, 'quote succeeds');
  check('B2', quote.deposit_required_cents === 10000, '€100 short-stay deposit');
  check('B3', quote.total_cents > 0, 'accommodation total > 0');
  check('B4', quote.payment_link_amount_cents === 10000, 'deposit link amount');
}

section('C. Quote — bundled add-ons in total');
{
  const addOns = normalizeQuoteAddOnsForCombo([
    { code: 'wetsuit_rental', days: 2 },
    { code: 'soft_top_rental', days: 2 },
  ]);
  check('C1', addOns.length === 1 && addOns[0].code === 'wetsuit_soft_top_combo', 'combo merge');
  const quote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-07-10',
    check_out: '2026-07-13',
    guest_count: 1,
    package_code: 'package_none',
    payment_choice: 'full',
    add_ons: addOns,
  });
  check('C2', quote.success === true, 'quote with add-ons succeeds');
  check('C3', quote.total_cents > quote.deposit_required_cents, 'total includes add-ons');
  check('C4', quote.payment_link_amount_cents === quote.total_cents, 'full payment includes add-ons');
}

section('D. Bot create handler accepts package_none');
{
  check('D1', /resolveBotBookingPackageContext/.test(staffApiSrc), 'uses package normalize');
  check('D2', /storagePackageCode/.test(staffApiSrc), 'stores null package for no-package');
  check('D3', /buildManualBookingServiceRecordRows/.test(staffApiSrc), 'creates service records on bot create');
  check('D4', !/manual_override not supported/.test(staffApiSrc), 'removed hard block without package_none hint');
  check('D5', /use package_none for accommodation-only/.test(staffApiSrc), 'error mentions package_none');
}

section('E. 7+ nights without package still blocked');
{
  const ctx = resolveBotBookingPackageContext({
    packageCode: null,
    guestPackages: [],
    checkIn: '2026-07-10',
    checkOut: '2026-07-17',
    guestCount: 1,
  });
  check('E1', ctx.isShortStay === false, '7 nights not short stay');
  check('E2', ctx.quotePackageCode === null, 'no package on 7-night without choice');
}

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);

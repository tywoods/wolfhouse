'use strict';

/**
 * Short-stay quote included_items — guest mini-quote line itemization gate.
 */

const { runBookingPreviewDryRun } = require('./lib/luna-guest-booking-dry-run');
const { buildBotQuoteIncludedItems } = require('./lib/bot-quote-included-items');
const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
const { normalizeQuoteAddOnsForCombo } = require('./lib/guest-addon-pricing');
const { resolveBotBookingPackageContext } = require('./lib/bot-booking-package-normalize');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-bot-quote-included-items.js\n');

section('A. package_none + add-ons — included_items itemizes accommodation and add-ons');
{
  const preview = runBookingPreviewDryRun({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-09-01',
    check_out: '2026-09-04',
    guest_count: 1,
    package_code: 'package_none',
    room_type: 'shared',
    guest_name: 'Test Guest',
    payment_choice: 'deposit',
    add_ons: [
      { code: 'soft_top_rental', days: 3 },
      { code: 'wetsuit_rental', days: 3 },
      { code: 'surf_lesson_single', quantity: 1 },
    ],
  });
  const items = preview.included_items;
  check('A1', Array.isArray(items) && items.length >= 4, `included_items has ${items && items.length} lines`);
  const acc = items && items.find((i) => i.code === 'accommodation');
  const board = items && items.find((i) => i.code === 'soft_top_rental');
  const wetsuit = items && items.find((i) => i.code === 'wetsuit_rental' && i.free);
  const lesson = items && items.find((i) => i.code === 'surf_lesson_single');
  check('A2', acc && acc.label === 'Accommodation' && acc.total_cents > 0, 'accommodation line present');
  check('A3', board && board.days === 3 && board.total_cents === 4500, 'soft board 3 days €45');
  check('A4', wetsuit && wetsuit.free === true && wetsuit.total_cents === 0, 'wetsuit total €0');
  check('A5', wetsuit && /free with board/.test(wetsuit.free_note || ''), 'wetsuit free_note set');
  check('A6', lesson && lesson.quantity === 1 && lesson.total_cents === 3500, 'surf lesson €35');
  if (items && preview.quote) {
    const sum = items.reduce((s, i) => s + (Number(i.total_cents) || 0), 0);
    check('A7', sum === preview.quote.total_cents, `line sum €${sum / 100} matches quote total €${preview.quote.total_cents / 100}`);
  }
}

section('B. No add-ons — included_items stays null');
{
  const preview = runBookingPreviewDryRun({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-09-01',
    check_out: '2026-09-04',
    guest_count: 1,
    package_code: 'package_none',
    room_type: 'shared',
    guest_name: 'Test Guest',
    payment_choice: 'deposit',
    add_ons: [],
  });
  check('B1', preview.included_items == null, 'no add-ons → included_items null');
}

section('C. Hard board combo — wetsuit marked free');
{
  const quote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-07-10',
    check_out: '2026-07-13',
    guest_count: 1,
    package_code: 'package_none',
    payment_choice: 'deposit',
    add_ons: normalizeQuoteAddOnsForCombo([
      { code: 'hard_board_rental', days: 2 },
      { code: 'wetsuit_rental', days: 2 },
    ]),
  });
  const pkgCtx = resolveBotBookingPackageContext({
    packageCode: 'package_none',
    guestPackages: [],
    checkIn: '2026-07-10',
    checkOut: '2026-07-13',
    guestCount: 1,
  });
  const items = buildBotQuoteIncludedItems(quote, { isNoPackage: pkgCtx.isNoPackage, hasAddOns: true });
  const hard = items && items.find((i) => i.code === 'hard_board_rental');
  const wetsuit = items && items.find((i) => i.code === 'wetsuit_rental' && i.free);
  check('C1', hard && hard.days === 2 && hard.total_cents === 4000, 'hard board 2 days €40');
  check('C2', wetsuit && wetsuit.free === true, 'combo wetsuit free');
}

section('D. SOUL — short-stay quote step references included_items');
{
  const fs = require('fs');
  const path = require('path');
  const soul = fs.readFileSync(path.join(__dirname, '..', 'docker', 'hermes-staging', 'SOUL.md'), 'utf8');
  check('D1', /included_items/.test(soul), 'SOUL mentions included_items');
  check('D2', /never invent/i.test(soul), 'SOUL forbids inventing lines');
}

console.log(`\n── verify-bot-quote-included-items ${failures ? 'FAILED' : 'PASSED'} (${passes}/${passes + failures}) ──\n`);
process.exit(failures > 0 ? 1 : 0);

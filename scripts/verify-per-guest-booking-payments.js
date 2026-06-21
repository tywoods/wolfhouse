'use strict';

/**
 * Slice A — per-guest booking & payments foundation gate.
 */

const fs = require('fs');
const path = require('path');
const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
const {
  normalizeBookingGuestsInput,
  computePackagePricePreview,
  buildPerPersonBreakdown,
  parseGuestPaymentShortLinkToken,
} = require('./lib/booking-guests');
const {
  parsePaymentShortLinkToken,
  buildPaymentShortLink,
} = require('./lib/luna-payment-short-link');

const staffApiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const botRoutesSrc = fs.readFileSync(path.join(__dirname, 'lib/staff-bot-v2-routes.js'), 'utf8');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-per-guest-booking-payments.js\n');

section('A. normalizeBookingGuestsInput');
{
  const named = normalizeBookingGuestsInput({
    guest_count: 3,
    guest_name: 'Alex',
    guests: [{ name: 'Alex' }, { name: 'Sam' }, { name: 'Jordan' }],
  });
  check('A1', named.ok && named.uses_per_guest_model, 'named guests enable per-guest model');
  check('A2', named.guests.length === 3, 'three guest names');
  check('A3', named.primary_name === 'Alex', 'primary is first guest');

  const legacy = normalizeBookingGuestsInput({ guest_count: 3, guest_name: 'Group Lead' });
  check('A4', legacy.ok && !legacy.uses_per_guest_model, 'legacy group without guests array');
}

section('B. Deposit math — per guest vs whole booking');
{
  const soloLegacy = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-08-01',
    check_out: '2026-08-08',
    guest_count: 1,
    package_code: 'malibu',
    payment_choice: 'deposit',
    uses_per_guest_deposits: false,
  });
  check('B1', soloLegacy.deposit_required_cents === 20000, 'solo legacy €200 deposit');

  const trioPerGuest = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-08-01',
    check_out: '2026-08-08',
    guest_count: 3,
    package_code: 'malibu',
    payment_choice: 'deposit',
    uses_per_guest_deposits: true,
  });
  check('B2', trioPerGuest.deposit_required_cents === 60000, '3 guests × €200 = €600 booking deposit');
  check('B3', trioPerGuest.per_guest_deposits.length === 3, 'three per-guest deposit rows');
  check('B4', trioPerGuest.per_guest_deposits.every((r) => r.deposit_cents === 20000), 'each guest €200');

  const trioLegacy = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-08-01',
    check_out: '2026-08-08',
    guest_count: 3,
    package_code: 'malibu',
    payment_choice: 'deposit',
    uses_per_guest_deposits: false,
  });
  check('B5', trioLegacy.deposit_required_cents === 20000, 'legacy whole-booking still €200 total deposit');

  const shortPerGuest = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-07-10',
    check_out: '2026-07-13',
    guest_count: 2,
    package_code: 'package_none',
    payment_choice: 'deposit',
    uses_per_guest_deposits: true,
  });
  check('B6', shortPerGuest.deposit_required_cents === 20000, '2 short-stay guests × €100');
}

section('C. Mixed packages — per_person breakdown');
{
  const mixed = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-08-01',
    check_out: '2026-08-08',
    guest_count: 2,
    guest_packages: [
      { guest_number: 1, package_code: 'malibu' },
      { guest_number: 2, package_code: 'waimea' },
    ],
    payment_choice: 'deposit',
    uses_per_guest_deposits: true,
  });
  check('C1', mixed.success, 'mixed package quote succeeds');
  check('C2', mixed.per_person && mixed.per_person.length === 2, 'two per_person rows');
  if (mixed.per_person) {
    check('C3', mixed.per_person[0].package_code === 'malibu', 'guest 1 malibu');
    check('C4', mixed.per_person[1].package_code === 'waimea', 'guest 2 waimea');
    check('C5', mixed.per_person[0].subtotal_cents !== mixed.per_person[1].subtotal_cents, 'different shares');
  }
  const enriched = buildPerPersonBreakdown(mixed, {
    guest_names: ['Alex', 'Sam'],
    payment_choice: 'deposit',
  });
  check('C6', enriched[0].guest_name === 'Alex', 'names merged into breakdown');
}

section('D. Package price preview (A5)');
{
  const preview = computePackagePricePreview({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-08-01',
    check_out: '2026-08-08',
    guest_count: 2,
  });
  check('D1', preview.packages.malibu && preview.packages.malibu.success, 'malibu preview');
  check('D2', preview.packages.uluwatu && preview.packages.uluwatu.success, 'uluwatu preview');
  check('D3', preview.packages.waimea && preview.packages.waimea.success, 'waimea preview');
  check('D4', preview.packages.malibu.per_person_cents > 0, 'per-person price present');
  check('D5', preview.packages.malibu.deposit_total_cents === 40000, '2 × €200 deposit total in preview');
}

section('E. Per-guest payment short links');
{
  const parsed = parseGuestPaymentShortLinkToken('MB-WOLFHO-20260801-7AAF07/g2');
  check('E1', parsed.ok && parsed.guest_number === 2, 'guest suffix parsed');
  const token = parsePaymentShortLinkToken('MB-WOLFHO-20260801-7AAF07/g2');
  check('E2', token.ok && token.guest_number === 2, 'short link token includes guest');
  const link = buildPaymentShortLink({
    booking_code: 'MB-WOLFHO-20260801-7AAF07',
    guest_number: 2,
    base_url: 'https://staff-staging.example.com',
  });
  check('E3', link && link.includes('/g2'), 'built URL has guest segment');
}

section('F. Routes & migration wiring');
{
  check('F1', fs.existsSync(path.join(__dirname, '..', 'database', 'migrations', '024_booking_guests.sql')), 'migration 024 exists');
  check('F2', botRoutesSrc.includes('handleBotPackagePricePreview'), 'package preview handler exported');
  check('F3', botRoutesSrc.includes('handleBotGuestPaymentCreateLink'), 'guest payment link handler');
  check('F4', staffApiSrc.includes('/staff/bot/package-price-preview'), 'bot preview route wired');
  check('F5', staffApiSrc.includes('/staff/bot/booking-guests/payment-status'), 'guest status route wired');
  check('F6', staffApiSrc.includes('normalizeBookingGuestsInput'), 'booking create uses guests input');
  check('F7', staffApiSrc.includes('insertBookingGuestsForBooking'), 'booking_guests insert on create');
  check('F8', staffApiSrc.includes('/staff/bookings/generate-guest-payment-link'), 'staff guest link route');
}

console.log(`\n── verify-per-guest-booking-payments ${failures ? 'FAILED' : 'PASSED'} (${passes}/${passes + failures}) ──\n`);
process.exit(failures > 0 ? 1 : 0);

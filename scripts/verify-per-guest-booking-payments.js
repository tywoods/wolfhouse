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
const {
  paymentLinkIntendedAmountCents,
  paymentLedgerIsStaleUnpaidLinkRow,
  paymentLedgerIsPerGuestLinkRow,
} = require('./lib/payment-ledger-stale-links');

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

section('G. Per-guest payment link stale detection');
{
  const guestId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const perGuestDepositLink = {
    payment_kind: 'deposit_only',
    amount_due_cents: 20000,
    booking_guest_id: guestId,
    metadata: {
      source: 'bot_guest_payment_link_slice_a',
      payment_target: 'deposit',
      booking_guest_id: guestId,
    },
  };
  const ledgerCtx = {
    balance_due_cents: 106000,
    deposit_required_cents: 60000,
    guest_amounts_by_id: {
      [guestId]: { deposit_cents: 20000, subtotal_cents: 45000 },
    },
  };
  check('G1', paymentLedgerIsPerGuestLinkRow(perGuestDepositLink), 'per-guest link detected');
  check('G2', paymentLinkIntendedAmountCents(perGuestDepositLink, ledgerCtx) === 20000,
    'deposit link intended = guest €200 not booking €600');
  check('G3', !paymentLedgerIsStaleUnpaidLinkRow(
    perGuestDepositLink,
    (pr) => pr === perGuestDepositLink,
    ledgerCtx,
  ), '€200 guest deposit link not stale when booking balance is €1060');

  const bookingDepositLink = {
    payment_kind: 'deposit_only',
    amount_due_cents: 20000,
    metadata: { source: 'staff_portal' },
  };
  check('G4', paymentLinkIntendedAmountCents(bookingDepositLink, ledgerCtx) === 60000,
    'whole-booking deposit link still uses booking deposit total');
  check('G5', paymentLedgerIsStaleUnpaidLinkRow(
    bookingDepositLink,
    (pr) => pr === bookingDepositLink,
    ledgerCtx,
  ), 'legacy €200 link stale when booking deposit is €600');

  const fullBalanceLink = {
    payment_kind: 'full_amount',
    amount_due_cents: 20000,
    checkout_url: 'https://checkout.stripe.test/x',
    metadata: { source: 'staff_payment_link', phase: '10.6c' },
  };
  check('G6', paymentLinkIntendedAmountCents(fullBalanceLink, ledgerCtx) === 106000,
    'full-balance staff link still tracks current balance due');
}

section('H. Per-guest create path — guest_name + payment_choice');
{
  const { normalizeBotBookingPaymentChoice, mapBotBookingCreateErrorToBlockedReason } = require('./lib/booking-guests');
  const bodyOnlyGuests = normalizeBookingGuestsInput({
    guest_count: 3,
    guests: [{ name: 'Tyler' }, { name: 'Pietro' }, { name: 'Cathy' }],
  });
  check('H1', bodyOnlyGuests.primary_name === 'Tyler', 'primary_name from guests array');
  const perGuestPay = normalizeBotBookingPaymentChoice('per_guest');
  check('H2', perGuestPay.payment_choice === 'deposit' && perGuestPay.per_guest_payment_links, 'per_guest → deposit links');
  check('H3', mapBotBookingCreateErrorToBlockedReason('guest_name is required') === 'guest_name_missing', 'error mapped to blocked_reason');
  check('H4', staffApiSrc.includes('resolveAndMarkConversationNeedsHuman'), 'handoff resolves session phone');
  check('H5', staffApiSrc.includes('guestsNorm.primary_name'), 'create derives guest_name from guests');
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
  check('F9', staffApiSrc.includes('payment-ledger-stale-links'), 'stale-link helper wired in staff API');
}

console.log(`\n── verify-per-guest-booking-payments ${failures ? 'FAILED' : 'PASSED'} (${passes}/${passes + failures}) ──\n`);
process.exit(failures > 0 ? 1 : 0);

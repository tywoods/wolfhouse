'use strict';

/**
 * Per-person gear, breakdown wording, and room-preference branching gate.
 */

const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
const { normalizeQuoteAddOnsForCombo } = require('./lib/guest-addon-pricing');
const { buildBotQuoteIncludedItems } = require('./lib/bot-quote-included-items');
const { buildManualBookingServiceRecordRows } = require('./lib/manual-booking-service-records');
const { formatRentalPeopleDaysLine, pluralUnit } = require('./lib/rental-breakdown-text');
const { formatServiceRecordInvoiceLineText, loadWolfhouseRentalDayRates } = require('./lib/service-record-invoice-line');
const { computeWolfhouseRoomOptionFlags } = require('./lib/wolfhouse-room-options');
const {
  inferRoomPreferenceNeed,
  inferLikelyGuestGender,
  inferGroupCompositionNeed,
  parseGroupCompositionAnswer,
  groupCompositionResolved,
} = require('./lib/luna-booking-intake-policy');
const { inferGroupGearPeopleCount } = require('./lib/luna-booking-addons-policy');

const rates = loadWolfhouseRentalDayRates();

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

function typeLabel(t, meta) {
  if (meta.staff_ui_service_type === 'soft_board') return 'Soft board';
  if (meta.staff_ui_service_type === 'hard_board') return 'Hard board';
  if (t === 'wetsuit') return 'Wetsuit';
  if (t === 'surfboard' && meta.board_variant === 'soft') return 'Soft board';
  return t || '—';
}

console.log('\nverify-per-person-gear-room-pref.js\n');

section('A. Per-person gear — 2 guests default board count');
{
  const addOns = normalizeQuoteAddOnsForCombo([{ code: 'soft_top_rental', days: 3 }], 2);
  check('A1', addOns[0].quantity === 2, 'defaults quantity to guest_count');
  const quote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-09-01',
    check_out: '2026-09-04',
    guest_count: 2,
    package_code: 'package_none',
    payment_choice: 'deposit',
    add_ons: addOns,
  });
  check('A2', quote.success, 'quote succeeds');
  const boardLine = quote.line_items.find((li) => li.code === 'soft_top_rental');
  check('A3', boardLine && boardLine.total_cents === 9000, '2 people × 3 days × €15 = €90');
}

section('B. Explicit smaller gear count');
{
  const addOns = normalizeQuoteAddOnsForCombo([{ code: 'soft_top_rental', days: 3, quantity: 1 }], 2);
  const quote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-09-01',
    check_out: '2026-09-04',
    guest_count: 2,
    package_code: 'package_none',
    payment_choice: 'deposit',
    add_ons: addOns,
  });
  const boardLine = quote.line_items.find((li) => li.code === 'soft_top_rental');
  check('B1', boardLine && boardLine.total_cents === 4500, '1 board for 3 days = €45');
}

section('C. Combo per-person (2 guests)');
{
  const addOns = normalizeQuoteAddOnsForCombo([{ code: 'wetsuit_soft_top_combo', days: 3 }], 2);
  const quote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-09-01',
    check_out: '2026-09-04',
    guest_count: 2,
    package_code: 'package_none',
    payment_choice: 'deposit',
    add_ons: addOns,
  });
  const rows = buildManualBookingServiceRecordRows({
    addOns,
    quote,
    clientSlug: 'wolfhouse-somo',
    bookingId: '00000000-0000-0000-0000-000000000002',
    bookingCode: 'MB-TEST-COMBO',
    guestName: 'Test Guest',
    guestCount: 2,
  });
  const board = rows.find((r) => r.service_type === 'surfboard');
  check('C1', board && board.metadata.rental_people === 2, 'combo stores rental_people=2');
  check('C2', board && board.amount_due_cents === 9000, 'combo board total €90 for 2 people');
}

section('D. Breakdown wording + pluralization');
{
  check('D1', pluralUnit(1, 'day', 'days') === 'day', '1 day singular');
  check('D2', pluralUnit(3, 'day', 'days') === 'days', '3 days plural');
  const line = formatRentalPeopleDaysLine({ label: 'Soft board', days: 1, people: 2, totalCents: 3000 });
  check('D3', line === 'Soft board — 1 rental day × 2 people = €30.00', `line: ${line}`);
  const quote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-09-01',
    check_out: '2026-09-06',
    guest_count: 2,
    package_code: 'package_none',
    payment_choice: 'deposit',
    add_ons: normalizeQuoteAddOnsForCombo([{ code: 'soft_top_rental', days: 5 }], 2),
  });
  const items = buildBotQuoteIncludedItems(quote, { isNoPackage: true, hasAddOns: true });
  const boardItem = items && items.find((i) => i.code === 'soft_top_rental');
  check('D4', boardItem && boardItem.display_line.includes('5 rental days × 2 people = €150.00'), `included_items: ${boardItem && boardItem.display_line}`);
  const invRow = {
    service_type: 'surfboard',
    quantity: 5,
    amount_due_cents: 15000,
    metadata: { rental_days: 5, rental_people: 2, board_variant: 'soft', staff_ui_service_type: 'soft_board' },
  };
  const invText = formatServiceRecordInvoiceLineText(invRow, { typeLabel, billableCents: (sr) => sr.amount_due_cents, rates });
  check('D5', invText === 'Soft board — 5 rental days × 2 people = €150.00', `invoice: ${invText}`);
}

section('E. Group gear intent');
{
  check('E1', inferGroupGearPeopleCount("we'll take a board", 3, null) === 3, 'we take = whole group');
  check('E2', inferGroupGearPeopleCount('just one board please', 3, null) === 1, 'just one = 1');
  check('E3', inferGroupGearPeopleCount('board for 2 people', 4, null) === 2, 'explicit 2 people');
}

section('F. Room-preference branching');
{
  const baseState = { extracted_fields: { guest_count: 1, guest_name: 'Sarah' } };
  check('F1', inferLikelyGuestGender('Sarah') === 'female', 'Sarah → female');
  check('F2', inferLikelyGuestGender('Marco') === 'male', 'Marco → male');
  check('F2b', inferLikelyGuestGender('Andrea') === 'unknown', 'Andrea unisex → unknown');
  check('F2c', inferLikelyGuestGender('Giulia') === 'female', 'Giulia IT → female');
  check('F2d', inferLikelyGuestGender('Hans') === 'male', 'Hans DE → male');
  check('F2e', inferLikelyGuestGender('Camille') === 'female', 'Camille FR → female');
  check('F2f', inferLikelyGuestGender('Diego') === 'male', 'Diego ES → male');
  const soloFemale = inferRoomPreferenceNeed(baseState, { availability: { girls_room_available: true } });
  check('F3', soloFemale.needed && soloFemale.question_type === 'girls_or_mixed', 'solo female asks');
  const soloMale = inferRoomPreferenceNeed(
    { extracted_fields: { guest_count: 1, guest_name: 'Marco' } },
    { availability: { girls_room_available: true } },
  );
  check('F4', !soloMale.needed, 'solo male — no question');
  const noGirls = inferRoomPreferenceNeed(baseState, { availability: { girls_room_available: false } });
  check('F5', !noGirls.needed && noGirls.rule_applied === 'solo_no_girls_room_auto_assign', 'girls unavailable — skip');
  const groupComp = inferGroupCompositionNeed(
    { extracted_fields: { guest_count: 4, guest_name: 'Sophie' } },
    {},
  );
  check('F6', groupComp.needed && groupComp.question_type === 'group_composition', 'group 4 always asks composition');
  check('F7', parseGroupCompositionAnswer('all girls') === 'female', 'parse all girls');
  check('F8', parseGroupCompositionAnswer('all guys') === 'male', 'parse all guys');
  check('F9', parseGroupCompositionAnswer('a mix') === 'mixed', 'parse mix');
  const pairFemale = inferRoomPreferenceNeed(
    { extracted_fields: { guest_count: 2, group_gender: 'female' } },
    { availability: { girls_room_available: true, private_room_available: true } },
  );
  check('F10', pairFemale.needed && pairFemale.question_type === 'pair_female_room_options', 'pair all-girls room options');
  const pairWomenFriends = inferRoomPreferenceNeed(
    { extracted_fields: { guest_count: 2, group_gender: 'female' } },
    { availability: { girls_room_available: true, private_room_available: false } },
  );
  check('F11', pairWomenFriends.question_type === 'girls_or_mixed', 'pair women friends → girls offer');
  const groupFemale = inferRoomPreferenceNeed(
    { extracted_fields: { guest_count: 4, group_gender: 'female' } },
    { availability: { girls_room_available: true } },
  );
  check('F12', groupFemale.needed && groupFemale.question_type === 'girls_or_mixed', '3+ all-girls → girls or mixed');
  const groupMale = inferRoomPreferenceNeed(
    { extracted_fields: { guest_count: 4, group_gender: 'male' } },
    { availability: { girls_room_available: true } },
  );
  check('F13', !groupMale.needed, 'all-guys group — no room question');
  check('F14', groupCompositionResolved({ extracted_fields: { guest_count: 2, group_gender: 'mixed' } }), 'composition resolved when set');
  const ambiguous = inferRoomPreferenceNeed(
    { extracted_fields: { guest_count: 1, guest_name: 'Robin' } },
    { availability: { girls_room_available: true } },
  );
  check('F15', ambiguous.needed && ambiguous.question_type === 'neutral_shared', 'ambiguous solo → neutral ask');
  const namedGroupNoInfer = inferRoomPreferenceNeed(
    { extracted_fields: { guest_count: 3, guest_name: 'Marco' } },
    { availability: { girls_room_available: true } },
  );
  check('F16', !namedGroupNoInfer.needed && namedGroupNoInfer.rule_applied === 'awaiting_group_composition', 'group never infers from booker name');
}

section('G. Room option flags from beds');
{
  const beds = [
    { bed_code: 'R5-A', room_code: 'R5' },
    { bed_code: 'R5-B', room_code: 'R5' },
    { bed_code: 'R6-A', room_code: 'R6' },
    { bed_code: 'R3-A', room_code: 'R3' },
  ];
  const flags1 = computeWolfhouseRoomOptionFlags(beds, 1);
  check('G1', flags1.girls_room_available === true, 'R5 free → girls avail solo');
  const flags2 = computeWolfhouseRoomOptionFlags(beds, 2);
  check('G2', flags2.private_room_available === true, 'R6 free → private for 2');
}

console.log(`\n── verify-per-person-gear-room-pref ${failures ? 'FAILED' : 'PASSED'} (${passes}/${passes + failures}) ──\n`);
process.exit(failures > 0 ? 1 : 0);

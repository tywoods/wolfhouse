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
const { computeWolfhouseRoomOptionFlags, resolveQuoteRoomTypeFromPreference } = require('./lib/wolfhouse-room-options');
const {
  inferRoomPreferenceNeed,
  inferLikelyGuestGender,
  inferGroupCompositionNeed,
  parseGroupCompositionAnswer,
  groupCompositionResolved,
  determineNextBookingQuestion,
  isRoomPreferenceStage,
  POST_QUOTE_FIELD_ORDER,
} = require('./lib/luna-booking-intake-policy');
const { inferGroupGearPeopleCount } = require('./lib/luna-booking-addons-policy');
const { runAvailabilityBedSelection } = require('./lib/luna-bed-allocator');

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
  const roomStageCtx = {
    quote: { quote_status: 'ready', payment_choice_needed: false },
    payment_choice: { payment_choice_ready: true },
  };
  const baseState = { extracted_fields: { guest_count: 1, guest_name: 'Sarah' } };
  check('F1', inferLikelyGuestGender('Sarah') === 'female', 'Sarah → female');
  check('F2', inferLikelyGuestGender('Marco') === 'male', 'Marco → male');
  check('F2b', inferLikelyGuestGender('Andrea') === 'unknown', 'Andrea unisex → unknown');
  check('F2c', inferLikelyGuestGender('Giulia') === 'female', 'Giulia IT → female');
  check('F2d', inferLikelyGuestGender('Hans') === 'male', 'Hans DE → male');
  check('F2e', inferLikelyGuestGender('Camille') === 'female', 'Camille FR → female');
  check('F2f', inferLikelyGuestGender('Diego') === 'male', 'Diego ES → male');
  const soloFemale = inferRoomPreferenceNeed(baseState, { ...roomStageCtx, availability: { girls_room_available: true } });
  check('F3', soloFemale.needed && soloFemale.question_type === 'girls_or_mixed', 'solo female asks');
  const soloMale = inferRoomPreferenceNeed(
    { extracted_fields: { guest_count: 1, guest_name: 'Marco' } },
    { ...roomStageCtx, availability: { girls_room_available: true } },
  );
  check('F4', !soloMale.needed, 'solo male — no question');
  const noGirls = inferRoomPreferenceNeed(baseState, { ...roomStageCtx, availability: { girls_room_available: false } });
  check('F5', !noGirls.needed && noGirls.rule_applied === 'solo_no_girls_room_auto_assign', 'girls unavailable — skip');
  const groupComp = inferGroupCompositionNeed(
    { extracted_fields: { guest_count: 4, guest_name: 'Sophie' } },
    {},
  );
  check('F6', !groupComp.needed && groupComp.rule_applied === 'deferred_until_room_stage', 'group 4 defers composition until room stage');
  const groupCompRoom = inferGroupCompositionNeed(
    { extracted_fields: { guest_count: 4, guest_name: 'Sophie' } },
    {
      quote: { quote_status: 'ready', payment_choice_needed: false },
      channel_guest_name: 'Sophie',
      payment_choice: { payment_choice_ready: true },
    },
  );
  check('F6b', groupCompRoom.needed && groupCompRoom.question_type === 'group_composition', 'group 4 asks composition at room stage');
  check('F7', parseGroupCompositionAnswer('all girls') === 'female', 'parse all girls');
  check('F8', parseGroupCompositionAnswer('all guys') === 'male', 'parse all guys');
  check('F9', parseGroupCompositionAnswer('a mix') === 'mixed', 'parse mix');
  const pairFemale = inferRoomPreferenceNeed(
    { extracted_fields: { guest_count: 2, group_gender: 'female', guest_name: 'Anna' } },
    { ...roomStageCtx, availability: { girls_room_available: true, private_room_available: true } },
  );
  check('F10', pairFemale.needed && pairFemale.question_type === 'pair_female_room_options', 'pair all-girls room options');
  const pairWomenFriends = inferRoomPreferenceNeed(
    { extracted_fields: { guest_count: 2, group_gender: 'female', guest_name: 'Anna' } },
    { ...roomStageCtx, availability: { girls_room_available: true, private_room_available: false } },
  );
  check('F11', pairWomenFriends.question_type === 'girls_or_mixed', 'pair women friends → girls offer');
  const groupFemale = inferRoomPreferenceNeed(
    { extracted_fields: { guest_count: 4, group_gender: 'female', guest_name: 'Anna' } },
    { ...roomStageCtx, availability: { girls_room_available: true } },
  );
  check('F12', groupFemale.needed && groupFemale.question_type === 'girls_or_mixed', '3+ all-girls → girls or mixed');
  const groupMale = inferRoomPreferenceNeed(
    { extracted_fields: { guest_count: 4, group_gender: 'male', guest_name: 'Marco' } },
    { ...roomStageCtx, availability: { girls_room_available: true } },
  );
  check('F13', !groupMale.needed, 'all-guys group — no room question');
  check('F14', groupCompositionResolved({ extracted_fields: { guest_count: 2, group_gender: 'mixed' } }), 'composition resolved when set');
  const ambiguous = inferRoomPreferenceNeed(
    { extracted_fields: { guest_count: 1, guest_name: 'Robin' } },
    { ...roomStageCtx, availability: { girls_room_available: true } },
  );
  check('F15', ambiguous.needed && ambiguous.question_type === 'neutral_shared', 'ambiguous solo → neutral ask');
  const namedGroupNoInfer = inferRoomPreferenceNeed(
    { extracted_fields: { guest_count: 3, guest_name: 'Marco' } },
    { ...roomStageCtx, availability: { girls_room_available: true } },
  );
  check('F16', !namedGroupNoInfer.needed && namedGroupNoInfer.rule_applied === 'awaiting_group_composition', 'group at room stage waits for composition');
  const namedGroupEarly = inferRoomPreferenceNeed(
    { extracted_fields: { guest_count: 3, guest_name: 'Marco' } },
    { availability: { girls_room_available: true } },
  );
  check('F16b', !namedGroupEarly.needed && namedGroupEarly.rule_applied === 'deferred_until_room_stage', 'group defers before room stage');
}

section('H. Composition timing in booking flow');
{
  const quoteCtx = {
    quote: { quote_status: 'ready', payment_choice_needed: true },
    payment_choice: {},
  };
  const shortStayState = {
    extracted_fields: {
      guest_count: 4,
      guest_name: 'Anna',
      check_in: '2026-09-01',
      check_out: '2026-09-04',
    },
    add_ons_status: 'collected',
  };
  check('H1', POST_QUOTE_FIELD_ORDER.slice(-2).join(',') === 'group_composition,room_preference', 'composition+room last in post-quote order');
  check('H2', !isRoomPreferenceStage(shortStayState, quoteCtx), 'not room stage before payment choice');
  const afterPay = {
    ...quoteCtx,
    payment_choice: { payment_choice_ready: true },
  };
  check('H3', isRoomPreferenceStage(shortStayState, afterPay), 'room stage after payment + name');
  const nextAddons = determineNextBookingQuestion(
    { extracted_fields: { guest_count: 4, check_in: '2026-09-01', check_out: '2026-09-04' } },
    { quote: { quote_status: 'ready', payment_choice_needed: false, short_stay_addons_pending: true } },
  );
  check('H4', nextAddons.question === 'ask_addons_after_quote', 'addons before composition');
  const nextComp = determineNextBookingQuestion(shortStayState, afterPay);
  check('H5', nextComp.question === 'ask_group_composition', 'composition at room step before create');
}

section('I. Availability capacity-only vs gender-aware create');
{
  const bedRows = [
    { bed_code: 'R5-B1', room_code: 'R5', room_type: 'female_only', gender_strategy: 'Female preferred', capacity: 6, fill_priority: 4, bed_active: true, bed_sellable: true },
    { bed_code: 'R5-B2', room_code: 'R5', room_type: 'female_only', gender_strategy: 'Female preferred', capacity: 6, fill_priority: 4, bed_active: true, bed_sellable: true },
    { bed_code: 'R1-B1', room_code: 'R1', room_type: 'mixed', gender_strategy: 'Flexible', capacity: 5, fill_priority: 2, bed_active: true, bed_sellable: true },
    { bed_code: 'R1-B2', room_code: 'R1', room_type: 'mixed', gender_strategy: 'Flexible', capacity: 5, fill_priority: 2, bed_active: true, bed_sellable: true },
    { bed_code: 'R1-B3', room_code: 'R1', room_type: 'mixed', gender_strategy: 'Flexible', capacity: 5, fill_priority: 2, bed_active: true, bed_sellable: true },
    { bed_code: 'R1-B4', room_code: 'R1', room_type: 'mixed', gender_strategy: 'Flexible', capacity: 5, fill_priority: 2, bed_active: true, bed_sellable: true },
  ];
  const occupied = new Set(['R5-B1', 'R5-B2']);
  const allowed = new Set(bedRows.map((r) => r.bed_code));
  const capPick = runAvailabilityBedSelection({
    bedRows,
    occupiedBedCodes: occupied,
    allowedBedCodes: allowed,
    guestCount: 4,
    capacityOnly: true,
  });
  check('I1', !capPick.handoff && capPick.selected_bed_codes.length === 4, 'capacity check passes with gender unknown');
  const genderPick = runAvailabilityBedSelection({
    bedRows,
    occupiedBedCodes: occupied,
    allowedBedCodes: allowed,
    guestCount: 4,
    groupGender: 'mixed',
    capacityOnly: false,
  });
  check('I2', !genderPick.handoff && genderPick.selected_bed_codes.length === 4, 'create assigns mixed group with gender-aware allocator');
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
  const flags3 = computeWolfhouseRoomOptionFlags(
    [{ bed_code: 'R3-A', room_code: 'R3' }, { bed_code: 'R3-B', room_code: 'R3' }],
    2,
  );
  check('G3', flags3.private_room_available === false, 'R6 unavailable → no private offer');
  check('G4', resolveQuoteRoomTypeFromPreference('shared', 'couple_private') === 'double', 'couple_private → double quote room_type');
}

console.log(`\n── verify-per-person-gear-room-pref ${failures ? 'FAILED' : 'PASSED'} (${passes}/${passes + failures}) ──\n`);
process.exit(failures > 0 ? 1 : 0);

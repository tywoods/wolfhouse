'use strict';

/**
 * Phase 1 — guest add-on pricing + combo promo unit gate.
 */

const {
  previewGuestAddonPricing,
  resolveGuestAddonComboPricing,
  computeWetsuitBoardComboRebalance,
  findCoveringBoardRental,
  findUnpaidWetsuitForCombo,
  validateAndNormalizeQuoteAddOns,
  normalizeBotServiceType,
} = require('./lib/guest-addon-pricing');
const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
const { buildBotQuoteIncludedItems } = require('./lib/bot-quote-included-items');
const fs = require('fs');
const path = require('path');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-guest-addon-pricing.js\n');

section('A. Meal pricing');
{
  const p3 = previewGuestAddonPricing('meal', 3, 'wolfhouse-somo');
  check('A1', p3.amount_due_cents === 4500, '3 meals = €45 (4500 cents)');
  check('A2', p3.payment_required === true, 'meals require payment');
  check('A3', p3.pricing_addon_code === 'meal', 'meal addon code');
  check('A4', !p3.reason, 'no meal_on_site_only reason');
}

section('B. Surfboard board_type pricing');
{
  const soft = previewGuestAddonPricing('surfboard', 2, 'wolfhouse-somo', { board_type: 'soft' });
  const hard = previewGuestAddonPricing('surfboard', 2, 'wolfhouse-somo', { board_type: 'hard' });
  check('B1', soft.amount_due_cents === 3000, 'soft board 2 days = €30');
  check('B2', hard.amount_due_cents === 4000, 'hard board 2 days = €40');
  check('B3', soft.pricing_addon_code === 'soft_top_rental', 'soft uses soft_top_rental');
  check('B4', hard.pricing_addon_code === 'hard_board_rental', 'hard uses hard_board_rental');
  check('B5', !(soft.warnings || []).some((w) => /confirm board type/i.test(w)), 'no board type confirm warning');
}

section('C. Confirmed rentals — no staff handoff triggers');
{
  const w = previewGuestAddonPricing('wetsuit', 3, 'wolfhouse-somo');
  const b = previewGuestAddonPricing('surfboard', 2, 'wolfhouse-somo', { board_type: 'soft' });
  check('C1', w.amount_due_cents != null && w.payment_required, 'wetsuit price resolved');
  check('C2', b.amount_due_cents != null && b.payment_required, 'surfboard price resolved');
  check('C3', !(w.warnings || []).some((x) => /staff may need to confirm/i.test(x)), 'no wetsuit staff timing warning');
  check('C4', !(b.warnings || []).some((x) => /staff may need to confirm/i.test(x)), 'no surfboard staff timing warning');
}

section('D. Wetsuit free with existing board');
{
  const existing = [{
    id: 'board-1',
    service_type: 'surfboard',
    quantity: 3,
    status: 'confirmed',
    metadata: { rental_days: 3, board_variant: 'soft' },
  }];
  check('D1', !!findCoveringBoardRental(existing, 3), 'finds covering board');
  const combo = resolveGuestAddonComboPricing({
    serviceType: 'wetsuit',
    quantity: 3,
    pricing: previewGuestAddonPricing('wetsuit', 3, 'wolfhouse-somo'),
    existingRecords: existing,
  });
  check('D2', combo.amount_due_cents === 0, 'wetsuit free when board exists');
  check('D3', combo.combo_reason === 'wetsuit_free_with_board', 'combo reason set');
  check('D4', combo.payment_required === false, 'no payment for free wetsuit');
}

section('E. Board frees unpaid wetsuit');
{
  const existing = [{
    id: 'wetsuit-1',
    service_type: 'wetsuit',
    quantity: 2,
    amount_due_cents: 1000,
    amount_paid_cents: 0,
    payment_status: 'pending',
    status: 'confirmed',
    metadata: { rental_days: 2 },
  }];
  check('E1', !!findUnpaidWetsuitForCombo(existing, 2), 'finds unpaid wetsuit');
  const combo = resolveGuestAddonComboPricing({
    serviceType: 'surfboard',
    quantity: 2,
    boardType: 'soft',
    pricing: previewGuestAddonPricing('surfboard', 2, 'wolfhouse-somo', { board_type: 'soft' }),
    existingRecords: existing,
  });
  check('E2', combo.amount_due_cents === 3000, 'board still full price');
  check('E3', combo.free_wetsuit_record_id === 'wetsuit-1', 'marks wetsuit to zero out');
}

section('F. Paid wetsuit untouched when adding board');
{
  const existing = [{
    id: 'wetsuit-paid',
    service_type: 'wetsuit',
    quantity: 2,
    amount_due_cents: 1000,
    amount_paid_cents: 1000,
    payment_status: 'paid',
    status: 'confirmed',
    metadata: { rental_days: 2 },
  }];
  check('F1', !findUnpaidWetsuitForCombo(existing, 2), 'paid wetsuit not selected');
  const combo = resolveGuestAddonComboPricing({
    serviceType: 'surfboard',
    quantity: 2,
    boardType: 'hard',
    pricing: previewGuestAddonPricing('surfboard', 2, 'wolfhouse-somo', { board_type: 'hard' }),
    existingRecords: existing,
  });
  check('F2', !combo.free_wetsuit_record_id, 'no wetsuit adjustment');
  check('F3', combo.amount_due_cents === 4000, 'board full hard price');
}

section('G. Rebalance after board removed — one wetsuit restored');
{
  const existing = [
    {
      id: 'board-1',
      service_type: 'surfboard',
      quantity: 1,
      amount_due_cents: 4000,
      amount_paid_cents: 0,
      payment_status: 'not_requested',
      status: 'confirmed',
      metadata: { rental_days: 2, board_variant: 'hard' },
    },
    {
      id: 'wetsuit-1',
      service_type: 'wetsuit',
      quantity: 1,
      amount_due_cents: 0,
      amount_paid_cents: 0,
      payment_status: 'not_requested',
      status: 'confirmed',
      metadata: { rental_days: 2, combo_waived: true },
    },
    {
      id: 'wetsuit-2',
      service_type: 'wetsuit',
      quantity: 1,
      amount_due_cents: 0,
      amount_paid_cents: 0,
      payment_status: 'not_requested',
      status: 'confirmed',
      metadata: { rental_days: 2, combo_waived: true },
    },
  ];
  const rebalance = computeWetsuitBoardComboRebalance(existing, { wetsuit_unit_cents: 500 });
  check('G1', rebalance.updates.length === 1, 'one wetsuit restored when only one board remains');
  check('G2', rebalance.updates[0].action === 'restore', 'restore action for unpaired wetsuit');
  check('G3', rebalance.updates[0].amount_due_cents === 1000, 'restored wetsuit bills 2 days at €5');
}

section('H. Rebalance with two boards — both wetsuits stay free');
{
  const existing = [
    {
      id: 'board-1',
      service_type: 'surfboard',
      quantity: 1,
      amount_due_cents: 4000,
      status: 'confirmed',
      metadata: { rental_days: 2, board_variant: 'hard' },
    },
    {
      id: 'board-2',
      service_type: 'surfboard',
      quantity: 1,
      amount_due_cents: 4000,
      status: 'confirmed',
      metadata: { rental_days: 2, board_variant: 'hard' },
    },
    {
      id: 'wetsuit-1',
      service_type: 'wetsuit',
      quantity: 1,
      amount_due_cents: 0,
      status: 'confirmed',
      metadata: { rental_days: 2, combo_waived: true },
    },
    {
      id: 'wetsuit-2',
      service_type: 'wetsuit',
      quantity: 1,
      amount_due_cents: 0,
      status: 'confirmed',
      metadata: { rental_days: 2, combo_waived: true },
    },
  ];
  const rebalance = computeWetsuitBoardComboRebalance(existing, { wetsuit_unit_cents: 500 });
  check('H1', rebalance.updates.length === 0, 'no rebalance writes when boards cover all wetsuits');
}

section('I. hard_top_rental alias + hard board wetsuit combo quote');
{
  const prep = validateAndNormalizeQuoteAddOns([
    { code: 'hard_top_rental', days: 3 },
    { code: 'wetsuit_rental', days: 3 },
  ], 2);
  check('I1', prep.ok === true, 'hard_top_rental alias accepted');
  const quote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-09-01',
    check_out: '2026-09-04',
    guest_count: 2,
    package_code: 'package_none',
    payment_choice: 'deposit',
    add_ons: prep.add_ons,
  });
  check('I2', quote.success, 'quote succeeds');
  const combo = quote.line_items.find((li) => li.code === 'wetsuit_hard_board_combo');
  check('I3', combo && combo.total_cents === 12000, 'hard board 3d×2p = €120 in combo');
  check('I4', !quote.line_items.some((li) => li.code === 'wetsuit_rental' && li.total_cents > 0), 'wetsuit not billed separately');
  const items = buildBotQuoteIncludedItems(quote, { isNoPackage: true, hasAddOns: true });
  const hardLine = items && items.find((i) => i.label === 'Hard board');
  const wetsuitLine = items && items.find((i) => i.label === 'Wetsuit');
  check('I5', hardLine && hardLine.display_line.includes('€120.00'), `hard board line: ${hardLine && hardLine.display_line}`);
  check('I6', wetsuitLine && wetsuitLine.free === true, 'wetsuit shown free in included_items');
}

section('J. Unknown add-on code rejected');
{
  const bad = validateAndNormalizeQuoteAddOns([{ code: 'definitely_fake_rental', days: 1 }], 1);
  check('J1', bad.ok === false, 'unknown code fails validation');
  check('J2', (bad.unknown_codes || []).includes('definitely_fake_rental'), 'reports unknown code');
  const quote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-09-01',
    check_out: '2026-09-04',
    guest_count: 1,
    package_code: 'package_none',
    payment_choice: 'deposit',
    add_ons: [{ code: 'definitely_fake_rental', days: 1 }],
  });
  check('J3', quote.success === false, 'quote calculator blocks unknown code');
  check('J4', (quote.blockers || []).some((b) => /unknown add-on/i.test(b)), 'blocker mentions unknown add-on');
}

section('K. SOUL — exact codes + no fabricated quote lines');
{
  const soul = fs.readFileSync(path.join(__dirname, '..', 'docker', 'hermes-staging', 'SOUL.md'), 'utf8');
  check('K1', /hard_board_rental/.test(soul) && /not `hard_top_rental`/.test(soul), 'SOUL warns hard_top typo');
  check('K2', /soft_top_rental/.test(soul) && /included_items/.test(soul), 'SOUL cites exact codes + included_items');
  check('K3', /Never invent a line|never fabricate/i.test(soul), 'SOUL forbids fabricated quote lines');
}

section('L. Post-booking service_type aliases');
{
  const yoga = normalizeBotServiceType('yoga_class');
  check('L1', yoga.ok && yoga.service_type === 'yoga', 'yoga_class → yoga');
  const meals = normalizeBotServiceType('meals');
  check('L2', meals.ok && meals.service_type === 'meal', 'meals → meal');
  const lesson = normalizeBotServiceType('surf_lesson_single');
  check('L3', lesson.ok && lesson.service_type === 'surf_lesson', 'surf_lesson_single → surf_lesson');
  const soft = normalizeBotServiceType('soft_top_rental');
  check('L4', soft.ok && soft.service_type === 'surfboard' && soft.board_type === 'soft', 'soft_top_rental → surfboard soft');
  const bad = normalizeBotServiceType('definitely_fake_addon');
  check('L5', !bad.ok, 'unknown service_type rejected');
}

section('M. Package quote included_items breakdown');
{
  const prep = validateAndNormalizeQuoteAddOns([
    { code: 'soft_top_rental', days: 7 },
    { code: 'wetsuit_rental', days: 7 },
  ], 2);
  const quote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-08-15',
    check_out: '2026-08-22',
    guest_count: 2,
    package_code: 'malibu',
    room_type: 'double',
    payment_choice: 'deposit',
    add_ons: prep.add_ons,
  });
  check('M0', quote.success, 'package quote succeeds');
  const items = buildBotQuoteIncludedItems(quote, { isNoPackage: false, hasAddOns: true });
  check('M1', items && items.length >= 3, `package+breakdown lines: ${items && items.length}`);
  check('M2', items && items.some((i) => i.code === 'package'), 'package base line');
  check('M3', items && items.some((i) => i.code === 'room_supplement'), 'private supplement line');
  check('M4', items && items.some((i) => i.code === 'soft_top_rental' || i.code === 'wetsuit_soft_top_combo'), 'board add-on line');
  const suppLine = (quote.line_items || []).find((i) => i.code === 'room_supplement');
  check('M5', suppLine && suppLine.total_cents === 7000, `double supplement flat €70/7n (got ${suppLine && suppLine.total_cents})`);
  check('M6', quote.subtotal_cents >= 7000 && quote.total_cents === quote.subtotal_cents, 'total includes room supplement');
}

section('P. Private room supplement — per-room not per-person');
{
  const quote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-07-06',
    check_out: '2026-07-13',
    guest_count: 2,
    package_code: 'malibu',
    room_type: 'double',
    payment_choice: 'deposit',
  });
  check('P1', quote.success, 'couple private quote succeeds');
  const supp = (quote.line_items || []).find((i) => i.code === 'room_supplement');
  check('P2', supp && supp.total_cents === 7000, `7n×€10 flat = €70 (got ${supp && supp.total_cents})`);
  check('P3', supp && supp.total_cents !== 14000, 'not per-person €140');
  check('P4', quote.total_cents === quote.subtotal_cents && quote.total_cents > 0, 'deposit/total include supplement');
}

section('N. Lesson schedule + SOUL guest-safe copy');
{
  const {
    buildLessonScheduleGuestSection,
    bookingDraftIncludesSurfLessons,
  } = require('./lib/luna-guest-lesson-schedule-config');
  check('N1', !bookingDraftIncludesSurfLessons({ package_code: 'malibu' }), 'malibu no lesson section');
  check('N2', bookingDraftIncludesSurfLessons({ package_code: 'waimea' }), 'waimea has lesson section');
  const itSection = buildLessonScheduleGuestSection('wolfhouse-somo', 'it', { package_code: 'waimea' });
  check('N3', itSection && !/Lessons run most days in season/i.test(itSection), 'IT section has no English caveat');
  check('N4', /bassa stagione/i.test(itSection), 'IT low-season caveat localized');
  const soul = fs.readFileSync(path.join(__dirname, '..', 'docker', 'hermes-staging', 'SOUL.md'), 'utf8');
  check('N5', /Never expose backend mechanics/i.test(soul), 'SOUL forbids system/tool leaks');
  check('N6', /`yoga`/.test(soul) && /`surfboard`/.test(soul), 'SOUL documents post-booking service types');
}

section('O. Closed season — guest-safe decline (no staff handoff)');
{
  const { buildBotClosedSeasonReply, CLOSED_SEASON_COPY } = require('./lib/bot-guest-safe-copy');
  const janQuote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2027-01-15',
    check_out: '2027-01-22',
    guest_count: 2,
    package_code: 'malibu',
    room_type: 'shared',
    payment_choice: 'deposit',
  });
  check('O1', janQuote.closed_season === true, 'January quote flagged closed_season');
  check('O2', janQuote.staff_review_required === false, 'closed season does not require staff review');
  check('O3', janQuote.success === false, 'closed season quote blocked');
  const novQuote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2027-11-01',
    check_out: '2027-11-08',
    guest_count: 2,
    package_code: 'malibu',
    room_type: 'shared',
    payment_choice: 'deposit',
  });
  check('O3b', novQuote.closed_season === true, 'November quote flagged closed_season');
  for (const lang of ['en', 'it', 'es', 'de']) {
    const copy = buildBotClosedSeasonReply({ language: lang });
    check(`O4-${lang}`, copy.reply_draft === CLOSED_SEASON_COPY[lang], `${lang} closed-season copy`);
    check(`O5-${lang}`, !/sistema|system|staff review|verifica manuale/i.test(copy.reply_draft), `${lang} copy has no internal leak`);
  }
  const soul = fs.readFileSync(path.join(__dirname, '..', 'docker', 'hermes-staging', 'SOUL.md'), 'utf8');
  const plugin = fs.readFileSync(path.join(__dirname, '..', 'docker', 'hermes-staging', 'plugins', 'wolfhouse_staff_api', '__init__.py'), 'utf8');
  check('O6', /closed_season/.test(soul), 'SOUL documents closed_season handling');
  check('O7', /closed_season/.test(plugin), 'plugin suppresses staff_review on closed_season');
}

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);

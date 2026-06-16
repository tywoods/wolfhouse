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
} = require('./lib/guest-addon-pricing');

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

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);

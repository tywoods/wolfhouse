'use strict';

/**
 * Rental invoice line text — Payments tab day-rate display gate.
 */

const {
  loadWolfhouseRentalDayRates,
  resolveRentalInvoiceDisplayQty,
  resolveRentalInvoiceUnitCents,
  normalizeSplitRentalMetadata,
  formatServiceRecordInvoiceLineText,
} = require('./lib/service-record-invoice-line');
const { buildManualBookingServiceRecordRows } = require('./lib/manual-booking-service-records');
const {
  formatServiceRecordForSchedule,
  serviceRecordBillableCents,
} = require('./lib/staff-booking-services-schedule');
const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');

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
  if (t === 'surfboard' && meta.board_variant === 'hard') return 'Hard board';
  return t || '—';
}

function unitLabel(t) {
  if (t === 'wetsuit' || t === 'surfboard') return 'days';
  return null;
}

function billable(sr) {
  return serviceRecordBillableCents(sr);
}

function lineText(sr) {
  return formatServiceRecordInvoiceLineText(sr, { typeLabel, unitLabel, billableCents: billable, rates });
}

console.log('\nverify-rental-invoice-line-text.js\n');

section('A. Write-time — manual booking rows are quantity/days/amount consistent');
{
  const quote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-09-01',
    check_out: '2026-09-04',
    guest_count: 1,
    package_code: 'package_none',
    payment_choice: 'deposit',
    add_ons: [{ code: 'wetsuit_soft_top_combo', days: 3 }],
  });
  const rows = buildManualBookingServiceRecordRows({
    addOns: [{ code: 'wetsuit_soft_top_combo', days: 3 }],
    quote,
    clientSlug: 'wolfhouse-somo',
    bookingId: '00000000-0000-0000-0000-000000000001',
    bookingCode: 'MB-WOLFHO-20260901-TEST',
    guestName: 'Test Guest',
    guestCount: 1,
  });
  const board = rows.find((r) => r.service_type === 'surfboard');
  const wetsuit = rows.find((r) => r.service_type === 'wetsuit');
  check('A1', board && board.quantity === 3, 'surfboard quantity = rental days');
  check('A2', board.amount_due_cents === 4500, 'surfboard amount = 3 days × 1 person × €15');
  check('A3', board.metadata.rental_days === 3, 'surfboard rental_days = 3');
  check('A4', board.metadata.rental_people === 1, 'surfboard rental_people = 1');
  check('A5', board.metadata.unit_cents === rates.soft_top_rental, 'surfboard unit_cents = €15/day');
  check('A6', wetsuit && wetsuit.quantity === 3 && wetsuit.amount_due_cents === 0, 'combo wetsuit qty=3 amount=0');
  check('A7', wetsuit.metadata.unit_cents === 0, 'combo wetsuit unit_cents = 0');
}

section('B. Split metadata — per-day rows get rental_days = 1');
{
  const split = normalizeSplitRentalMetadata({
    rental_days: 3,
    board_variant: 'soft',
    source_quote_line_code: 'wetsuit_soft_top_combo',
  }, 'surfboard');
  check('B1', split.rental_days === 1, 'split row rental_days = 1');
  check('B2', split.rental_span_days === 3, 'rental_span_days preserves span');
}

section('C. Payments line — unit equals configured day-rate (MB-WOLFHO bug scenario)');
{
  const splitRow = {
    service_type: 'surfboard',
    quantity: 1,
    amount_due_cents: 1500,
    metadata: {
      rental_days: 3,
      rental_people: 1,
      board_variant: 'soft',
      staff_ui_service_type: 'soft_board',
      source_quote_line_code: 'wetsuit_soft_top_combo',
      split_from: 'abc',
      split_unit: 1,
    },
  };
  const displayQty = resolveRentalInvoiceDisplayQty({
    quantity: splitRow.quantity,
    serviceType: splitRow.service_type,
    metadata: splitRow.metadata,
  });
  const unit = resolveRentalInvoiceUnitCents({
    serviceType: splitRow.service_type,
    metadata: splitRow.metadata,
    totalCents: 1500,
    displayQty,
    rates,
  });
  const text = lineText(splitRow);
  check('C1', displayQty === 1, 'display qty is 1 (not span 3)');
  check('C2', unit === rates.soft_top_rental, 'unit is soft board €15/day (not €5)');
  check('C3', text === 'Soft board — 3 rental days × 1 person = €15.00', `line: ${text}`);

  const aggregated = {
    service_type: 'surfboard',
    quantity: 3,
    amount_due_cents: 4500,
    metadata: {
      rental_days: 3,
      rental_people: 1,
      board_variant: 'soft',
      staff_ui_service_type: 'soft_board',
      source_quote_line_code: 'wetsuit_soft_top_combo',
      unit_cents: rates.soft_top_rental,
    },
  };
  const aggText = lineText(aggregated);
  check('C4', aggText === 'Soft board — 3 rental days × 1 person = €45.00', `aggregated: ${aggText}`);
}

section('D. Wetsuit + hard board rates');
{
  const wetsuitRow = {
    service_type: 'wetsuit',
    quantity: 3,
    amount_due_cents: 1500,
    metadata: { rental_days: 3, rental_people: 1, source_quote_line_code: 'wetsuit_rental', unit_cents: rates.wetsuit_rental },
  };
  const hardRow = {
    service_type: 'surfboard',
    quantity: 3,
    amount_due_cents: 2000,
    metadata: {
      rental_days: 3,
      rental_people: 1,
      board_variant: 'hard',
      staff_ui_service_type: 'hard_board',
      source_quote_line_code: 'hard_board_rental',
    },
  };
  check('D1', lineText(wetsuitRow).includes('3 rental days × 1 person = €15.00'), 'wetsuit people×days line');
  check('D2', lineText(hardRow).includes('3 rental days × 1 person = €20.00'), 'hard board people×days line');
  check('D3', resolveRentalInvoiceUnitCents({
    serviceType: 'wetsuit',
    metadata: { combo_part: 'wetsuit' },
    totalCents: 0,
    displayQty: 3,
    rates,
  }) === 0, 'combo wetsuit unit €0');
}

section('E. Services schedule totals unchanged');
{
  const rows = [
    {
      id: '1',
      service_type: 'surfboard',
      quantity: 1,
      amount_due_cents: 1500,
      metadata: { rental_days: 3, rental_people: 1, board_variant: 'soft', staff_ui_service_type: 'soft_board' },
    },
    {
      id: '2',
      service_type: 'surfboard',
      quantity: 1,
      amount_due_cents: 1500,
      metadata: { rental_days: 3, rental_people: 1, board_variant: 'soft', staff_ui_service_type: 'soft_board' },
    },
    {
      id: '3',
      service_type: 'surfboard',
      quantity: 1,
      amount_due_cents: 1500,
      metadata: { rental_days: 3, rental_people: 1, board_variant: 'soft', staff_ui_service_type: 'soft_board' },
    },
  ];
  const svcTotal = rows.reduce((s, r) => s + (formatServiceRecordForSchedule(r).total_price_cents || 0), 0);
  const invoiceTotal = rows.reduce((s, r) => s + billable(r), 0);
  check('E1', svcTotal === 4500, 'services tab total €45');
  check('E2', invoiceTotal === 4500, 'invoice billable total €45');
  check('E3', rows.every((r) => lineText(r).includes('rental days × 1 person')), 'each payment line shows people×days');
}

console.log(`\n── verify-rental-invoice-line-text ${failures ? 'FAILED' : 'PASSED'} (${passes}/${passes + failures}) ──\n`);
process.exit(failures > 0 ? 1 : 0);

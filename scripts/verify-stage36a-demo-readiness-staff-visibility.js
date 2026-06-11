/**
 * Stage 36a — Ale/Cami demo readiness: staff visibility after Luna booking.
 *
 * Static/mock checks only — no live staging DB, no deploy, no sends.
 *
 * Usage:
 *   npm run verify:stage36a-demo-readiness-staff-visibility
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURE_FILE = path.join(ROOT, 'fixtures', 'staff-demo-readiness', 'demo-booking-shapes.json');
const EXEC_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-execute.js');
const PENDING_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-pending-manual-services.js');
const SHARED_FILE = path.join(__dirname, 'lib', 'staff-pending-manual-services.js');
const LOOKUP_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-booking-lookup.js');
const BALANCE_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-balance-due.js');
const ARRIVALS_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-arrivals-checkouts.js');
const REG_FILE = path.join(__dirname, 'lib', 'staff-query-registry.js');
const API_FILE = path.join(__dirname, 'staff-query-api.js');
const DETAIL_FILE = path.join(__dirname, 'lib', 'staff-booking-detail-queries.js');
const PAYMENT_FILE = path.join(__dirname, 'lib', 'staff-payment-queries.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const PLAYGROUND_FILE = path.join(__dirname, 'lib', 'open-demo-playground-common.js');

let passes = 0;
let failures = 0;

function ok(msg) { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

const FORBIDDEN_STAFF_COPY = [
  'metadata.pending_origin',
  'service_date=null',
  'luna_guest_pending',
  '"pending_origin"',
  'needs_scheduling":',
];

function staffCopyClean(text) {
  const s = String(text || '');
  return !FORBIDDEN_STAFF_COPY.some((needle) => s.includes(needle))
    && !/^\s*\{/.test(s.trim());
}

console.log('\nverify-stage36a-demo-readiness-staff-visibility.js  (Stage 36a)\n');

for (const f of [
  FIXTURE_FILE, EXEC_FILE, PENDING_FILE, SHARED_FILE, LOOKUP_FILE,
  BALANCE_FILE, ARRIVALS_FILE, REG_FILE, API_FILE, DETAIL_FILE, PAYMENT_FILE, PKG_FILE,
]) {
  check(fs.existsSync(f), `${path.relative(ROOT, f)} exists`);
}
if (failures) process.exit(1);

const execSrc = fs.readFileSync(EXEC_FILE, 'utf8');
const pendingSrc = fs.readFileSync(PENDING_FILE, 'utf8');
const sharedSrc = fs.readFileSync(SHARED_FILE, 'utf8');
const lookupSrc = fs.readFileSync(LOOKUP_FILE, 'utf8');
const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const detailSrc = fs.readFileSync(DETAIL_FILE, 'utf8');
const paymentSrc = fs.readFileSync(PAYMENT_FILE, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
const playgroundSrc = fs.readFileSync(PLAYGROUND_FILE, 'utf8');
const demoFixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));

check(
  pkg.scripts && pkg.scripts['verify:stage36a-demo-readiness-staff-visibility']
    === 'node scripts/verify-stage36a-demo-readiness-staff-visibility.js',
  'package.json verify script registered',
);

for (const f of [SHARED_FILE, PENDING_FILE, LOOKUP_FILE, BALANCE_FILE]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'ignore' });
    ok(`${path.basename(f)} passes node --check`);
  } catch (_) {
    fail(`${path.basename(f)} passes node --check`);
  }
}

const {
  formatPendingManualServiceStaffLine,
  formatPendingManualServicesSection,
  filterPendingManualServiceRecords,
  isPendingManualServiceRecord,
} = require('./lib/staff-pending-manual-services');
const {
  resolveAskLunaPendingManualServicesIntentKey,
  formatAskLunaPendingManualServicesAnswer,
  PENDING_MANUAL_KEY,
  PENDING_YOGA_KEY,
  PENDING_MEALS_KEY,
} = require('./lib/staff-ask-luna-pending-manual-services');
const {
  resolveAskLunaBookingLookupIntentKey,
  formatAskLunaBookingLookupAnswer,
} = require('./lib/staff-ask-luna-booking-lookup');
const { resolveBalanceDueIntentKey } = require('./lib/staff-ask-luna-balance-due');
const { resolveAskLunaArrivalsCheckoutsIntentKey } = require('./lib/staff-ask-luna-arrivals-checkouts');
const { REGISTRY_BY_KEY } = require('./lib/staff-query-registry');

console.log('\nA. Demo fixture shapes (static)');

check(demoFixture.bookings && demoFixture.bookings.length === 2, 'two demo booking shapes defined');

for (const shape of demoFixture.bookings) {
  const bk = shape.booking || {};
  check(bk.booking_code && bk.guest_name && bk.check_in && bk.check_out, `${shape.id}: booking basics present`);
  check(bk.payment_status && bk.balance_due_cents != null, `${shape.id}: payment/balance fields present`);
  check(shape.payments && shape.payments.balance_due_cents > 0, `${shape.id}: balance due in payments block`);

  const pendingRows = filterPendingManualServiceRecords(shape.service_records || []);
  check(pendingRows.length > 0, `${shape.id}: has pending manual service records`);

  const section = formatPendingManualServicesSection(shape.service_records || []);
  check(section.startsWith('Pending services:'), `${shape.id}: pending services section header`);
  for (const expected of shape.expected_staff_pending_lines || []) {
    check(section.includes(expected), `${shape.id}: includes "${expected}"`);
  }
  check(staffCopyClean(section), `${shape.id}: pending section has no internal/metadata leak`);

  if (shape.id.includes('accommodation')) {
    check(bk.package_code === 'accommodation_only', `${shape.id}: accommodation only`);
    check(shape.addons && shape.addons.surf_addons === 'skipped', `${shape.id}: surf add-ons skipped`);
    check(bk.payment_status === 'deposit_paid', `${shape.id}: deposit paid`);
  }
  if (shape.id.includes('malibu')) {
    check(bk.package_code === 'malibu', `${shape.id}: malibu package`);
    check(shape.transfer && shape.transfer.status === 'deferred', `${shape.id}: transfer deferred`);
  }
}

console.log('\nB. Booking detail + Staff Portal payload wiring');

check(detailSrc.includes('getBookingServiceRecordsQuery'), 'booking detail includes service records query');
check(apiSrc.includes('filterPendingManualServiceRecords'), 'API filters pending manual services');
check(apiSrc.includes('pending_manual_services'), 'API payload includes pending_manual_services');
check(apiSrc.includes('staff_line: formatPendingManualServiceStaffLine'), 'API maps staff_line for drawer');
check(apiSrc.includes('bcRenderPendingManualServicesOverviewHtml'), 'drawer renders pending services card');
check(apiSrc.includes('balance_due_cents'), 'API booking payload includes balance_due_cents');
check(apiSrc.includes('payment_status'), 'API booking payload includes payment_status');
check(apiSrc.includes('Pending services'), 'drawer card title uses Pending services');

console.log('\nC. Ask Luna demo questions');

const DEMO_QUESTIONS = [
  ['Who asked for yoga?', PENDING_YOGA_KEY, 'pending'],
  ['Who needs meals scheduled?', PENDING_MEALS_KEY, 'pending'],
  ['Show pending manual services', PENDING_MANUAL_KEY, 'pending'],
  ['What services need staff follow-up?', PENDING_MANUAL_KEY, 'pending'],
  ['What does WH-G27-DEMO36A need?', 'bookings.lookup', 'lookup'],
  ['Who still owes money?', 'payments.balance_due', 'balance'],
  ['Who is checking in today?', 'bookings.arrivals_today', 'arrivals'],
  ['Who is checking out tomorrow?', 'bookings.checkouts_tomorrow', 'checkouts'],
];

for (const [phrase, expectedKey, kind] of DEMO_QUESTIONS) {
  let got = null;
  if (kind === 'pending') {
    got = resolveAskLunaPendingManualServicesIntentKey(phrase, REGISTRY_BY_KEY);
    check(got && got.intentKey === expectedKey, `routes "${phrase}" → ${expectedKey}`);
  } else if (kind === 'lookup') {
    got = resolveAskLunaBookingLookupIntentKey(phrase, REGISTRY_BY_KEY);
    check(got && got.intentKey === expectedKey, `routes "${phrase}" → ${expectedKey}`);
    if (phrase.includes('WH-G27')) {
      check(got.extraParams && got.extraParams.searchValue === 'WH-G27-DEMO36A', 'booking code extracted from question');
    }
  } else if (kind === 'balance') {
    got = resolveBalanceDueIntentKey(phrase, REGISTRY_BY_KEY);
    check(got === expectedKey, `routes "${phrase}" → ${expectedKey}`);
  } else if (kind === 'arrivals') {
    got = resolveAskLunaArrivalsCheckoutsIntentKey(phrase, REGISTRY_BY_KEY);
    check(got && got.intentKey === expectedKey, `routes "${phrase}" → ${expectedKey}`);
  } else if (kind === 'checkouts') {
    got = resolveAskLunaArrivalsCheckoutsIntentKey(phrase, REGISTRY_BY_KEY);
    check(got && got.intentKey === expectedKey, `routes "${phrase}" → ${expectedKey}`);
  }
}

console.log('\nD. Staff copy polish (pending services)');

const yogaShape = demoFixture.bookings[0];
const malibuShape = demoFixture.bookings[1];
const yogaAnswer = formatAskLunaPendingManualServicesAnswer(
  PENDING_YOGA_KEY,
  [{
    booking_code: yogaShape.booking.booking_code,
    guest_name: yogaShape.booking.guest_name,
    check_in: yogaShape.booking.check_in,
    check_out: yogaShape.booking.check_out,
    room_label: yogaShape.booking.primary_room_code,
    ...yogaShape.service_records[0],
  }],
  { pendingCategory: 'yoga' },
);
check(yogaAnswer.includes('needs scheduling'), 'Ask Luna yoga answer mentions scheduling');
check(staffCopyClean(yogaAnswer), 'Ask Luna yoga answer has no metadata leak');

const lookupOut = formatAskLunaBookingLookupAnswer([{
  guest_name: yogaShape.booking.guest_name,
  booking_code: yogaShape.booking.booking_code,
  guest_count: yogaShape.booking.guest_count,
  booking_status: yogaShape.booking.status,
  payment_status: yogaShape.booking.payment_status,
  balance_due_cents: yogaShape.booking.balance_due_cents,
  check_in: yogaShape.booking.check_in,
  check_out: yogaShape.booking.check_out,
  bed_summary: yogaShape.booking.primary_room_code,
  pending_manual_services_summary: yogaShape.expected_staff_pending_lines[0],
}], {});
check(lookupOut.includes('Pending services:'), 'booking lookup has Pending services section');
check(lookupOut.includes('Deposit paid') || lookupOut.includes('balance'), 'booking lookup shows payment/balance');
check(lookupOut.includes('Yoga — requested by guest, needs scheduling'), 'booking lookup yoga line polished');
check(staffCopyClean(lookupOut), 'booking lookup output has no internal leak');

const malibuSection = formatPendingManualServicesSection(malibuShape.service_records);
check(malibuSection.includes('interested, needs staff follow-up'), 'meals interested line');
check(malibuSection.includes('deferred, needs staff follow-up'), 'meals deferred line');

console.log('\nE. Payment / balance visibility');

check(regSrcIncludes('payments.balance_due'), 'registry: payments.balance_due');
check(paymentSrc.includes('balance_due_cents'), 'payment queries expose balance_due_cents');
check(execSrc.includes('resolveBalanceDueIntentKey'), 'execute resolves balance due questions');
check(lookupSrc.includes('balance_due_cents'), 'booking lookup SQL includes balance_due_cents');

function regSrcIncludes(key) {
  return fs.readFileSync(REG_FILE, 'utf8').includes(`'${key}'`);
}

console.log('\nF. Demo safety (static gates / no side effects)');

check(playgroundSrc.includes('WHATSAPP_DRY_RUN'), 'playground common documents WHATSAPP_DRY_RUN gate');
check(playgroundSrc.includes('PLAYGROUND_OFF_ENV'), 'safe baseline env documented');
check(playgroundSrc.includes('OPEN_DEMO_BOOKING_WRITES_ENABLED'), 'booking writes gate documented');
check(!pendingSrc.match(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/i), 'pending module: no writes');
check(!execSrc.includes('INSERT INTO booking_service_records'), 'execute: no service record writes');
check(!pendingSrc.match(/\bn8n\b/i), 'pending module: no n8n');
check(!pendingSrc.match(/\bstripe\b/i), 'pending module: no Stripe');
check(!pendingSrc.match(/\bwhatsapp\b.*\bsend\b/i), 'pending module: no WhatsApp send');
check(!apiSrc.includes('production') || apiSrc.includes('staging'), 'API targets staging patterns');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);

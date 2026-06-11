/**
 * Stage 34a — Pending manual services staff visibility verifier.
 *
 * Usage:
 *   npm run verify:stage34a-pending-manual-services-staff-visibility
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXEC_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-execute.js');
const PENDING_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-pending-manual-services.js');
const SHARED_FILE = path.join(__dirname, 'lib', 'staff-pending-manual-services.js');
const LOOKUP_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-booking-lookup.js');
const REG_FILE = path.join(__dirname, 'lib', 'staff-query-registry.js');
const API_FILE = path.join(__dirname, 'staff-query-api.js');
const DETAIL_FILE = path.join(__dirname, 'lib', 'staff-booking-detail-queries.js');
const PKG_FILE = path.join(ROOT, 'package.json');

let passes = 0;
let failures = 0;

function ok(msg) { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

console.log('\nverify-stage34a-pending-manual-services-staff-visibility.js  (Stage 34a)\n');

for (const f of [EXEC_FILE, PENDING_FILE, SHARED_FILE, LOOKUP_FILE, REG_FILE, API_FILE, DETAIL_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

const execSrc = fs.readFileSync(EXEC_FILE, 'utf8');
const pendingSrc = fs.readFileSync(PENDING_FILE, 'utf8');
const sharedSrc = fs.readFileSync(SHARED_FILE, 'utf8');
const lookupSrc = fs.readFileSync(LOOKUP_FILE, 'utf8');
const regSrc = fs.readFileSync(REG_FILE, 'utf8');
const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const detailSrc = fs.readFileSync(DETAIL_FILE, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

for (const f of [PENDING_FILE, SHARED_FILE, EXEC_FILE]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'ignore' });
    ok(`${path.basename(f)} passes node --check`);
  } catch (_) {
    fail(`${path.basename(f)} passes node --check`);
  }
}

check(
  pkg.scripts && pkg.scripts['verify:stage34a-pending-manual-services-staff-visibility']
    === 'node scripts/verify-stage34a-pending-manual-services-staff-visibility.js',
  'package.json verify script registered',
);

console.log('\nA. Registry intents');

check(regSrc.includes("'services.pending_manual'"), 'registry: services.pending_manual');
check(regSrc.includes("'services.pending_yoga'"), 'registry: services.pending_yoga');
check(regSrc.includes("'services.pending_meals'"), 'registry: services.pending_meals');
check(regSrc.includes('readOnly:        true'), 'registry entries remain read-only');

console.log('\nB. SQL filters (read-only, no service_date required)');

check(pendingSrc.includes("sr.source = 'luna_guest'"), 'SQL filters source=luna_guest');
check(pendingSrc.includes("sr.status = 'requested'"), 'SQL filters status=requested');
check(pendingSrc.includes("metadata->>'pending_origin' = 'luna_guest_pending'"), 'SQL filters pending_origin');
check(pendingSrc.includes("metadata->>'needs_scheduling'"), 'SQL filters needs_scheduling via metadata');
check(pendingSrc.includes('sr.service_date IS NULL'), 'SQL does not require service_date (allows NULL)');
check(!pendingSrc.match(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/i), 'pending query module has no writes');

console.log('\nC. Ask Luna wiring');

check(execSrc.includes('resolveAskLunaPendingManualServicesIntentKey'), 'execute imports pending manual resolver');
check(execSrc.includes('pendingManualIntentEarly'), 'pending manual resolved before meals/yoga');
check(execSrc.indexOf('pendingManualIntentEarly') < execSrc.indexOf('mealsYogaIntentEarly'),
  'pending manual resolver runs before meals/yoga resolver');
check(execSrc.includes("'services.pending_manual'"), 'ASK_LUNA_LOCAL_QUERY includes pending_manual');
check(execSrc.includes('PENDING_MANUAL_QUERY_KEYS'), 'clientSlug-only param path for pending queries');
check(execSrc.includes('formatAskLunaPendingManualServicesAnswer'), 'formatAnswer uses pending formatter');

console.log('\nD. Phrase routing');

const {
  resolveAskLunaPendingManualServicesIntentKey,
  formatAskLunaPendingManualServicesAnswer,
  PENDING_MANUAL_KEY,
  PENDING_YOGA_KEY,
  PENDING_MEALS_KEY,
} = require('./lib/staff-ask-luna-pending-manual-services');
const { REGISTRY_BY_KEY } = require('./lib/staff-query-registry');
const {
  isPendingManualServiceRecord,
  filterPendingManualServiceRecords,
  formatPendingManualServiceStaffLine,
} = require('./lib/staff-pending-manual-services');
const { formatAskLunaBookingLookupAnswer } = require('./lib/staff-ask-luna-booking-lookup');

const PHRASES = [
  ['Who asked for yoga?', PENDING_YOGA_KEY],
  ['Any pending yoga requests?', PENDING_YOGA_KEY],
  ['Who needs meals scheduled?', PENDING_MEALS_KEY],
  ['Show pending manual services', PENDING_MANUAL_KEY],
  ['What services need staff follow-up?', PENDING_MANUAL_KEY],
  ['services.pending_yoga', PENDING_YOGA_KEY],
  ['services.pending_meals', PENDING_MEALS_KEY],
];

for (const [phrase, expected] of PHRASES) {
  const got = resolveAskLunaPendingManualServicesIntentKey(phrase, REGISTRY_BY_KEY);
  check(got && got.intentKey === expected, `routes "${phrase}" → ${expected}`);
}

console.log('\nE. Mock fixture rows (no live DB)');

const YOGA_FIXTURE = {
  booking_code: 'WH-G27-TESTYOGA',
  guest_name: 'Test Yoga Guest',
  service_type: 'yoga',
  source: 'luna_guest',
  status: 'requested',
  service_date: null,
  metadata: {
    pending_origin: 'luna_guest_pending',
    needs_scheduling: true,
    intent_status: 'requested',
  },
  check_in: '2026-07-01',
  check_out: '2026-07-08',
  room_label: 'R2',
  created_at: '2026-06-10T10:00:00Z',
};

const MEALS_INTERESTED = {
  booking_code: 'WH-G27-TESTMEAL1',
  guest_name: 'Meals Interested Guest',
  service_type: 'meal',
  source: 'luna_guest',
  status: 'requested',
  service_date: null,
  metadata: {
    pending_origin: 'luna_guest_pending',
    needs_scheduling: true,
    intent_status: 'interested',
  },
  check_in: '2026-07-05',
  check_out: '2026-07-12',
  room_label: 'R1',
  created_at: '2026-06-09T14:00:00Z',
};

const MEALS_DEFERRED = {
  booking_code: 'WH-G27-TESTMEAL2',
  guest_name: 'Meals Deferred Guest',
  service_type: 'meal',
  source: 'luna_guest',
  status: 'requested',
  service_date: null,
  metadata: {
    pending_origin: 'luna_guest_pending',
    needs_scheduling: true,
    intent_status: 'deferred',
  },
  check_in: '2026-07-10',
  check_out: '2026-07-17',
  created_at: '2026-06-08T09:00:00Z',
};

check(isPendingManualServiceRecord(YOGA_FIXTURE), 'yoga fixture matches pending manual filter');
check(isPendingManualServiceRecord(MEALS_INTERESTED), 'meals interested fixture matches filter');
check(isPendingManualServiceRecord(MEALS_DEFERRED), 'meals deferred fixture matches filter');

const filtered = filterPendingManualServiceRecords([YOGA_FIXTURE, MEALS_INTERESTED, MEALS_DEFERRED, {
  service_type: 'yoga',
  source: 'luna_guest',
  status: 'confirmed',
  service_date: '2026-07-02',
  metadata: { pending_origin: 'luna_guest_pending', needs_scheduling: true },
}]);
check(filtered.length === 3, 'filter excludes non-pending / dated rows');

const yogaLine = formatPendingManualServiceStaffLine(YOGA_FIXTURE);
check(yogaLine.includes('Yoga') && yogaLine.includes('needs scheduling'), 'yoga staff line format');

const mealsInterestedLine = formatPendingManualServiceStaffLine(MEALS_INTERESTED);
check(mealsInterestedLine.includes('interested') && mealsInterestedLine.includes('follow-up'),
  'meals interested staff line via intent_status');

const mealsDeferredLine = formatPendingManualServiceStaffLine(MEALS_DEFERRED);
check(mealsDeferredLine.includes('deferred') && mealsDeferredLine.includes('follow-up'),
  'meals deferred staff line via intent_status');

const yogaAnswer = formatAskLunaPendingManualServicesAnswer(PENDING_YOGA_KEY, [YOGA_FIXTURE], { pendingCategory: 'yoga' });
check(yogaAnswer.includes('WH-G27-TESTYOGA'), 'yoga Ask Luna answer includes booking_code');
check(yogaAnswer.includes('needs scheduling'), 'yoga Ask Luna answer notes scheduling needed');

const mealsAnswer = formatAskLunaPendingManualServicesAnswer(PENDING_MEALS_KEY, [MEALS_INTERESTED], { pendingCategory: 'meals' });
check(mealsAnswer.includes('interested') || mealsAnswer.includes('follow-up'), 'meals Ask Luna answer reflects intent_status');

console.log('\nF. Booking lookup pending section');

check(lookupSrc.includes('pending_manual_services_summary'), 'booking lookup SQL includes pending summary');
check(lookupSrc.includes('needs scheduling'), 'booking lookup pending yoga line text');
check(lookupSrc.includes('needs staff follow-up'), 'booking lookup pending meals follow-up text');

const lookupOut = formatAskLunaBookingLookupAnswer([{
  guest_name: 'Test Yoga Guest',
  booking_code: 'WH-G27-TESTYOGA',
  guest_count: 1,
  booking_status: 'hold',
  check_in: '2026-07-01',
  check_out: '2026-07-08',
  pending_manual_services_summary: 'Yoga — requested by guest, needs scheduling',
}], {});
check(lookupOut.includes('Pending services:'), 'booking lookup output has Pending services section');
check(lookupOut.includes('Yoga — requested by guest, needs scheduling'), 'booking lookup yoga pending line');

console.log('\nG. Staff Portal booking context');

check(apiSrc.includes('filterPendingManualServiceRecords'), 'API filters pending manual service records');
check(apiSrc.includes('pending_manual_services'), 'API response includes pending_manual_services');
check(apiSrc.includes('bcRenderPendingManualServicesOverviewHtml'), 'drawer renders pending manual services');
check(detailSrc.includes('sr.metadata'), 'booking detail service records query includes metadata');

console.log('\nH. Ask Luna examples (if present)');

check(
  apiSrc.includes('data-q="Show pending manual services"'),
  'Ask Luna example chip for pending manual services',
);

console.log('\nI. Safety — no writes / external side effects');

const SAFETY_FILES = [EXEC_FILE, PENDING_FILE, API_FILE];
for (const f of SAFETY_FILES) {
  const src = fs.readFileSync(f, 'utf8');
  const slice = src.slice(src.indexOf('pending_manual') >= 0 ? src.indexOf('pending_manual') : 0,
    (src.indexOf('pending_manual') >= 0 ? src.indexOf('pending_manual') : 0) + 2500);
  check(!slice.match(/\bsendWhatsApp\b|\bwhatsapp.*send/i), `${path.basename(f)}: no WhatsApp send in pending block`);
}
check(!pendingSrc.match(/\bstripe\b/i), 'pending query: no Stripe');
check(!pendingSrc.match(/\bn8n\b/i), 'pending query: no n8n');
check(!pendingSrc.match(/\bconfirmation\b/i), 'pending query: no confirmation send');
check(!execSrc.includes('INSERT INTO booking_service_records'), 'execute: no service record writes');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);

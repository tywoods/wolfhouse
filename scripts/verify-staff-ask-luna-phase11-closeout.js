/**
 * Phase 11m — Aggregate closeout verifier for Staff Ask Luna operational queries.
 *
 * Usage:
 *   npm run verify:staff-ask-luna-phase11-closeout
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT     = __dirname;
const API_FILE = path.join(ROOT, 'staff-query-api.js');
const REG_FILE = path.join(ROOT, 'lib', 'staff-query-registry.js');
const PKG_FILE = path.join(ROOT, '..', 'package.json');
const LIB_DIR  = path.join(ROOT, 'lib');

const PHASE11_VERIFY_SCRIPTS = [
  ['verify:staff-ask-luna-balance-due', 'scripts/verify-staff-ask-luna-balance-due.js'],
  ['verify:staff-ask-luna-ai-intent-fallback', 'scripts/verify-staff-ask-luna-ai-intent-fallback.js'],
  ['verify:staff-ask-luna-ai-answer-formatter', 'scripts/verify-staff-ask-luna-ai-answer-formatter.js'],
  ['verify:staff-ask-luna-lessons', 'scripts/verify-staff-ask-luna-lessons.js'],
  ['verify:staff-ask-luna-gear', 'scripts/verify-staff-ask-luna-gear.js'],
  ['verify:staff-ask-luna-meals-yoga', 'scripts/verify-staff-ask-luna-meals-yoga.js'],
  ['verify:staff-ask-luna-arrivals-checkouts', 'scripts/verify-staff-ask-luna-arrivals-checkouts.js'],
  ['verify:staff-ask-luna-cleaning', 'scripts/verify-staff-ask-luna-cleaning.js'],
  ['verify:staff-ask-luna-booking-lookup', 'scripts/verify-staff-ask-luna-booking-lookup.js'],
  ['verify:staff-ask-luna-multi-tool-planner', 'scripts/verify-staff-ask-luna-multi-tool-planner.js'],
  ['verify:staff-ask-luna-handoffs', 'scripts/verify-staff-ask-luna-handoffs.js'],
  ['verify:staff-ask-luna-occupancy', 'scripts/verify-staff-ask-luna-occupancy.js'],
  ['verify:staff-ask-luna-free-beds', 'scripts/verify-staff-ask-luna-free-beds.js'],
];

const PHASE11_INTENT_KEYS = [
  'payments.balance_due',
  'services.lessons_today',
  'services.lessons_tomorrow',
  'services.gear_today',
  'services.gear_tomorrow',
  'services.meals_today',
  'services.meals_tomorrow',
  'services.meals_on_date',
  'services.yoga_today',
  'services.yoga_tomorrow',
  'services.yoga_on_date',
  'bookings.arrivals_today',
  'bookings.arrivals_tomorrow',
  'bookings.arrivals_on_date',
  'bookings.checkouts_today',
  'bookings.checkouts_tomorrow',
  'bookings.checkouts_on_date',
  'housekeeping.cleaning_today',
  'housekeeping.cleaning_tomorrow',
  'housekeeping.cleaning_on_date',
  'bookings.lookup',
  'handoffs.open',
  'handoffs.urgent',
  'bookings.occupancy_tonight',
  'bookings.occupancy_tomorrow_night',
  'inventory.free_beds_tonight',
  'inventory.free_beds_tomorrow_night',
];

const PHASE11_LIB_GLOB = 'staff-ask-luna-';

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

function orderBefore(block, a, b, label) {
  const ia = block.indexOf(a);
  const ib = block.indexOf(b);
  check(ia >= 0 && ib >= 0 && ia < ib, label);
}

function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

function hasWriteSql(src) {
  return /\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b/i.test(src);
}

function hasForbiddenIntegrations(src) {
  const body = stripJsComments(src);
  return /\b(stripe\.com|graph\.facebook|n8n\.|npm run deploy|run-migration)\b/i.test(body)
    || /\b(stripe_secret|whatsapp_send|n8n_webhook)\b/i.test(body);
}

console.log('\nverify-staff-ask-luna-phase11-closeout.js  (Phase 11m)\n');

for (const f of [API_FILE, REG_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const regSrc = fs.readFileSync(REG_FILE, 'utf8');
const pkg    = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

try {
  execSync(`node --check "${path.join(ROOT, 'verify-staff-ask-luna-phase11-closeout.js')}"`, { stdio: 'ignore' });
  ok('closeout verifier passes node --check');
} catch (_) {
  fail('closeout verifier passes node --check');
}

console.log('\nA. Phase 11 npm verifier scripts');

check(
  pkg.scripts && pkg.scripts['verify:staff-ask-luna-phase11-closeout']
    === 'node scripts/verify-staff-ask-luna-phase11-closeout.js',
  'package.json closeout script registered',
);

for (const [scriptKey, relPath] of PHASE11_VERIFY_SCRIPTS) {
  const expected = `node ${relPath}`;
  check(pkg.scripts && pkg.scripts[scriptKey] === expected, `package.json ${scriptKey}`);
  check(fs.existsSync(path.join(ROOT, '..', relPath)), `file exists ${relPath}`);
}

console.log('\nB. Registry — Phase 11 intent keys');

const { REGISTRY_BY_KEY, getEntry } = require('./lib/staff-query-registry');

for (const key of PHASE11_INTENT_KEYS) {
  check(regSrc.includes(`'${key}'`), `registry documents ${key}`);
  check(REGISTRY_BY_KEY.has(key), `registry has ${key}`);
}

console.log('\nC. Deterministic routing order (resolveNaturalLanguageIntent)');

const natStart = apiSrc.indexOf('function resolveNaturalLanguageIntent(question)');
const natEnd   = apiSrc.indexOf('async function resolveAskLunaIntent(question)', natStart);
const natBlock = apiSrc.slice(natStart, natEnd);

orderBefore(natBlock, 'resolveAskLunaLessonsIntentKey', 'resolveAskLunaGearIntentKey',
  'lessons before gear');
orderBefore(natBlock, 'resolveAskLunaGearIntentKey', 'resolveAskLunaMealsYogaIntentKey',
  'gear before meals/yoga');
orderBefore(natBlock, 'resolveAskLunaMealsYogaIntentKey', 'resolveAskLunaBookingLookupIntentKey',
  'meals/yoga before booking lookup');
orderBefore(natBlock, 'resolveAskLunaBookingLookupIntentKey', 'resolveAskLunaArrivalsCheckoutsIntentKey',
  'booking lookup before arrivals/checkouts');
orderBefore(natBlock, 'resolveAskLunaCleaningIntentKey', 'resolveAskLunaArrivalsCheckoutsIntentKey',
  'cleaning before arrivals/checkouts');
orderBefore(natBlock, 'resolveAskLunaOccupancyIntentKey', 'resolveAskLunaArrivalsCheckoutsIntentKey',
  'occupancy before arrivals/checkouts');
orderBefore(natBlock, 'resolveAskLunaOccupancyIntentKey', 'resolveAskLunaFreeBedsIntentKey',
  'occupancy before free beds');
orderBefore(natBlock, 'resolveAskLunaFreeBedsIntentKey', 'resolveAskLunaArrivalsCheckoutsIntentKey',
  'free beds before arrivals/checkouts');
orderBefore(natBlock, 'resolveAskLunaMealsYogaIntentKey', 'resolveAskLunaServiceIntent',
  'meals/yoga early resolver before legacy service router');
orderBefore(natBlock, 'resolveAskLunaGearIntentKey', 'resolveAskLunaServiceIntent',
  'gear early resolver before legacy wetsuit/board service router');

const intentStart = apiSrc.indexOf('async function resolveAskLunaIntent(question)');
const intentEnd   = apiSrc.indexOf('function askLunaIntentMeta(', intentStart);
const intentBlock = apiSrc.slice(intentStart, intentEnd);

orderBefore(intentBlock, 'resolveNaturalLanguageIntent(question)', 'resolveOpsPlannerIntent(question)',
  'deterministic resolver before ops planner');
orderBefore(intentBlock, 'resolveOpsPlannerIntent(question)', 'classifyAskLunaIntentWithAi(question)',
  'ops planner before AI intent fallback');

console.log('\nD. Routing smoke — occupancy vs free beds');

const { resolveAskLunaOccupancyIntentKey } = require('./lib/staff-ask-luna-occupancy');
const { resolveAskLunaFreeBedsIntentKey } = require('./lib/staff-ask-luna-free-beds');
const REF = new Date('2026-06-04T12:00:00Z');

const staying = resolveAskLunaOccupancyIntentKey('Who is staying tonight?', REGISTRY_BY_KEY, REF);
check(staying && staying.intentKey === 'bookings.occupancy_tonight', 'staying tonight → occupancy');
const notFree = resolveAskLunaFreeBedsIntentKey('Who is staying tonight?', REGISTRY_BY_KEY, REF);
check(notFree === null, 'free beds does not hijack staying tonight');

console.log('\nE. AI classifier & formatter boundaries');

const aiSrc  = fs.readFileSync(path.join(LIB_DIR, 'staff-ask-luna-ai-intent.js'), 'utf8');
const fmtSrc = fs.readFileSync(path.join(LIB_DIR, 'staff-ask-luna-ai-answer-format.js'), 'utf8');

check(aiSrc.includes('getAskLunaAiAllowedIntents'), 'AI allowed intents from registry');
check(aiSrc.includes('readOnly === true'), 'AI classifier filters read-only registry entries');
check(aiSrc.includes('Do not generate SQL'), 'AI classifier forbids SQL');
check(aiSrc.includes('isAskLunaAiEnabled'), 'AI classifier gated by env');
check(fmtSrc.includes('presentation only') || fmtSrc.includes('Presentation only'),
  'AI answer formatter documented as presentation-only');
check(fmtSrc.includes('buildBalanceDueFormatterSummary'), 'formatter uses structured summary');
check(fmtSrc.includes('formatAskLunaBalanceDueAnswer'), 'formatter falls back to deterministic');
check(!hasWriteSql(fmtSrc), 'formatter lib has no write SQL');

console.log('\nF. Multi-tool ops planner allowlist');

const {
  OPS_PLANNER_TOOL_ALLOWLIST,
  detectOpsPlannerRequest,
} = require('./lib/staff-ask-luna-multi-tool-planner');

check(OPS_PLANNER_TOOL_ALLOWLIST.size === 15, 'ops planner allowlist has 15 intents');
for (const key of OPS_PLANNER_TOOL_ALLOWLIST) {
  const entry = getEntry(key);
  check(entry && entry.readOnly === true, `allowlist intent read-only: ${key}`);
}
check(![...OPS_PLANNER_TOOL_ALLOWLIST].some((k) => k.startsWith('inventory.')), 'allowlist has no inventory snapshots');
check(!OPS_PLANNER_TOOL_ALLOWLIST.has('bookings.lookup'), 'allowlist excludes booking lookup');
check(!OPS_PLANNER_TOOL_ALLOWLIST.has('handoffs.open'), 'allowlist excludes handoffs.open');

const fri = detectOpsPlannerRequest('What do I need to know for Friday?');
check(fri && fri.rejected, 'ops planner rejects arbitrary weekday (Friday)');

console.log('\nG. Free beds snapshot-only');

const fbSrc = fs.readFileSync(path.join(LIB_DIR, 'staff-ask-luna-free-beds.js'), 'utf8');
check(fbSrc.includes('Snapshot only'), 'free beds snapshot caveat');
check(fbSrc.includes('booking flow'), 'free beds cites booking flow');
check(!hasWriteSql(fbSrc), 'free beds lib has no write SQL');
check(fbSrc.includes('FROM beds'), 'free beds uses beds inventory');
check(fbSrc.includes('FROM bookings'), 'free beds uses bookings for occupancy');

console.log('\nH. Phase 11 libs — safety scan');

const libFiles = fs.readdirSync(LIB_DIR)
  .filter((f) => f.startsWith(PHASE11_LIB_GLOB) && f.endsWith('.js'));

check(libFiles.length >= 13, `found ${libFiles.length} staff-ask-luna-* libs`);

for (const file of libFiles) {
  const src = fs.readFileSync(path.join(LIB_DIR, file), 'utf8');
  const label = file;
  check(!hasWriteSql(src), `${label}: no write SQL`);
  check(!hasForbiddenIntegrations(src), `${label}: no live integrations`);
  check(!src.match(/FROM\s+messages|message_log|chat_log/i), `${label}: no chat log tables`);
}

console.log('\nI. Weekday window (today/tomorrow/≤5 days)');

const mySrc = fs.readFileSync(path.join(LIB_DIR, 'staff-ask-luna-meals-yoga.js'), 'utf8');
check(mySrc.includes('MEALS_YOGA_WEEKDAY_MAX = 5'), 'meals/yoga weekday max 5 days');
check(mySrc.includes('resolveAskLunaWeekdayWithin5Days'), 'meals/yoga weekday resolver');

const acSrc = fs.readFileSync(path.join(LIB_DIR, 'staff-ask-luna-arrivals-checkouts.js'), 'utf8');
check(acSrc.includes('resolveAskLunaWeekdayWithin5Days'), 'arrivals/checkouts reuses ≤5-day weekday');

const clSrc = fs.readFileSync(path.join(LIB_DIR, 'staff-ask-luna-cleaning.js'), 'utf8');
check(clSrc.includes('resolveAskLunaWeekdayWithin5Days'), 'cleaning reuses ≤5-day weekday');

console.log('\nJ. Balance due payment rules & service records');

const balSrc = fs.readFileSync(path.join(LIB_DIR, 'staff-ask-luna-balance-due.js'), 'utf8');
const { isPaidPaymentStatus } = require('./lib/staff-ask-luna-balance-due');

check(balSrc.includes('booking_service_records'), 'balance due uses booking_service_records');
check(balSrc.includes('amount_due_cents'), 'balance due includes service amount_due_cents');
check(isPaidPaymentStatus('paid'), 'paid counts as paid');
check(isPaidPaymentStatus('succeeded'), 'succeeded counts as paid');
check(!isPaidPaymentStatus('pending'), 'pending is not paid');
check(!isPaidPaymentStatus('payment_link_created'), 'payment_link_created is not paid');
check(balSrc.includes("'checkout_created'"), 'checkout_created tracked as unpaid link status');
check(balSrc.includes("'payment_link_created'"), 'payment_link_created tracked as unpaid link status');
check(balSrc.includes("'draft'"), 'draft tracked as unpaid link status');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);

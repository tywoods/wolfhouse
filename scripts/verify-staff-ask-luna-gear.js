/**
 * Phase 11c — Verifier for Staff Ask Luna surf gear today/tomorrow query.
 *
 * Usage:
 *   npm run verify:staff-ask-luna-gear
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const GEAR_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-gear.js');
const REG_FILE = path.join(__dirname, 'lib', 'staff-query-registry.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

console.log('\nverify-staff-ask-luna-gear.js  (Phase 11c)\n');

for (const f of [API_FILE, GEAR_FILE, REG_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const gearSrc = fs.readFileSync(GEAR_FILE, 'utf8');
const regSrc = fs.readFileSync(REG_FILE, 'utf8');
const pkg    = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

try {
  execSync(`node --check "${GEAR_FILE}"`, { stdio: 'ignore' });
  ok('staff-ask-luna-gear.js passes node --check');
} catch (_) {
  fail('staff-ask-luna-gear.js passes node --check');
}

check(
  pkg.scripts && pkg.scripts['verify:staff-ask-luna-gear']
    === 'node scripts/verify-staff-ask-luna-gear.js',
  'package.json verify script',
);

console.log('\nA. Registry');

check(regSrc.includes("'services.gear_today'"), 'registry: services.gear_today');
check(regSrc.includes("'services.gear_tomorrow'"), 'registry: services.gear_tomorrow');
check(regSrc.includes('getAskLunaGearOnDateQuery'), 'registry uses getAskLunaGearOnDateQuery');

console.log('\nB. Query — structured data, exclusions, combos');

check(gearSrc.includes('booking_service_records'), 'SQL uses booking_service_records');
check(gearSrc.includes('INNER JOIN bookings'), 'SQL joins bookings');
check(gearSrc.includes('booking_beds'), 'SQL uses booking_beds for room/bed');
check(
  gearSrc.includes("service_type IN ('wetsuit', 'surfboard')"),
  'SQL filters wetsuit and surfboard types',
);
check(gearSrc.includes("status <> 'cancelled'"), 'SQL excludes cancelled service records');
check(
  gearSrc.includes("'cancelled', 'canceled', 'expired', 'hold'"),
  'SQL excludes cancelled/canceled/expired/hold bookings',
);
check(gearSrc.includes('countGearTotals'), 'combo/totals count boards and wetsuits separately');
check(gearSrc.includes('wetsuit_soft') || gearSrc.includes('soft_top'), 'board label from combo/soft metadata');
check(
  !gearSrc.match(/FROM\s+conversations|message_log|chat_log/i),
  'no chat/conversation log queries',
);

console.log('\nC. Ask Luna wiring');

check(apiSrc.includes('resolveAskLunaGearIntentKey'), 'API uses gear intent resolver');
check(apiSrc.includes("'services.gear_today'"), 'ASK_LUNA_LOCAL_QUERY gear_today');
check(apiSrc.includes('formatAskLunaGearAnswer'), 'formatAnswer uses formatAskLunaGearAnswer');
check(apiSrc.includes('gearIntentEarly'), 'gear resolved before generic registry passthrough');

const gearLocalStart = apiSrc.indexOf("'services.gear_today':");
const gearFmtStart   = apiSrc.indexOf("case 'services.gear_today':");
const gearBlock = gearLocalStart > -1 && gearFmtStart > -1
  ? apiSrc.slice(gearLocalStart, gearFmtStart + 120)
  : '';
check(
  gearBlock.includes('getAskLunaGearOnDateQuery') && gearBlock.includes('formatAskLunaGearAnswer'),
  'gear use local read-only query + formatter',
);
check(
  apiSrc.includes('ASK_LUNA_LOCAL_QUERY[intentKey]'),
  'Ask Luna local query path for gear',
);
check(
  !gearBlock.match(/\b(INSERT|UPDATE|DELETE)\b/) && !gearBlock.match(/\b(stripe|n8n)\b/i),
  'gear wiring has no writes/Stripe/n8n',
);

console.log('\nD. Phrase routing');

const {
  resolveAskLunaGearIntentKey,
  formatAskLunaGearAnswer,
  countGearTotals,
  matchesGearTodayQuestion,
  matchesGearTomorrowQuestion,
} = require('./lib/staff-ask-luna-gear');
const { REGISTRY_BY_KEY } = require('./lib/staff-query-registry');

const PHRASES = [
  ['Who needs a board today?', 'services.gear_today'],
  ['Who needs a surfboard today?', 'services.gear_today'],
  ['Who needs a wetsuit today?', 'services.gear_today'],
  ['Who needs boards tomorrow?', 'services.gear_tomorrow'],
  ['Who needs wetsuits tomorrow?', 'services.gear_tomorrow'],
  ['What gear do we need today?', 'services.gear_today'],
  ['What surf gear is needed tomorrow?', 'services.gear_tomorrow'],
  ['How many boards today?', 'services.gear_today'],
  ['How many wetsuits tomorrow?', 'services.gear_tomorrow'],
  ['services.gear_today', 'services.gear_today'],
  ['services.gear_tomorrow', 'services.gear_tomorrow'],
];

for (const [phrase, expected] of PHRASES) {
  const got = resolveAskLunaGearIntentKey(phrase, REGISTRY_BY_KEY);
  check(got && got.intentKey === expected, `routes "${phrase}" → ${expected}`);
  check(got && got.extraParams && got.extraParams.date, `date param for "${phrase}"`);
}

check(matchesGearTodayQuestion('Who needs a wetsuit today?'), 'matchesGearTodayQuestion');
check(matchesGearTomorrowQuestion('Who needs wetsuits tomorrow?'), 'matchesGearTomorrowQuestion');

console.log('\nE. Response format');

const empty = formatAskLunaGearAnswer([], { dateLabel: 'today' });
check(empty.includes('No surf gear is currently booked for today'), 'empty today message');

const emptyTm = formatAskLunaGearAnswer([], { dateLabel: 'tomorrow' });
check(emptyTm.includes('No surf gear is currently booked for tomorrow'), 'empty tomorrow message');

const comboRows = [
  {
    guest_name: 'Jimmy',
    booking_code: 'WH-260615-ABCD',
    service_type: 'wetsuit',
    service_date: '2026-06-15',
    quantity: 1,
    bed_summary: 'DEMO-R1',
    metadata: { source_quote_line_code: 'wetsuit_soft_top_combo' },
  },
  {
    guest_name: 'Jimmy',
    booking_code: 'WH-260615-ABCD',
    service_type: 'surfboard',
    service_date: '2026-06-15',
    quantity: 1,
    bed_summary: 'DEMO-R1',
    metadata: { source_quote_line_code: 'wetsuit_soft_top_combo' },
  },
  {
    guest_name: 'Anna',
    booking_code: 'WH-260616-EFGH',
    service_type: 'surfboard',
    service_date: '2026-06-15',
    quantity: 1,
    bed_summary: 'DEMO-R2-B1',
    metadata: { source_quote_line_code: 'hard_board_rental' },
  },
];

const comboTotals = countGearTotals(comboRows);
check(comboTotals.totalBoards === 2 && comboTotals.totalWetsuits === 1,
  'combo rows count both board and wetsuit in totals');

const sample = formatAskLunaGearAnswer(comboRows, { dateLabel: 'today' });
check(sample.includes('2 board'), 'includes total boards');
check(sample.includes('1 wetsuit'), 'includes total wetsuits');
check(sample.includes('Jimmy'), 'includes guest name');
check(sample.includes('WH-260615-ABCD'), 'includes booking code');
check(sample.includes('DEMO-R1'), 'includes room/bed');
check(sample.includes('soft board'), 'includes gear label');
check(sample.includes('Totals:'), 'includes totals footer');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);

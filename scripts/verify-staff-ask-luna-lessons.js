/**
 * Phase 11b — Verifier for Staff Ask Luna surf lessons today/tomorrow query.
 *
 * Usage:
 *   npm run verify:staff-ask-luna-lessons
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const LES_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-lessons.js');
const REG_FILE = path.join(__dirname, 'lib', 'staff-query-registry.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

console.log('\nverify-staff-ask-luna-lessons.js  (Phase 11b)\n');

for (const f of [API_FILE, LES_FILE, REG_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const lesSrc = fs.readFileSync(LES_FILE, 'utf8');
const regSrc = fs.readFileSync(REG_FILE, 'utf8');
const pkg    = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

try {
  execSync(`node --check "${LES_FILE}"`, { stdio: 'ignore' });
  ok('staff-ask-luna-lessons.js passes node --check');
} catch (_) {
  fail('staff-ask-luna-lessons.js passes node --check');
}

check(
  pkg.scripts && pkg.scripts['verify:staff-ask-luna-lessons']
    === 'node scripts/verify-staff-ask-luna-lessons.js',
  'package.json verify script',
);

console.log('\nA. Registry');

check(regSrc.includes("'services.lessons_today'"), 'registry: services.lessons_today');
check(regSrc.includes("'services.lessons_tomorrow'"), 'registry: services.lessons_tomorrow');
check(regSrc.includes('getAskLunaLessonsOnDateQuery'), 'registry uses getAskLunaLessonsOnDateQuery');

console.log('\nB. Query — structured data, exclusions');

check(lesSrc.includes('booking_service_records'), 'SQL uses booking_service_records');
check(lesSrc.includes('INNER JOIN bookings'), 'SQL joins bookings');
check(lesSrc.includes('booking_beds'), 'SQL uses booking_beds for room/bed');
check(lesSrc.includes("service_type = 'surf_lesson'"), 'SQL filters surf_lesson service type');
check(lesSrc.includes("status <> 'cancelled'"), 'SQL excludes cancelled service records');
check(
  lesSrc.includes("'cancelled', 'canceled', 'expired', 'hold'"),
  'SQL excludes cancelled/canceled/expired/hold bookings',
);
check(
  !lesSrc.match(/FROM\s+conversations|message_log|chat_log/i),
  'no chat/conversation log queries',
);

console.log('\nC. Ask Luna wiring');

check(apiSrc.includes('resolveAskLunaLessonsIntentKey'), 'API uses lessons intent resolver');
check(apiSrc.includes("'services.lessons_today'"), 'ASK_LUNA_LOCAL_QUERY lessons_today');
check(apiSrc.includes('formatAskLunaLessonsAnswer'), 'formatAnswer uses formatAskLunaLessonsAnswer');
check(apiSrc.includes('lessonsIntentEarly'), 'lessons resolved before generic registry passthrough');

const lesLocalStart = apiSrc.indexOf("'services.lessons_today':");
const lesFmtStart   = apiSrc.indexOf("case 'services.lessons_today':");
const lesBlock = lesLocalStart > -1 && lesFmtStart > -1
  ? apiSrc.slice(lesLocalStart, lesFmtStart + 120)
  : '';
check(
  lesBlock.includes('getAskLunaLessonsOnDateQuery') && lesBlock.includes('formatAskLunaLessonsAnswer'),
  'lessons use local read-only query + formatter',
);
check(
  apiSrc.includes('ASK_LUNA_LOCAL_QUERY[intentKey]'),
  'Ask Luna local query path for lessons',
);
check(
  !lesBlock.match(/\b(INSERT|UPDATE|DELETE)\b/) && !lesBlock.match(/\b(stripe|n8n)\b/i),
  'lessons wiring has no writes/Stripe/n8n',
);

console.log('\nD. Phrase routing');

const {
  resolveAskLunaLessonsIntentKey,
  formatAskLunaLessonsAnswer,
  matchesLessonsTodayQuestion,
  matchesLessonsTomorrowQuestion,
} = require('./lib/staff-ask-luna-lessons');
const { REGISTRY_BY_KEY } = require('./lib/staff-query-registry');

const PHRASES = [
  ['Who has lessons today?', 'services.lessons_today'],
  ['Who has surf lessons today?', 'services.lessons_today'],
  ['Who has lessons tomorrow?', 'services.lessons_tomorrow'],
  ['Who is booked for lessons tomorrow?', 'services.lessons_tomorrow'],
  ['How many lessons today?', 'services.lessons_today'],
  ['Show lessons today', 'services.lessons_today'],
  ['services.lessons_today', 'services.lessons_today'],
  ['services.lessons_tomorrow', 'services.lessons_tomorrow'],
];

for (const [phrase, expected] of PHRASES) {
  const got = resolveAskLunaLessonsIntentKey(phrase, REGISTRY_BY_KEY);
  check(got && got.intentKey === expected, `routes "${phrase}" → ${expected}`);
  check(got && got.extraParams && got.extraParams.date, `date param for "${phrase}"`);
}

check(matchesLessonsTodayQuestion('Who has lessons today?'), 'matchesLessonsTodayQuestion');
check(matchesLessonsTomorrowQuestion('Who has lessons tomorrow?'), 'matchesLessonsTomorrowQuestion');

console.log('\nE. Response format');

const empty = formatAskLunaLessonsAnswer([], { dateLabel: 'today' });
check(empty.includes('No surf lessons are currently booked for today'), 'empty today message');

const emptyTm = formatAskLunaLessonsAnswer([], { dateLabel: 'tomorrow' });
check(emptyTm.includes('No surf lessons are currently booked for tomorrow'), 'empty tomorrow message');

const sample = formatAskLunaLessonsAnswer([
  {
    guest_name: 'Jimmy',
    booking_code: 'WH-260615-ABCD',
    service_date: '2026-06-15',
    quantity: 1,
    bed_summary: 'DEMO-R1',
    payment_status: 'paid',
    service_status: 'confirmed',
  },
  {
    guest_name: 'Anna',
    booking_code: 'WH-260616-EFGH',
    service_date: '2026-06-15',
    quantity: 2,
    bed_summary: 'DEMO-R2-B1',
    payment_status: 'pending',
    service_status: 'confirmed',
  },
], { dateLabel: 'today' });

check(sample.includes('3 surf lesson'), 'includes total lesson count');
check(sample.includes('Jimmy'), 'includes guest name');
check(sample.includes('WH-260615-ABCD'), 'includes booking code');
check(sample.includes('DEMO-R1'), 'includes room/bed');
check(sample.includes('Total: 3 lesson'), 'includes total across bookings');
check(sample.includes('2 booking'), 'includes booking count');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);

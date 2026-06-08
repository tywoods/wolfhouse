/**
 * Ask Luna example-question chips — static UI copy verifier.
 *
 * Usage:
 *   npm run verify:staff-ask-luna-examples-ui
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const API_PATH = path.join(__dirname, 'staff-query-api.js');
const PKG_PATH = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function pass(msg) { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, okMsg, failMsg) { if (cond) pass(okMsg); else fail(failMsg || okMsg); }
function has(src, re) { return re.test(src); }
function lacks(src, re) { return !re.test(src); }

console.log('\nverify-staff-ask-luna-examples-ui.js\n');

if (!fs.existsSync(API_PATH)) { fail('staff-query-api.js missing'); process.exit(1); }
const src = fs.readFileSync(API_PATH, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

check(
  pkg.scripts && pkg.scripts['verify:staff-ask-luna-examples-ui']
    === 'node scripts/verify-staff-ask-luna-examples-ui.js',
  'package.json script registered',
);

const alStart = src.indexOf('<!-- ── Command Center tab');
const alEnd   = src.indexOf('</div><!-- /tab-ask-luna -->', alStart);
check(alStart >= 0 && alEnd > alStart, 'Ask Luna panel slice found');
const alPanel = alStart >= 0 && alEnd > alStart ? src.slice(alStart, alEnd) : '';

const examples = [
  "What's happening today?",
  'What should I prepare for tomorrow?',
  'Who is checking in today?',
  'Who is checking out tomorrow?',
  'What rooms need cleaning today?',
  'Who is staying tonight?',
  'Which beds are free tonight?',
  'Who has surf lessons today?',
  'What gear do we need tomorrow?',
  'Who has meals today?',
  'How many people are in yoga on Friday?',
  'Which conversations need staff reply?',
  "Show Jimmy's booking",
  'Who is in R1?',
  'Which bookings need payment follow-up?',
];

for (const ex of examples) {
  check(alPanel.includes('data-q="' + ex + '"'), 'example: ' + ex);
}

const firstChip = alPanel.match(/class="al-example-chip"[^>]*data-q="([^"]+)"/);
check(firstChip && firstChip[1] === "What's happening today?", 'first example is ops summary');

const opsIdx = alPanel.indexOf("data-q=\"What's happening today?\"");
const payIdx = alPanel.indexOf('data-q="Which bookings need payment follow-up?"');
check(opsIdx >= 0 && payIdx > opsIdx, 'ops example before payment follow-up');

for (const re of [/Who owes money/i, /Who still owes money/i, /Any payment links pending/i]) {
  check(lacks(alPanel, re), 'no tacky phrase: ' + re.source);
}

check(has(alPanel, /id="al-examples"/), 'al-examples container');
check(has(src, /function alPickExample/), 'alPickExample handler');
check(lacks(alPanel, /placeholder="Who still owes money/i), 'placeholder not money-first');

const categories = [
  [/What's happening today/, 'ops summary'],
  [/checking in today/, 'arrivals'],
  [/checking out tomorrow/, 'checkouts'],
  [/cleaning today/, 'cleaning'],
  [/staying tonight/, 'occupancy'],
  [/beds are free tonight/, 'free beds'],
  [/surf lessons today/, 'lessons'],
  [/gear do we need tomorrow/, 'gear'],
  [/meals today/, 'meals'],
  [/yoga on Friday/, 'yoga'],
  [/conversations need staff reply/, 'handoffs'],
  [/Jimmy's booking/, 'lookup guest'],
  [/Who is in R1/, 'lookup room'],
  [/payment follow-up/, 'soft payment follow-up'],
];
for (const [re, label] of categories) {
  check(has(alPanel, re), 'category present: ' + label);
}

const { resolveBalanceDueIntentKey } = require('./lib/staff-ask-luna-balance-due');
const { REGISTRY_BY_KEY } = require('./lib/staff-query-registry');
check(
  resolveBalanceDueIntentKey('Which bookings need payment follow-up?', REGISTRY_BY_KEY)
    === 'payments.balance_due',
  'UI example chip routes to payments.balance_due',
);

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);

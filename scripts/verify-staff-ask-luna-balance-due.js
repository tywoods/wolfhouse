/**
 * Phase 11a — Static verifier for Staff Ask Luna balance-due query.
 *
 * Usage:
 *   npm run verify:staff-ask-luna-balance-due
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_FILE  = path.join(__dirname, 'staff-query-api.js');
const LIB_FILE  = path.join(__dirname, 'lib', 'staff-ask-luna-balance-due.js');
const PAY_FILE  = path.join(__dirname, 'lib', 'staff-payment-queries.js');
const PKG_FILE  = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

console.log('\nverify-staff-ask-luna-balance-due.js  (Phase 11a)\n');

for (const f of [API_FILE, LIB_FILE, PAY_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const libSrc = fs.readFileSync(LIB_FILE, 'utf8');
const paySrc = fs.readFileSync(PAY_FILE, 'utf8');
const pkg    = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

try {
  execSync(`node --check "${LIB_FILE}"`, { stdio: 'ignore' });
  ok('staff-ask-luna-balance-due.js passes node --check');
} catch (_) {
  fail('staff-ask-luna-balance-due.js passes node --check');
}

console.log('\nA. Intent registration and phrases');

check(
  pkg.scripts && pkg.scripts['verify:staff-ask-luna-balance-due'] === 'node scripts/verify-staff-ask-luna-balance-due.js',
  'package.json verify:staff-ask-luna-balance-due script',
);

check(libSrc.includes('who\\s+owes?\\s+money'), 'phrase: who owes money');
check(libSrc.includes('outstanding\\s+balances?'), 'phrase: outstanding balances');
check(libSrc.includes('unpaid\\s+balance'), 'phrase: unpaid balance');
check(libSrc.includes('balance\\s+due'), 'phrase: balance due');
check(libSrc.includes('still\\s+needs?\\s+to\\s+pay'), 'phrase: who still needs to pay');

check(apiSrc.includes("intentKey === 'payments.balance_due'"), 'Ask Luna routes payments.balance_due');
check(apiSrc.includes('computeBalanceDueRows'), 'Ask Luna uses computeBalanceDueRows');
check(apiSrc.includes('matchesBalanceDueQuestion'), 'resolver uses matchesBalanceDueQuestion');

const resolverStart = apiSrc.indexOf('function resolveNaturalLanguageIntent(');
const resolverEnd   = apiSrc.indexOf('\nfunction formatAnswer', resolverStart);
const resolver      = resolverStart > -1
  ? apiSrc.slice(resolverStart, resolverEnd > -1 ? resolverEnd : resolverStart + 8000)
  : '';
check(
  resolver.includes('resolveBalanceDueIntentKey') && resolver.includes('balanceDueIntent'),
  'resolveNaturalLanguageIntent maps balance-due via resolveBalanceDueIntentKey',
);

console.log('\nB. Structured data sources (no chat logs)');

check(libSrc.includes('FROM bookings b'), 'query uses bookings');
check(libSrc.includes('FROM payments p'), 'query uses payments');
check(libSrc.includes('booking_service_records'), 'query uses booking_service_records');
check(libSrc.includes('booking_beds'), 'query uses booking_beds');
check(
  !libSrc.match(/conversation|message_log|chat_log/i),
  'balance-due lib does not reference chat/conversation logs',
);

console.log('\nC. Balance rules');

check(libSrc.includes("NOT IN ('cancelled', 'canceled', 'expired', 'hold')"), 'excludes cancelled/canceled/expired/hold');
check(libSrc.includes("IN ('paid', 'succeeded')") || libSrc.includes("'paid'") && libSrc.includes('succeeded'),
  'paid rows: paid/succeeded only');
check(libSrc.includes('checkout_created') || libSrc.includes('ACTIVE_LINK_STATUSES'),
  'unpaid link statuses tracked separately from paid');
check(!libSrc.includes("status = 'paid'") || libSrc.includes('isPaidPaymentStatus'),
  'paid filter via isPaidPaymentStatus helper');
check(libSrc.includes('amount_due_cents'), 'service records amount_due_cents in balance path');
check(libSrc.includes('invoice_total_cents'), 'invoice_total_cents computed');
check(libSrc.includes('balance_due_cents'), 'balance_due_cents computed');

console.log('\nD. Response format');

check(libSrc.includes('People with balance due'), 'non-empty header');
check(libSrc.includes('Total outstanding'), 'total outstanding line');
check(libSrc.includes('No active bookings currently have a balance due'), 'empty-state message');
check(libSrc.includes('payment_state_label'), 'payment state label on rows');
check(libSrc.includes('Deposit paid'), 'deposit paid state');
check(libSrc.includes('Link sent'), 'link sent state');
check(libSrc.includes('No active link'), 'no active link state');

console.log('\nE. Safety — read-only, no integrations');

const askBlockStart = apiSrc.indexOf('async function handleAskLuna(');
const askBlockEnd   = apiSrc.indexOf('function readBody(req)', askBlockStart);
const askBlock      = askBlockStart > -1
  ? apiSrc.slice(askBlockStart, askBlockEnd > -1 ? askBlockEnd : askBlockStart + 15000)
  : '';

check(askBlock.includes('no_write_performed: true'), 'Ask Luna marks no_write_performed');
check(/read_only:\s*true/.test(askBlock), 'Ask Luna marks read_only');
check(
  !askBlock.slice(askBlock.indexOf("intentKey === 'payments.balance_due'")).match(/\b(INSERT|UPDATE|DELETE|stripe|whatsapp|n8n)\b/i),
  'balance-due branch has no writes/Stripe/WhatsApp/n8n',
);
check(paySrc.includes('staff-ask-luna-balance-due'), 'staff-payment-queries delegates getBalanceDueQuery');

console.log('\nF. Runtime smoke (phrase routing + formatter)');

const {
  matchesBalanceDueQuestion,
  resolveBalanceDueIntentKey,
  formatAskLunaBalanceDueAnswer,
  isPaidPaymentStatus,
  invoicePaidBalance,
} = require('./lib/staff-ask-luna-balance-due');
const { REGISTRY_BY_KEY } = require('./lib/staff-query-registry');

const REQUIRED_BALANCE_DUE_PHRASES = [
  'Who owes money?',
  'Who still needs to pay?',
  'Outstanding balances',
  'Who has unpaid balance?',
  'payments.balance_due',
  'unpaid balances',
  'balance due',
  'who has outstanding balance',
  'who has an outstanding balance',
];

for (const p of REQUIRED_BALANCE_DUE_PHRASES) {
  check(
    resolveBalanceDueIntentKey(p, REGISTRY_BY_KEY) === 'payments.balance_due',
    `routes to payments.balance_due: ${p}`,
  );
}

console.log('\nG. Ask Luna resolver routing (end-to-end)');

const apiSrcForRoute = fs.readFileSync(API_FILE, 'utf8');
const routeStart = apiSrcForRoute.indexOf('function normalizeAskLunaQuestion');
const routeLocal = apiSrcForRoute.indexOf('const ASK_LUNA_LOCAL_QUERY', routeStart);
const routeResolver = apiSrcForRoute.indexOf('function resolveNaturalLanguageIntent(', routeStart);
const routeEnd = apiSrcForRoute.indexOf('\nfunction formatAnswer', routeStart);
const routeChunk = [
  apiSrcForRoute.match(/const ASK_LUNA_WEEKDAYS = [^;]+;/)?.[0],
  apiSrcForRoute.match(/const ASK_LUNA_MONTHS = \{[\s\S]*?\};/)?.[0],
  apiSrcForRoute.match(/function askLunaIsoDateUTC[\s\S]*?\n\}/)?.[0],
  apiSrcForRoute.match(/function askLunaTodayUTC[\s\S]*?\n\}/)?.[0],
  apiSrcForRoute.slice(routeStart, routeLocal),
  apiSrcForRoute.slice(routeResolver, routeEnd),
].filter(Boolean).join('\n');

try {
  const bdLib = require('./lib/staff-ask-luna-balance-due');
  const lessonsLib = require('./lib/staff-ask-luna-lessons');
  const gearLib = require('./lib/staff-ask-luna-gear');
  const lessonsRoutingBlock = lessonsLib.getAskLunaLessonsRoutingSmokeBlock();
  const gearRoutingBlock = gearLib.getAskLunaGearRoutingSmokeBlock();
  const routeWrapped = `
    const matchesBalanceDueQuestion = ${bdLib.matchesBalanceDueQuestion.toString()};
    const normalizeBalanceDueQuestionText = ${bdLib.normalizeBalanceDueQuestionText.toString()};
    const resolveBalanceDueIntentKey = ${bdLib.resolveBalanceDueIntentKey.toString()};
    ${lessonsRoutingBlock}
    ${gearRoutingBlock}
    const BALANCE_DUE_INTENT_KEY = 'payments.balance_due';
    const require = (id) => {
      if (String(id).includes('staff-query-registry')) {
        const keys = ${JSON.stringify([...REGISTRY_BY_KEY.keys()])};
        return { REGISTRY_BY_KEY: new Map(keys.map((k) => [k, k])) };
      }
      if (String(id).includes('staff-ask-luna-balance-due')) {
        return { matchesBalanceDueQuestion, normalizeBalanceDueQuestionText, resolveBalanceDueIntentKey, BALANCE_DUE_INTENT_KEY };
      }
      if (String(id).includes('staff-ask-luna-lessons')) {
        return { resolveAskLunaLessonsIntentKey };
      }
      if (String(id).includes('staff-ask-luna-gear')) {
        return { resolveAskLunaGearIntentKey };
      }
      throw new Error('require ' + id);
    };
    ${routeChunk}
    return resolveNaturalLanguageIntent;
  `;
  const resolveIntent = new Function(routeWrapped)();
  for (const p of REQUIRED_BALANCE_DUE_PHRASES) {
    const got = resolveIntent(p);
    check(
      got && got.intentKey === 'payments.balance_due',
      `resolver routes "${p}" → payments.balance_due`,
    );
  }
} catch (e) {
  fail(`Ask Luna resolver routing smoke: ${e.message}`);
}

check(!isPaidPaymentStatus('checkout_created'), 'checkout_created is not paid');
check(!isPaidPaymentStatus('payment_link_created'), 'payment_link_created is not paid');
check(!isPaidPaymentStatus('pending'), 'pending is not paid');
check(isPaidPaymentStatus('paid'), 'paid counts as paid');
check(isPaidPaymentStatus('succeeded'), 'succeeded counts as paid');

const ledger = invoicePaidBalance(
  { total_amount_cents: 50000, deposit_required_cents: 10000, metadata: {} },
  5000,
  20000,
);
check(ledger.balance_due_cents === 30000, 'balance = invoice total - paid (add-ons in booking total)');

const emptyAnswer = formatAskLunaBalanceDueAnswer([]);
check(emptyAnswer.includes('No active bookings currently have a balance due'), 'formatter empty case');

const sampleAnswer = formatAskLunaBalanceDueAnswer([{
  guest_name: 'Jimmy',
  booking_code: 'DEMO-R1',
  check_in: '2026-06-19',
  check_out: '2026-06-25',
  bed_summary: 'DEMO-R1',
  balance_due_cents: 30000,
  payment_state_label: 'Deposit paid / Link sent',
}]);
check(sampleAnswer.includes('Jimmy'), 'sample answer includes guest');
check(sampleAnswer.includes('€300'), 'sample answer includes balance');
check(sampleAnswer.includes('Total outstanding'), 'sample answer includes total');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);

/**
 * Phase 11h — Verifier for Staff Ask Luna multi-tool ops planner.
 *
 * Usage:
 *   npm run verify:staff-ask-luna-multi-tool-planner
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PL_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-multi-tool-planner.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

console.log('\nverify-staff-ask-luna-multi-tool-planner.js  (Phase 11h)\n');

for (const f of [API_FILE, PL_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const plSrc = fs.readFileSync(PL_FILE, 'utf8');
const pkg    = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

try {
  execSync(`node --check "${PL_FILE}"`, { stdio: 'ignore' });
  ok('staff-ask-luna-multi-tool-planner.js passes node --check');
} catch (_) {
  fail('staff-ask-luna-multi-tool-planner.js passes node --check');
}

check(
  pkg.scripts && pkg.scripts['verify:staff-ask-luna-multi-tool-planner']
    === 'node scripts/verify-staff-ask-luna-multi-tool-planner.js',
  'package.json verify script',
);

console.log('\nA. Wiring');

check(apiSrc.includes('resolveOpsPlannerIntent'), 'API resolves ops planner');
check(apiSrc.includes('OPS_MULTI_TOOL_INTENT'), 'API handles multi-tool intent');
check(apiSrc.includes('executeOpsPlannerTools'), 'API executes planner tools');
check(apiSrc.includes('formatCombinedOpsPlannerAnswer'), 'API formats combined answer');
check(plSrc.includes('Do not generate SQL'), 'planner prompt forbids SQL');
check(!plSrc.match(/FROM\s+conversations|message_log|chat_log/i), 'no chat log queries');

console.log('\nB. Allowlist');

const {
  OPS_PLANNER_TOOL_ALLOWLIST,
  MAX_PLANNER_TOOLS,
  OPS_MULTI_TOOL_INTENT,
  detectOpsPlannerRequest,
  getDefaultOpsToolIntents,
  parseAndValidatePlannerOutput,
  formatCombinedOpsPlannerAnswer,
  summarizePlannerToolResult,
  resolveOpsPlannerIntent,
} = require('./lib/staff-ask-luna-multi-tool-planner');
const { resolveAskLunaArrivalsCheckoutsIntentKey } = require('./lib/staff-ask-luna-arrivals-checkouts');
const { REGISTRY_BY_KEY } = require('./lib/staff-query-registry');

check(OPS_PLANNER_TOOL_ALLOWLIST.has('payments.balance_due'), 'allowlist: balance_due');
check(OPS_PLANNER_TOOL_ALLOWLIST.has('bookings.arrivals_tomorrow'), 'allowlist: arrivals_tomorrow');
check(OPS_PLANNER_TOOL_ALLOWLIST.has('housekeeping.cleaning_today'), 'allowlist: cleaning_today');
check(OPS_PLANNER_TOOL_ALLOWLIST.size === 15, 'allowlist has 15 intents');

console.log('\nC. Deterministic routing priority');

const single = resolveAskLunaArrivalsCheckoutsIntentKey('Who checks in today?', REGISTRY_BY_KEY);
check(single && single.intentKey === 'bookings.arrivals_today', 'single-intent wins over planner');

const OPS_PHRASES = [
  'What should I prepare for tomorrow?',
  'What\'s happening today?',
  'Give me today\'s ops summary',
  'What\'s going on tomorrow?',
  'Show tomorrow\'s operations',
  'Any important stuff today?',
];

for (const phrase of OPS_PHRASES) {
  const det = detectOpsPlannerRequest(phrase);
  check(det && !det.rejected && det.when, `ops trigger: ${phrase}`);
}

(async () => {
  for (const phrase of OPS_PHRASES) {
    const res = await resolveOpsPlannerIntent(phrase);
    check(res && res.intentKey === OPS_MULTI_TOOL_INTENT, `planner intent: ${phrase}`);
    check(res.extraParams.tool_intents && res.extraParams.tool_intents.length > 0, `tool list: ${phrase}`);
  }

  const fri = detectOpsPlannerRequest('What do I need to know for Friday?');
  check(fri && fri.rejected, 'Friday ops question rejected');

  const allowed = OPS_PLANNER_TOOL_ALLOWLIST;
  const valid = JSON.stringify({
    tool_intents: getDefaultOpsToolIntents('tomorrow'),
    confidence: 0.88,
    reason: 'Tomorrow prep summary.',
  });
  const parsed = parseAndValidatePlannerOutput(valid, allowed);
  check(parsed && parsed.tool_intents.length >= 5, 'valid planner JSON accepted');

  check(parseAndValidatePlannerOutput('{bad', allowed) === null, 'invalid JSON rejected');
  check(
    parseAndValidatePlannerOutput(
      JSON.stringify({ tool_intents: ['bookings.arrivals_tomorrow'], confidence: 0.5, reason: 'low' }),
      allowed,
    ) === null,
    'low confidence rejected',
  );
  check(
    parseAndValidatePlannerOutput(
      JSON.stringify({ tool_intents: ['not.a.real.intent'], confidence: 0.9, reason: 'x' }),
      allowed,
    ) === null,
    'unregistered intent rejected',
  );
  check(
    parseAndValidatePlannerOutput(
      JSON.stringify({
        tool_intents: Array.from({ length: 9 }, (_, i) => 'services.lessons_today'),
        confidence: 0.95,
        reason: 'too many',
      }),
      allowed,
    ) === null,
    'max tools enforced',
  );
  check(
    parseAndValidatePlannerOutput('SELECT * FROM bookings', allowed) === null,
    'SQL-looking output rejected',
  );

  const combined = formatCombinedOpsPlannerAnswer([
    { heading: 'Arrivals: 2 guests/bookings.', bullets: ['* Jimmy — WH-1 — R1.'] },
    { heading: 'Lessons: no lessons booked.', bullets: [] },
  ], 'tomorrow');
  check(combined.includes('tomorrow\'s ops summary'), 'combined answer has summary header');
  check(!combined.trim().startsWith('{'), 'combined answer is not JSON');
  check(!combined.includes('| --- |'), 'combined answer is not a markdown table');

  const partial = formatCombinedOpsPlannerAnswer([
    summarizePlannerToolResult(
      { ok: true, intentKey: 'bookings.arrivals_today', rows: [{ guest_name: 'A', booking_code: 'WH-1', bed_summary: 'R1', guest_count: 1 }] },
      { date: '2026-06-04', dateLabel: 'today' },
    ),
    summarizePlannerToolResult(
      { ok: false, intentKey: 'services.gear_today', error: 'timeout' },
      { date: '2026-06-04', dateLabel: 'today' },
    ),
  ], 'today');
  check(partial.includes('Arrivals:'), 'partial success includes arrivals');
  check(partial.includes('unavailable'), 'partial failure mentioned generically');

  check(!plSrc.match(/\b(INSERT|UPDATE|DELETE)\b.*bookings/i), 'planner lib no booking writes');
  check(!plSrc.match(/stripe|whatsapp|n8n/i), 'planner lib no Stripe/WhatsApp/n8n');

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  fail(`async verifier: ${e.message}`);
  process.exit(1);
});

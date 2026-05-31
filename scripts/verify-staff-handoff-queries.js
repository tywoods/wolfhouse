'use strict';
/**
 * Stage 5.7 — Staff handoff query static verifier (NO DB connection).
 *
 * Verifies all eight staff handoff query helpers:
 *   1. Each exported function exists and returns a string.
 *   2. Every query is SELECT-only — no mutation keywords.
 *   3. All queries are scoped by client slug ($1).
 *   4. All queries reference staff_handoffs.
 *   5. Parameterised queries include $2 where expected.
 *   6. MODULE_EXPORTS names match expected set.
 *
 * Usage:
 *   node scripts/verify-staff-handoff-queries.js
 *
 * Exit 0 = all checks pass. Exit 1 = at least one failure.
 */

const queries = require('./lib/staff-handoff-queries');

const MUTATION_KEYWORDS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'DROP', 'ALTER', 'CREATE'];

const EXPECTED_EXPORTS = [
  'CLIENT_SLUG',
  'PAYMENT_CLAIM_REASONS',
  'CANCELLATION_REFUND_REASONS',
  'getOpenHandoffsQuery',
  'getHighPriorityHandoffsQuery',
  'getHandoffsByReasonQuery',
  'getPaymentClaimedHandoffsQuery',
  'getCancellationRefundHandoffsQuery',
  'getHandoffsByStaffQuery',
  'getStaleHandoffsQuery',
  'getBookingHandoffsQuery',
];

const QUERY_SPECS = [
  { name: 'getOpenHandoffsQuery',             label: 'A — Open handoffs',            hasSecondParam: false },
  { name: 'getHighPriorityHandoffsQuery',     label: 'B — High/urgent priority',     hasSecondParam: false, mustContain: ["'high'", "'urgent'"] },
  { name: 'getHandoffsByReasonQuery',         label: 'C — By reason',                hasSecondParam: true, mustContain: ['reason_code = $2'] },
  { name: 'getPaymentClaimedHandoffsQuery',   label: 'D — Payment-claimed',          hasSecondParam: false, mustContain: ['payment_claimed'] },
  { name: 'getCancellationRefundHandoffsQuery', label: 'E — Cancellation/refund',    hasSecondParam: false, mustContain: ['cancellation_request', 'refund_request'] },
  { name: 'getHandoffsByStaffQuery',          label: 'F — By assigned staff',        hasSecondParam: true, mustContain: ['assigned_staff = $2'] },
  { name: 'getStaleHandoffsQuery',            label: 'G — Stale (older than N hrs)', hasSecondParam: true, mustContain: ['hours'] },
  { name: 'getBookingHandoffsQuery',          label: 'H — Booking-linked',           hasSecondParam: true, mustContain: ['booking_code = $2'] },
];

let failures = 0;

function ok(label) {
  console.log(`  ✓ ${label}`);
}
function fail(label, detail) {
  console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`);
  failures++;
}
function check(condition, passLabel, failLabel, detail) {
  if (condition) ok(passLabel);
  else fail(failLabel || passLabel, detail);
}

// 1. Exports
console.log('\n── 1. Module exports ──');
for (const name of EXPECTED_EXPORTS) {
  check(name in queries, `${name} exported`, `${name} missing from exports`);
}
const unexpected = Object.keys(queries).filter((k) => !EXPECTED_EXPORTS.includes(k));
if (unexpected.length > 0) fail('No unexpected exports', unexpected.join(', '));
else ok(`No unexpected exports (${Object.keys(queries).length} total)`);

// 2. CLIENT_SLUG
console.log('\n── 2. CLIENT_SLUG ──');
check(
  typeof queries.CLIENT_SLUG === 'string' && queries.CLIENT_SLUG.length > 0,
  `CLIENT_SLUG is non-empty string: "${queries.CLIENT_SLUG}"`
);

// 3. Per-query checks
for (const spec of QUERY_SPECS) {
  console.log(`\n── 3/${spec.name} — ${spec.label} ──`);
  const fn = queries[spec.name];
  if (typeof fn !== 'function') {
    fail(`${spec.name} is a function`, `got ${typeof fn}`);
    continue;
  }
  ok(`${spec.name} is a function`);

  const sql = fn();
  check(typeof sql === 'string' && sql.length > 0, 'returns a non-empty string');
  check(sql.trim().toUpperCase().startsWith('SELECT'), 'starts with SELECT');

  for (const kw of MUTATION_KEYWORDS) {
    const pattern = new RegExp(`\\b${kw}\\b`, 'i');
    check(!pattern.test(sql), `no ${kw} keyword`, `contains mutation keyword: ${kw}`);
  }

  check(sql.includes('$1'), 'parameterised with $1 (client slug)');
  check(/\bclients\b/i.test(sql), 'references clients table for scoping');
  check(/\bstaff_handoffs\b/i.test(sql), 'references staff_handoffs');

  if (spec.hasSecondParam) {
    check(sql.includes('$2'), 'has $2 parameter');
  }

  for (const needle of (spec.mustContain || [])) {
    check(sql.includes(needle), `contains "${needle}"`);
  }
}

console.log('\n═══════════════════════════════════════════════════════════');
if (failures === 0) {
  console.log('Result: PASS — all checks green (0 failures)');
  process.exit(0);
} else {
  console.error(`Result: FAIL — ${failures} check(s) failed`);
  process.exit(1);
}

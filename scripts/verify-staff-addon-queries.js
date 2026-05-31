'use strict';
/**
 * Stage 5.6 — Staff add-on query static verifier (NO DB connection).
 *
 * Verifies all six staff add-on query helpers:
 *   1. Each exported function exists and returns a string.
 *   2. Every query is SELECT-only — no mutation keywords.
 *   3. All queries are scoped by client slug ($1).
 *   4. Queries reference add_on_orders or add_on_items as expected.
 *   5. Date-parameterised queries include $2.
 *   6. MODULE_EXPORTS names match expected set.
 *
 * Usage:
 *   node scripts/verify-staff-addon-queries.js
 *
 * Exit 0 = all checks pass. Exit 1 = at least one failure.
 */

const queries = require('./lib/staff-addon-queries');

const MUTATION_KEYWORDS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'DROP', 'ALTER', 'CREATE'];

const EXPECTED_EXPORTS = [
  'CLIENT_SLUG',
  'getUnpaidAddOnsQuery',
  'getLessonsByDateQuery',
  'getYogaByDateQuery',
  'getActiveRentalsByDateQuery',
  'getAddonsByBookingQuery',
  'getStaffRequiredAddOnsQuery',
];

const QUERY_SPECS = [
  {
    name: 'getUnpaidAddOnsQuery',
    label: 'A — Unpaid add-ons',
    mustReference: ['add_on_orders', 'bookings'],
    hasDateParam: false,
    mustContain: ['payment_status'],
  },
  {
    name: 'getLessonsByDateQuery',
    label: 'B — Lessons by date',
    mustReference: ['lesson_requests', 'add_on_items', 'add_on_orders'],
    hasDateParam: true,
    mustContain: ['lesson_date'],
  },
  {
    name: 'getYogaByDateQuery',
    label: 'C — Yoga by date',
    mustReference: ['yoga_requests', 'add_on_items', 'add_on_orders'],
    hasDateParam: true,
    mustContain: ['class_date'],
  },
  {
    name: 'getActiveRentalsByDateQuery',
    label: 'D — Active rentals by date',
    mustReference: ['rental_requests', 'add_on_items', 'add_on_orders'],
    hasDateParam: true,
    mustContain: ['rental_type', 'pickup_status'],
  },
  {
    name: 'getAddonsByBookingQuery',
    label: 'E — Add-ons by booking',
    mustReference: ['add_on_orders', 'add_on_items', 'bookings'],
    hasDateParam: false,
    hasBookingParam: true,
    mustContain: ['booking_code'],
  },
  {
    name: 'getStaffRequiredAddOnsQuery',
    label: 'F — Staff-required add-ons',
    mustReference: ['lesson_requests', 'add_on_items', 'add_on_orders'],
    hasDateParam: false,
    mustContain: ['scheduling_status', 'staff_required'],
  },
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

// ---------------------------------------------------------------------------
// 1. Exports
// ---------------------------------------------------------------------------
console.log('\n── 1. Module exports ──');
for (const name of EXPECTED_EXPORTS) {
  check(name in queries, `${name} exported`, `${name} missing from exports`);
}
const unexpected = Object.keys(queries).filter(k => !EXPECTED_EXPORTS.includes(k));
if (unexpected.length > 0) fail('No unexpected exports', unexpected.join(', '));
else ok(`No unexpected exports (${Object.keys(queries).length} total)`);

// ---------------------------------------------------------------------------
// 2. CLIENT_SLUG
// ---------------------------------------------------------------------------
console.log('\n── 2. CLIENT_SLUG ──');
check(
  typeof queries.CLIENT_SLUG === 'string' && queries.CLIENT_SLUG.length > 0,
  `CLIENT_SLUG is non-empty string: "${queries.CLIENT_SLUG}"`
);

// ---------------------------------------------------------------------------
// 3. Per-query checks
// ---------------------------------------------------------------------------
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

  // Client scoping
  check(sql.includes('$1'), 'parameterised with $1 (client slug)');
  check(/\bclients\b/i.test(sql), 'references clients table for scoping');

  // Required table references
  for (const table of spec.mustReference) {
    check(new RegExp(`\\b${table}\\b`, 'i').test(sql), `references ${table}`);
  }

  // Date param ($2)
  if (spec.hasDateParam) {
    check(sql.includes('$2'), 'has $2 (date parameter)');
    check(sql.includes('::date'), 'casts $2 to ::date');
  }

  // Booking param ($2)
  if (spec.hasBookingParam) {
    check(sql.includes('$2'), 'has $2 (booking_code parameter)');
  }

  // mustContain strings
  for (const needle of (spec.mustContain || [])) {
    check(sql.includes(needle), `contains "${needle}"`);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n═══════════════════════════════════════════════════════════');
if (failures === 0) {
  console.log(`Result: PASS — all checks green (0 failures)`);
  process.exit(0);
} else {
  console.error(`Result: FAIL — ${failures} check(s) failed`);
  process.exit(1);
}

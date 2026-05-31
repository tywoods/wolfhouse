'use strict';
/**
 * Stage 5.5 — Staff rooming query static verifier (NO DB connection).
 *
 * Verifies all six staff rooming query helpers:
 *   1. Each exported function exists and returns a string.
 *   2. Every query is SELECT-only — no mutation keywords.
 *   3. All queries are scoped by client slug ($1).
 *   4. Roster, occupied-beds, and unassigned queries reference booking_beds or bookings.
 *   5. MODULE_EXPORTS names match expected set.
 *
 * Usage:
 *   node scripts/verify-staff-rooming-queries.js
 *
 * Exit 0 = all checks pass. Exit 1 = at least one failure.
 */

const queries = require('./lib/staff-rooming-queries');

const MUTATION_KEYWORDS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'DROP', 'ALTER', 'CREATE'];

const EXPECTED_EXPORTS = [
  'CLIENT_SLUG',
  'getRoomingRosterQuery',
  'getUnassignedBookingsQuery',
  'getRoomingReviewQuery',
  'getRoomingPreferencesQuery',
  'getOccupiedBedsQuery',
  'getArrivalsNeedingAssignmentQuery',
];

const QUERY_SPECS = [
  {
    name: 'getRoomingRosterQuery',
    args: [],
    label: 'A — Rooming roster',
    mustReference: ['booking_beds', 'bookings'],
    clientScoped: true,
  },
  {
    name: 'getUnassignedBookingsQuery',
    args: [],
    label: 'B — Unassigned bookings',
    mustReference: ['bookings'],
    clientScoped: true,
  },
  {
    name: 'getRoomingReviewQuery',
    args: [],
    label: 'C — Rooming review needed',
    mustReference: ['bookings'],
    clientScoped: true,
  },
  {
    name: 'getRoomingPreferencesQuery',
    args: [],
    label: 'D — Rooming preferences',
    mustReference: ['bookings'],
    clientScoped: true,
  },
  {
    name: 'getOccupiedBedsQuery',
    args: [],
    label: 'E — Occupied beds (date range)',
    mustReference: ['booking_beds', 'bookings'],
    clientScoped: true,
    hasDateParams: true,
  },
  {
    name: 'getArrivalsNeedingAssignmentQuery',
    args: [],
    label: 'F — Arrivals needing assignment',
    mustReference: ['bookings'],
    clientScoped: true,
    hasDateParams: true,
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
// 1. Exports check
// ---------------------------------------------------------------------------
console.log('\n── 1. Module exports ──');
for (const name of EXPECTED_EXPORTS) {
  check(
    name in queries,
    `${name} exported`,
    `${name} missing from exports`
  );
}

// Extra exports check
const exportedKeys = Object.keys(queries);
const unexpected = exportedKeys.filter(k => !EXPECTED_EXPORTS.includes(k));
if (unexpected.length > 0) {
  fail('No unexpected exports', unexpected.join(', '));
} else {
  ok(`No unexpected exports (${exportedKeys.length} total)`);
}

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

  // Is a function?
  if (typeof fn !== 'function') {
    fail(`${spec.name} is a function`, `got ${typeof fn}`);
    continue;
  }
  ok(`${spec.name} is a function`);

  // Returns a string
  const sql = fn();
  check(typeof sql === 'string' && sql.length > 0, 'returns a non-empty string');

  // Starts with SELECT (after trim)
  const trimmed = sql.trim().toUpperCase();
  check(trimmed.startsWith('SELECT'), 'starts with SELECT');

  // No mutation keywords
  for (const kw of MUTATION_KEYWORDS) {
    const pattern = new RegExp(`\\b${kw}\\b`, 'i');
    check(
      !pattern.test(sql),
      `no ${kw} keyword`,
      `contains mutation keyword: ${kw}`
    );
  }

  // Client scoping ($1 and clients table)
  if (spec.clientScoped) {
    check(sql.includes('$1'), 'parameterised with $1 (client slug)');
    check(
      /\bclients\b/i.test(sql),
      'references clients table for scoping'
    );
  }

  // mustReference checks
  for (const table of spec.mustReference) {
    check(
      new RegExp(`\\b${table}\\b`, 'i').test(sql),
      `references ${table}`
    );
  }

  // Date params check ($2 and $3 for occupied-beds; $2 for arrivals)
  if (spec.name === 'getOccupiedBedsQuery') {
    check(sql.includes('$2'), 'has $2 (from_date)');
    check(sql.includes('$3'), 'has $3 (to_date)');
    check(/assignment_start_date\s*</.test(sql), 'uses assignment_start_date < to_date for overlap');
    check(/assignment_end_date\s*>/.test(sql), 'uses assignment_end_date > from_date for overlap');
  }
  if (spec.name === 'getArrivalsNeedingAssignmentQuery') {
    check(sql.includes('$2'), 'has $2 (cutoff_date)');
    check(/check_in\s*<=/.test(sql), 'uses check_in <= cutoff_date');
  }

  // Specific field checks per query
  if (spec.name === 'getRoomingReviewQuery') {
    check(
      /needs_rooming_review/.test(sql),
      'references needs_rooming_review flag'
    );
  }
  if (spec.name === 'getRoomingPreferencesQuery') {
    check(
      /requested_room_type/.test(sql) && /room_preference/.test(sql),
      'references requested_room_type and room_preference'
    );
    check(/guest_gender_group_type/.test(sql), 'references guest_gender_group_type');
  }
  if (spec.name === 'getUnassignedBookingsQuery') {
    check(
      /assignment_status\s*=\s*'unassigned'/.test(sql),
      "filters assignment_status = 'unassigned'"
    );
  }
  if (spec.name === 'getRoomingRosterQuery') {
    check(/room_code/.test(sql), 'selects room_code');
    check(/bed_code/.test(sql), 'selects bed_code');
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

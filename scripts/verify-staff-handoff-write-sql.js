'use strict';
/**
 * Stage 5.8 — Staff handoff write-path SQL static verifier (NO DB connection).
 *
 * Verifies staff-handoff-write-sql.js:
 *   1. All exports exist.
 *   2. SQL helpers return non-empty strings.
 *   3. INSERT/UPDATE only targets staff_handoffs — not protected tables.
 *   4. All INSERT helpers are client-scoped via clients.slug = $1.
 *   5. ON CONFLICT / idempotency present.
 *   6. resolveHandoffSql is UPDATE-only (no INSERT/DELETE).
 *   7. Reference objects (HANDOFF_REASON_MAP, HANDOFF_PRIORITY_DEFAULTS) exist
 *      and contain expected keys.
 *   8. NOT WIRED label present in every SQL helper.
 *
 * Usage:
 *   node scripts/verify-staff-handoff-write-sql.js
 *
 * Exit 0 = all checks pass. Exit 1 = at least one failure.
 */

const write = require('./lib/staff-handoff-write-sql');

let failures = 0;
function ok(label)        { console.log(`  ✓ ${label}`); }
function fail(label, why) { console.error(`  ✗ ${label}${why ? ': ' + why : ''}`); failures++; }
function check(cond, pass, fail_label, why) {
  if (cond) ok(pass); else fail(fail_label || pass, why);
}

// Protected tables that write helpers must NOT touch.
const PROTECTED_TABLES = [
  'bookings', 'payments', 'payment_events', 'booking_beds',
  'conversations', 'messages', 'guests',
];

// SQL string exports to verify.
const SQL_EXPORTS = [
  'upsertHandoffByConversationAndReasonSql',
  'upsertHandoffByBookingAndReasonSql',
  'resolveHandoffSql',
];

// Static string/object exports.
const STATIC_EXPORTS = [
  'IDEMPOTENCY_INDEX_DDL',
  'IDEMPOTENCY_INDEX_BOOKING_DDL',
  'HANDOFF_REASON_MAP',
  'HANDOFF_PRIORITY_DEFAULTS',
];

// 1. Exports presence
console.log('\n── 1. Module exports ──');
for (const name of [...SQL_EXPORTS, ...STATIC_EXPORTS]) {
  check(name in write, `${name} exported`, `${name} missing from exports`);
}

// 2. SQL helper checks
for (const name of SQL_EXPORTS) {
  console.log(`\n── 2/${name} ──`);
  const fn = write[name];
  if (typeof fn !== 'function') {
    fail(`${name} is a function`, `got ${typeof fn}`);
    continue;
  }
  ok(`${name} is a function`);

  const sql = fn();
  check(typeof sql === 'string' && sql.trim().length > 0, 'returns a non-empty string');

  // NOT WIRED label
  check(sql.includes('NOT WIRED'), 'contains NOT WIRED label');

  // Only targets staff_handoffs
  const upper = sql.toUpperCase();
  check(/\bSTAFF_HANDOFFS\b/.test(upper), 'references staff_handoffs');

  for (const table of PROTECTED_TABLES) {
    const pat = new RegExp(`\\b${table.toUpperCase()}\\b`);
    // Resolve helper uses an UPDATE but must not INSERT into protected tables.
    // The UPDATE helper itself targets staff_handoffs only.
    check(!pat.test(upper), `does not target protected table: ${table}`);
  }

  // Client scoping: must reference clients.slug or c.slug
  check(/\bclients\b/i.test(sql), 'queries clients table for scoping');

  // Upsert helpers: idempotency present
  if (name.startsWith('upsert')) {
    check(/ON CONFLICT/i.test(sql), 'has ON CONFLICT idempotency clause');
    check(/INSERT INTO staff_handoffs/i.test(sql), 'INSERT targets staff_handoffs');
    check(sql.includes('$1'), 'parameterised with $1 (client slug)');
  }

  // Resolve helper: UPDATE only, no INSERT
  if (name === 'resolveHandoffSql') {
    check(/^[^;]*UPDATE staff_handoffs/im.test(sql), 'uses UPDATE on staff_handoffs');
    check(!/^\s*INSERT\b/im.test(sql.replace(/--[^\n]*/g, '')), 'does not INSERT');
    check(sql.includes('resolved'), 'sets status=resolved');
  }
}

// 3. DDL strings
console.log('\n── 3. Idempotency DDL strings ──');
for (const name of ['IDEMPOTENCY_INDEX_DDL', 'IDEMPOTENCY_INDEX_BOOKING_DDL']) {
  const ddl = write[name];
  check(typeof ddl === 'string' && ddl.length > 0, `${name} is a non-empty string`);
  check(ddl.includes('NOT WIRED'), `${name} contains NOT WIRED label`);
  check(/CREATE UNIQUE INDEX IF NOT EXISTS/i.test(ddl), `${name} has CREATE UNIQUE INDEX IF NOT EXISTS`);
  check(/staff_handoffs/i.test(ddl), `${name} targets staff_handoffs`);
  check(/WHERE/i.test(ddl), `${name} has partial WHERE filter`);
}

// 4. Reference objects
console.log('\n── 4. Reference objects ──');
const reasonMap = write.HANDOFF_REASON_MAP;
check(typeof reasonMap === 'object' && reasonMap !== null, 'HANDOFF_REASON_MAP is an object');
const expectedReasonKeys = [
  'existing_booking_cancel', 'existing_booking_modify',
  'payment_completed_claim', 'human_handoff',
];
for (const key of expectedReasonKeys) {
  check(key in reasonMap, `HANDOFF_REASON_MAP has key: ${key}`);
}

const priorityMap = write.HANDOFF_PRIORITY_DEFAULTS;
check(typeof priorityMap === 'object' && priorityMap !== null, 'HANDOFF_PRIORITY_DEFAULTS is an object');
const expectedPriorityKeys = [
  'cancellation_request', 'payment_claimed', 'guest_angry', 'unclear_request',
];
for (const key of expectedPriorityKeys) {
  check(key in priorityMap, `HANDOFF_PRIORITY_DEFAULTS has key: ${key}`);
  const val = priorityMap[key];
  check(
    ['low', 'normal', 'high', 'urgent'].includes(val),
    `HANDOFF_PRIORITY_DEFAULTS[${key}]="${val}" is valid priority`
  );
}

console.log('\n═══════════════════════════════════════════════════════════');
if (failures === 0) {
  console.log('Result: PASS — all checks green (0 failures)');
  process.exit(0);
} else {
  console.error(`Result: FAIL — ${failures} check(s) failed`);
  process.exit(1);
}

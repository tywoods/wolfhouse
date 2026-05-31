'use strict';
/**
 * Stage 5.7 — Staff handoff migration static verifier (NO DB connection).
 *
 * Reads database/migrations/008_add_staff_handoffs.sql and verifies:
 *   1. Transaction wrapping (BEGIN/COMMIT).
 *   2. staff_handoffs and staff_tasks tables defined (CREATE TABLE IF NOT EXISTS).
 *   3. Required columns present on staff_handoffs.
 *   4. FK references to clients, conversations, bookings (+ staff_tasks → staff_handoffs).
 *   5. Required indexes present (incl. partial open-handoffs index).
 *   6. set_updated_at triggers present.
 *   7. No destructive operations (DROP TABLE, TRUNCATE, ALTER … DROP, DROP INDEX).
 *   8. Idempotency (IF NOT EXISTS).
 *
 * Usage:
 *   node scripts/verify-staff-handoff-migration.js
 *
 * Exit 0 = all checks pass. Exit 1 = at least one failure.
 */

const fs = require('fs');
const path = require('path');

const MIGRATION_FILE = path.join(__dirname, '..', 'database', 'migrations', '008_add_staff_handoffs.sql');

let failures = 0;
function ok(label) { console.log(`  ✓ ${label}`); }
function fail(label, detail) { console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`); failures++; }
function check(condition, passLabel, failLabel, detail) {
  if (condition) ok(passLabel); else fail(failLabel || passLabel, detail);
}

console.log('\n── 0. Migration file ──');
let sql;
try {
  sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
  ok(`008_add_staff_handoffs.sql exists (${sql.length} chars)`);
} catch (e) {
  fail('008_add_staff_handoffs.sql exists', e.message);
  process.exit(1);
}

// 1. Transaction
console.log('\n── 1. Transaction ──');
check(/^\s*BEGIN\s*;/m.test(sql), 'starts with BEGIN;');
check(/COMMIT\s*;/m.test(sql), 'ends with COMMIT;');

// 2. Tables
console.log('\n── 2. Table definitions ──');
const REQUIRED_TABLES = ['staff_handoffs', 'staff_tasks'];
for (const table of REQUIRED_TABLES) {
  check(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(sql), `CREATE TABLE IF NOT EXISTS ${table}`);
}

// 3. Required columns on staff_handoffs
console.log('\n── 3. staff_handoffs columns ──');
const REQUIRED_COLUMNS = [
  'client_id', 'conversation_id', 'booking_id', 'phone', 'source_channel',
  'reason_code', 'summary', 'guest_message', 'language', 'priority', 'status',
  'assigned_staff', 'opened_at', 'first_response_due_at', 'resolved_at',
  'resolution_summary', 'metadata', 'created_at', 'updated_at',
];
for (const col of REQUIRED_COLUMNS) {
  check(new RegExp(`\\b${col}\\b`).test(sql), `column ${col} present`);
}

// 4. FK references
console.log('\n── 4. FK references ──');
const FK_CHECKS = [
  ['staff_handoffs → clients', /staff_handoffs[\s\S]{1,400}REFERENCES clients\s*\(id\)/i],
  ['staff_handoffs → conversations', /REFERENCES conversations\s*\(id\)/i],
  ['staff_handoffs → bookings', /staff_handoffs[\s\S]{1,800}REFERENCES bookings\s*\(id\)/i],
  ['staff_tasks → staff_handoffs', /REFERENCES staff_handoffs\s*\(id\)/i],
  ['staff_tasks → clients', /staff_tasks[\s\S]{1,400}REFERENCES clients\s*\(id\)/i],
];
for (const [label, pattern] of FK_CHECKS) {
  check(pattern.test(sql), `FK: ${label}`);
}

// 5. Indexes
console.log('\n── 5. Indexes ──');
const INDEX_CHECKS = [
  'idx_staff_handoffs_client',
  'idx_staff_handoffs_status',
  'idx_staff_handoffs_reason_code',
  'idx_staff_handoffs_priority',
  'idx_staff_handoffs_opened_at',
  'idx_staff_handoffs_assigned_staff',
  'idx_staff_handoffs_booking',
  'idx_staff_handoffs_conversation',
  'idx_staff_handoffs_phone',
  'idx_staff_handoffs_open',
  'idx_staff_tasks_client',
  'idx_staff_tasks_status',
  'idx_staff_tasks_handoff',
  // Idempotency indexes (added in Stage 5.8b)
  'uq_staff_handoffs_conv_reason_open',
  'uq_staff_handoffs_booking_reason_open',
];
for (const idx of INDEX_CHECKS) {
  check(sql.includes(idx), `index ${idx} present`);
}
// Partial open-handoffs index
check(
  /idx_staff_handoffs_open[\s\S]{1,200}WHERE status IN/i.test(sql),
  'partial index idx_staff_handoffs_open has WHERE status filter'
);
// Idempotency index conditions
check(
  /uq_staff_handoffs_conv_reason_open[\s\S]{1,300}conversation_id IS NOT NULL/i.test(sql),
  'uq_staff_handoffs_conv_reason_open has conversation_id IS NOT NULL condition'
);
check(
  /uq_staff_handoffs_conv_reason_open[\s\S]{1,300}status IN/i.test(sql),
  'uq_staff_handoffs_conv_reason_open has status IN active-set condition'
);
check(
  /uq_staff_handoffs_booking_reason_open[\s\S]{1,300}booking_id IS NOT NULL/i.test(sql),
  'uq_staff_handoffs_booking_reason_open has booking_id IS NOT NULL condition'
);
check(
  /uq_staff_handoffs_booking_reason_open[\s\S]{1,300}conversation_id IS NULL/i.test(sql),
  'uq_staff_handoffs_booking_reason_open has conversation_id IS NULL guard'
);
check(
  /uq_staff_handoffs_booking_reason_open[\s\S]{1,300}status IN/i.test(sql),
  'uq_staff_handoffs_booking_reason_open has status IN active-set condition'
);

// 6. Triggers
console.log('\n── 6. Triggers ──');
for (const table of REQUIRED_TABLES) {
  check(
    new RegExp(`CREATE TRIGGER [a-z_]+_updated_at[\\s\\S]{1,200}ON ${table}\\b`, 'i').test(sql),
    `set_updated_at trigger on ${table}`
  );
}

// 7. No destructive operations
console.log('\n── 7. Safety: no destructive operations ──');
const DESTRUCTIVE = [
  [/\bDROP TABLE\b/i, 'DROP TABLE'],
  [/\bTRUNCATE\b/i, 'TRUNCATE'],
  [/\bALTER TABLE\b.*\bDROP\b/i, 'ALTER TABLE … DROP'],
  [/\bDROP INDEX\b/i, 'DROP INDEX'],
];
for (const [pattern, label] of DESTRUCTIVE) {
  check(!pattern.test(sql), `no ${label}`, `found destructive operation: ${label}`);
}

// 8. Idempotency
console.log('\n── 8. Idempotency ──');
const ifNotExistsCount = (sql.match(/IF NOT EXISTS/gi) || []).length;
check(
  ifNotExistsCount >= REQUIRED_TABLES.length,
  `IF NOT EXISTS used for all ${REQUIRED_TABLES.length} tables (found ${ifNotExistsCount} IF NOT EXISTS)`
);

console.log('\n═══════════════════════════════════════════════════════════');
if (failures === 0) {
  console.log('Result: PASS — all checks green (0 failures)');
  process.exit(0);
} else {
  console.error(`Result: FAIL — ${failures} check(s) failed`);
  process.exit(1);
}

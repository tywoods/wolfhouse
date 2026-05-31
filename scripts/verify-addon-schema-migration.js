'use strict';
/**
 * Stage 5.6 — Add-on schema migration static verifier (NO DB connection).
 *
 * Reads database/migrations/007_add_addon_orders.sql and verifies:
 *   1. All five expected table names are defined.
 *   2. All required FK references are present.
 *   3. All required indexes are present.
 *   4. No destructive operations (DROP TABLE, TRUNCATE, ALTER TABLE … DROP).
 *   5. Uses CREATE TABLE IF NOT EXISTS (idempotent).
 *   6. Uses BEGIN/COMMIT transaction wrapping.
 *   7. set_updated_at() triggers present for all five tables.
 *
 * Usage:
 *   node scripts/verify-addon-schema-migration.js
 *
 * Exit 0 = all checks pass. Exit 1 = at least one failure.
 */

const fs = require('fs');
const path = require('path');

const MIGRATION_FILE = path.join(__dirname, '..', 'database', 'migrations', '007_add_addon_orders.sql');

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
// Load migration file
// ---------------------------------------------------------------------------
console.log('\n── 0. Migration file ──');
let sql;
try {
  sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
  ok(`007_add_addon_orders.sql exists (${sql.length} chars)`);
} catch (e) {
  fail('007_add_addon_orders.sql exists', e.message);
  process.exit(1);
}

const sqlUp = sql.toUpperCase();

// ---------------------------------------------------------------------------
// 1. Transaction wrapping
// ---------------------------------------------------------------------------
console.log('\n── 1. Transaction ──');
check(/^\s*BEGIN\s*;/m.test(sql), 'starts with BEGIN;');
check(/COMMIT\s*;/m.test(sql), 'ends with COMMIT;');

// ---------------------------------------------------------------------------
// 2. Required tables defined (CREATE TABLE IF NOT EXISTS)
// ---------------------------------------------------------------------------
console.log('\n── 2. Table definitions ──');
const REQUIRED_TABLES = [
  'add_on_orders',
  'add_on_items',
  'lesson_requests',
  'yoga_requests',
  'rental_requests',
  'meal_requests',
  'transfer_requests',
];

for (const table of REQUIRED_TABLES) {
  const pattern = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i');
  check(pattern.test(sql), `CREATE TABLE IF NOT EXISTS ${table}`);
}

// ---------------------------------------------------------------------------
// 3. FK references to existing tables
// ---------------------------------------------------------------------------
console.log('\n── 3. FK references ──');
const FK_CHECKS = [
  ['add_on_orders → clients', /REFERENCES clients\s*\(id\)/i],
  ['add_on_orders → bookings', /add_on_orders[\s\S]{1,800}REFERENCES bookings\s*\(id\)/i],
  ['add_on_orders → conversations', /REFERENCES conversations\s*\(id\)/i],
  ['add_on_orders → payments', /REFERENCES payments\s*\(id\)/i],
  ['add_on_items → add_on_orders', /REFERENCES add_on_orders\s*\(id\)/i],
  ['lesson_requests → add_on_items', /lesson_requests[\s\S]{1,500}REFERENCES add_on_items\s*\(id\)/i],
  ['lesson_requests → bookings', /lesson_requests[\s\S]{1,800}REFERENCES bookings\s*\(id\)/i],
  ['yoga_requests → add_on_items', /yoga_requests[\s\S]{1,500}REFERENCES add_on_items\s*\(id\)/i],
  ['rental_requests → add_on_items', /rental_requests[\s\S]{1,500}REFERENCES add_on_items\s*\(id\)/i],
  ['meal_requests → add_on_items', /meal_requests[\s\S]{1,500}REFERENCES add_on_items\s*\(id\)/i],
  ['transfer_requests → add_on_items', /transfer_requests[\s\S]{1,500}REFERENCES add_on_items\s*\(id\)/i],
];

for (const [label, pattern] of FK_CHECKS) {
  check(pattern.test(sql), `FK: ${label}`);
}

// ---------------------------------------------------------------------------
// 4. Required indexes
// ---------------------------------------------------------------------------
console.log('\n── 4. Indexes ──');
const INDEX_CHECKS = [
  'idx_addon_orders_client',
  'idx_addon_orders_booking',
  'idx_addon_orders_status',
  'idx_addon_items_order',
  'idx_addon_items_service_date',
  'idx_lesson_requests_date',
  'idx_lesson_requests_scheduling_status',
  'idx_yoga_requests_class_date',
  'idx_rental_requests_dates',
  'idx_rental_requests_pickup_status',
  'idx_meal_requests_date',
  'idx_meal_requests_service_status',
  'idx_transfer_requests_arrival',
  'idx_transfer_requests_driver_status',
];

for (const idx of INDEX_CHECKS) {
  check(sql.includes(idx), `index ${idx} present`);
}

// ---------------------------------------------------------------------------
// 5. set_updated_at triggers
// ---------------------------------------------------------------------------
console.log('\n── 5. Triggers ──');
for (const table of REQUIRED_TABLES) {
  const pattern = new RegExp(`CREATE TRIGGER [a-z_]+_updated_at[\\s\\S]{1,200}ON ${table}\\b`, 'i');
  check(pattern.test(sql), `set_updated_at trigger on ${table}`);
}

// ---------------------------------------------------------------------------
// 6. No destructive operations
// ---------------------------------------------------------------------------
console.log('\n── 6. Safety: no destructive operations ──');
const DESTRUCTIVE = [
  [/\bDROP TABLE\b/i, 'DROP TABLE'],
  [/\bTRUNCATE\b/i, 'TRUNCATE'],
  [/\bALTER TABLE\b.*\bDROP\b/i, 'ALTER TABLE … DROP'],
  [/\bDROP INDEX\b/i, 'DROP INDEX'],
];

for (const [pattern, label] of DESTRUCTIVE) {
  check(!pattern.test(sql), `no ${label}`, `found destructive operation: ${label}`);
}

// ---------------------------------------------------------------------------
// 7. IF NOT EXISTS idempotency
// ---------------------------------------------------------------------------
console.log('\n── 7. Idempotency ──');
const ifNotExistsCount = (sql.match(/IF NOT EXISTS/gi) || []).length;
check(
  ifNotExistsCount >= REQUIRED_TABLES.length,
  `CREATE TABLE IF NOT EXISTS used for all ${REQUIRED_TABLES.length} tables (found ${ifNotExistsCount} IF NOT EXISTS)`
);

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

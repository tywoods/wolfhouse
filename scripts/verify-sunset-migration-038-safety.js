'use strict';

/**
 * verify:sunset-migration-038-safety
 *
 * Static checks for migration 038 authoritative-intent guard.
 * Run: node scripts/verify-sunset-migration-038-safety.js
 */

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

const ROOT = path.resolve(__dirname, '..');
const MIG = fs.readFileSync(path.join(ROOT, 'database/migrations/038_sunset_payment_link_idempotency.sql'), 'utf8');
const RUNNER = fs.readFileSync(path.join(ROOT, 'scripts/run-migration.js'), 'utf8');

console.log('\nverify:sunset-migration-038-safety\n');

console.log('[1] Migration runner compatibility');
assert('runner executes whole file in one batch', RUNNER.includes('whole file in one simple-query batch'));
assert('migration does not use CONCURRENTLY inside transactional DO block', !/CREATE UNIQUE INDEX CONCURRENTLY/i.test(MIG));

console.log('\n[2] Sunset scope + authoritative columns');
assert('scoped to sunset_schedule_stripe_link source', MIG.includes("metadata->>'source' = 'sunset_schedule_stripe_link'"));
assert('uses booking_id column', MIG.includes('booking_id'));
assert('uses payment_kind column', MIG.includes('payment_kind'));
assert('uses amount_due_cents column', MIG.includes('amount_due_cents'));
assert('uses currency column', MIG.includes('currency'));
assert('does not key on request idempotency_key', !/metadata->>'idempotency_key'/i.test(MIG));

console.log('\n[3] Duplicate preflight + idempotent rerun');
assert('preflight DO block present', /DO \$\$/.test(MIG));
assert('preflight raises on conflicts', MIG.includes('migration_038_preflight_failed'));
assert('preflight groups by authoritative intent', MIG.includes('GROUP BY booking_id, payment_kind, amount_due_cents, currency'));
assert('drops legacy request-key index', MIG.includes('DROP INDEX IF EXISTS payments_sunset_booking_idempotency_unique'));
assert('CREATE UNIQUE INDEX IF NOT EXISTS (idempotent)', MIG.includes('CREATE UNIQUE INDEX IF NOT EXISTS payments_sunset_authoritative_intent_unique'));

console.log(`\n── verify:sunset-migration-038-safety ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail > 0) process.exit(1);

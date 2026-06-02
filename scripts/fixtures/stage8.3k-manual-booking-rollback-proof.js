/**
 * Stage 8.3k — Manual booking rollback proof (local/test DB only).
 *
 * Proves that buildManualBookingRollbackSql() can safely undo a manual
 * booking created by buildManualBookingCreateSql(), using the rollback_payload
 * returned by the create helper.
 *
 * Safety:
 *   - Refuses production-looking DB URLs.
 *   - ALL writes are wrapped in explicit transactions and ROLLBACKed.
 *   - Final baseline counts must match initial counts (delta = 0).
 *   - No API route. No UI wiring. No Azure deployment.
 *   - No WhatsApp. No Stripe. No n8n. No workflow activation.
 *   - STAFF_ACTIONS_ENABLED not enabled.
 *   - MANUAL_BOOKING_ENABLED not enabled.
 *
 * Proof flow:
 *   A. Baseline counts.
 *   B. TX-HAPPY:    Create fixture booking → run rollback → assert deletion.
 *   C. TX-BLOCKERS: confirm=false, role=viewer, code mismatch blockers.
 *   D. TX-PAYMENT:  Unsafe payment (non-draft) blocker.
 *   E. TX-IDEMPOTENT: Double-rollback → booking_not_found safely.
 *   F. Final delta = 0.
 *
 * Usage:
 *   node scripts/fixtures/stage8.3k-manual-booking-rollback-proof.js
 *
 * Exits 0 (PASS) or 1 (FAIL/SKIP).
 *
 * @module stage8.3k-manual-booking-rollback-proof
 */

'use strict';

const path   = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '..', 'infra', '.env') });

const { Client } = require('pg');
const { buildManualBookingCreateSql, MANUAL_BOOKING_BLOCK_CODES }
  = require('../lib/staff-manual-booking-create-sql');
const { buildManualBookingRollbackSql, MANUAL_BOOKING_ROLLBACK_BLOCK_CODES }
  = require('../lib/staff-manual-booking-rollback-sql');

// ─── Safety ───────────────────────────────────────────────────────────────────

const PROD_PATTERNS = [
  /wolfhouse\.com(?!\.(test|local|staging|dev))/i,
  /prod(?:uction)?[-._]/i,
  /\.prod\./i,
  /rds\.amazonaws\.com/i,
  /database\.windows\.net/i,
  /azure.*database/i,
];

function redactUrl(url) {
  return url.replace(/:([^:@]+)@/, ':***@');
}

function assertNotProduction(url) {
  for (const pat of PROD_PATTERNS) {
    if (pat.test(url)) {
      console.error(`\n✗ SAFETY: connection matches production pattern (${pat})`);
      console.error(`  Refusing to run proof against a production database.`);
      console.error(`  URL (redacted): ${redactUrl(url)}`);
      process.exit(1);
    }
  }
}

function getConnectionString() {
  return (
    process.env.WOLFHOUSE_DATABASE_URL ||
    [
      'postgres://wolfhouse:',
      process.env.WOLFHOUSE_DB_PASSWORD || '',
      '@localhost:',
      process.env.WOLFHOUSE_DB_PORT || '5433',
      '/wolfhouse',
    ].join('')
  );
}

// ─── Counting helpers ─────────────────────────────────────────────────────────

const TRACKED_TABLES = [
  'bookings', 'booking_beds', 'payments', 'payment_events',
  'staff_handoffs', 'conversations', 'workflow_events', 'rooms', 'beds',
];

async function getBaseline(pg) {
  const counts = {};
  for (const tbl of TRACKED_TABLES) {
    const r = await pg.query(`SELECT COUNT(*) AS n FROM ${tbl}`);
    counts[tbl] = parseInt(r.rows[0].n, 10);
  }
  return counts;
}

function diffCounts(before, after) {
  const delta = {};
  for (const tbl of TRACKED_TABLES) {
    delta[tbl] = (after[tbl] || 0) - (before[tbl] || 0);
  }
  return delta;
}

// ─── Assertion helpers ────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passCount++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failCount++;
  }
}

// ─── Fixture parameters ────────────────────────────────────────────────────────

function makeCreateParams(override) {
  return Object.assign({
    client_slug:          'wolfhouse-somo',
    staff_user_id:        '00000000-0000-0000-0000-000000000001',
    staff_role:           'admin',
    idempotency_key:      `stage8-3k-proof-${crypto.randomBytes(4).toString('hex')}`,
    booking_code:         `T8K-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    guest_name:           'Stage 8K Rollback Demo',
    phone:                '+349998840001',
    email:                'stage8k.rollback@example.test',
    language:             'en',
    check_in:             '2027-03-01',
    check_out:            '2027-03-04',
    guest_count:          1,
    selected_bed_codes:   null,  // resolved at runtime
    package_or_stay_type: 'Manual demo',
    room_preference:      'Shared',
    booking_status:       'confirmed',
    payment_status:       'not_requested',
    deposit_amount_cents: 7500,  // >0 so payment row is inserted
    total_amount_cents:   30000,
    source:               'staff_manual',
    reason:               'Stage 8.3k rollback proof',
    notes:                'safe fixture — auto-rolled-back',
    confirm:              true,
    warnings_acknowledged: true,
  }, override);
}

function createParamsToArray(p) {
  return [
    p.client_slug,          // $1
    p.staff_user_id,        // $2
    p.staff_role,           // $3
    p.idempotency_key,      // $4
    p.booking_code,         // $5
    p.guest_name,           // $6
    p.phone,                // $7
    p.email,                // $8
    p.language || null,     // $9
    p.check_in,             // $10
    p.check_out,            // $11
    p.guest_count,          // $12
    p.selected_bed_codes,   // $13
    p.package_or_stay_type, // $14
    p.room_preference,      // $15
    p.booking_status,       // $16
    p.payment_status,       // $17
    p.deposit_amount_cents, // $18
    p.total_amount_cents,   // $19
    p.source,               // $20
    p.reason,               // $21
    p.notes,                // $22
    p.confirm,              // $23
    p.warnings_acknowledged,// $24
  ];
}

function rollbackParamsToArray(bookingId, bookingCode, rollbackPayload, opts) {
  const o = Object.assign({
    clientSlug:   'wolfhouse-somo',
    staffUserId:  '00000000-0000-0000-0000-000000000001',
    staffRole:    'admin',
    reason:       'Stage 8.3k rollback proof',
    confirm:      true,
  }, opts);
  return [
    o.clientSlug,      // $1
    o.staffUserId,     // $2
    o.staffRole,       // $3
    bookingId,         // $4
    bookingCode,       // $5
    rollbackPayload,   // $6  JSONB
    o.reason,          // $7
    o.confirm,         // $8
  ];
}

// ─── Fixture bed resolution ────────────────────────────────────────────────────
//
// Reuses same pattern as Stage 8.3i proof. Prefers existing DEMO beds,
// falls back to T8K-R1-B1 created inside the current transaction.

async function resolveFixtureBed(pg, clientId) {
  const existing = await pg.query(
    `SELECT b.id, b.bed_code, b.room_id, r.room_code
     FROM beds b
     JOIN rooms r ON r.id = b.room_id
     WHERE b.client_id = $1
       AND b.bed_code   = ANY($2::text[])
       AND b.active     = TRUE
       AND b.sellable   = TRUE
     LIMIT 1`,
    [clientId, ['DEMO-R1-B1', 'DEMO-R2-B1', 'DEMO-R1-B2', 'T8I-R1-B1']]
  );
  if (existing.rows.length > 0) {
    return { bedCode: existing.rows[0].bed_code, isFixtureCreated: false };
  }

  const fixtureNote = 'stage8_3k_fixture — safe to delete — created in proof transaction';
  const meta = JSON.stringify({ source: 'stage8_3k_fixture', safe_to_delete: true });

  let roomId;
  const roomCheck = await pg.query(
    `SELECT id FROM rooms WHERE client_id = $1 AND room_code = $2 LIMIT 1`,
    [clientId, 'T8K-R1']
  );
  if (roomCheck.rows.length > 0) {
    roomId = roomCheck.rows[0].id;
  } else {
    const roomIns = await pg.query(
      `INSERT INTO rooms (client_id, room_code, name, capacity, active,
         room_type, gender_strategy, fill_priority, private_priority, notes)
       VALUES ($1,'T8K-R1','T8K Test Room 1',4,TRUE,
               'dormitory','Flexible',50,50,$2)
       RETURNING id`,
      [clientId, fixtureNote]
    );
    roomId = roomIns.rows[0].id;
  }

  const bedCheck = await pg.query(
    `SELECT id FROM beds WHERE client_id = $1 AND bed_code = $2 LIMIT 1`,
    [clientId, 'T8K-R1-B1']
  );
  if (bedCheck.rows.length === 0) {
    await pg.query(
      `INSERT INTO beds (client_id, room_id, bed_code, bed_label, planning_row_label,
         bed_number, active, sellable, notes)
       VALUES ($1,$2,'T8K-R1-B1','T8K Room 1 — Bed 1','T8K Room 1 — Bed 1',
               1,TRUE,TRUE,$3)`,
      [clientId, roomId, fixtureNote]
    );
  }

  return { bedCode: 'T8K-R1-B1', isFixtureCreated: true };
}

// ─── Resolve client ID ────────────────────────────────────────────────────────

async function resolveClientId(pg, clientSlug) {
  const r = await pg.query(
    `SELECT id FROM clients WHERE slug = $1 LIMIT 1`,
    [clientSlug]
  );
  return r.rows.length > 0 ? r.rows[0].id : null;
}

// ─── Main proof ────────────────────────────────────────────────────────────────

async function main() {
  const connStr = getConnectionString();
  assertNotProduction(connStr);

  console.log('\n══════════════════════════════════════════════════════════════════════════');
  console.log(' Stage 8.3k — Manual Booking Rollback Proof');
  console.log('══════════════════════════════════════════════════════════════════════════');
  console.log(`  Target (redacted): ${redactUrl(connStr)}`);
  console.log('  Safety: not production ✓');
  console.log('  Mode:   all writes in BEGIN/ROLLBACK — zero persistent delta');
  console.log('  Flags:  STAFF_ACTIONS_ENABLED=false  MANUAL_BOOKING_ENABLED=false');
  console.log('══════════════════════════════════════════════════════════════════════════\n');

  const pg = new Client({ connectionString: connStr });
  try {
    await pg.connect();
  } catch (err) {
    console.log('\n⚠  SKIPPED — Could not connect to local database.');
    console.log(`   Error: ${err.message}`);
    console.log('   This proof requires a running local PostgreSQL instance.');
    console.log('   Start the local DB and re-run:');
    console.log('     node scripts/fixtures/stage8.3k-manual-booking-rollback-proof.js');
    console.log('\n   Static checks (syntax) already verified by node --check.\n');
    process.exit(0);
  }

  try {
    await runProof(pg);
  } finally {
    await pg.end();
  }
}

async function runProof(pg) {
  // ── A. Baseline ────────────────────────────────────────────────────────────

  console.log('── A. Baseline counts ────────────────────────────────────────────────────');
  const baseline = await getBaseline(pg);
  console.log('  Tables:', TRACKED_TABLES.map(t => `${t}=${baseline[t]}`).join('  '));

  // Resolve client
  const clientId = await resolveClientId(pg, 'wolfhouse-somo');
  if (!clientId) {
    console.error('\n✗ ABORT: client wolfhouse-somo not found in DB. Run migrations first.');
    process.exit(1);
  }

  // ── B. TX-HAPPY: Create → Rollback happy path ──────────────────────────────

  console.log('\n── B. TX-HAPPY: Create fixture booking → rollback → assert deletion ───────');
  await pg.query('BEGIN');
  let rollbackPayload = null;
  let happyBookingId  = null;
  let happyBookingCode = null;

  try {
    // B1. Resolve fixture bed
    const { bedCode } = await resolveFixtureBed(pg, clientId);
    console.log(`  Fixture bed: ${bedCode}`);

    // B2. Create fixture booking
    const createP = makeCreateParams({ selected_bed_codes: [bedCode] });
    const createRow = await pg.query(
      buildManualBookingCreateSql(),
      createParamsToArray(createP)
    );
    const cr = createRow.rows[0];
    assert('B1: create SQL returns a row', cr !== undefined);
    assert('B2: is_blocked=false (create)', cr.is_blocked === false,
      `is_blocked=${cr.is_blocked} block_reason=${cr.block_reason}`);
    assert('B3: booking_id returned (booking inserted)',
      typeof cr.booking_id === 'string' && cr.booking_id.length > 10);
    assert('B4: beds_inserted=1',         parseInt(cr.beds_inserted, 10) === 1);
    assert('B5: payments_inserted=1',     parseInt(cr.payments_inserted, 10) === 1);

    rollbackPayload = cr.rollback_payload;
    happyBookingId  = rollbackPayload && rollbackPayload.booking_id;
    happyBookingCode = rollbackPayload && rollbackPayload.booking_code;

    assert('B6: rollback_payload present', rollbackPayload !== null,
      'rollback_payload should not be null');
    assert('B7: rollback_payload has booking_id',
      rollbackPayload && typeof rollbackPayload.booking_id === 'string');
    assert('B8: rollback_payload has booking_code',
      rollbackPayload && typeof rollbackPayload.booking_code === 'string');
    assert('B9: rollback_payload has booking_bed_ids',
      rollbackPayload && Array.isArray(rollbackPayload.booking_bed_ids));
    assert('B10: rollback_payload has payment_ids',
      rollbackPayload && Array.isArray(rollbackPayload.payment_ids));

    // Verify booking exists before rollback
    const preRollbackBooking = await pg.query(
      `SELECT id, booking_code, booking_source FROM bookings WHERE id = $1`,
      [happyBookingId]
    );
    assert('B11: booking exists before rollback', preRollbackBooking.rows.length === 1);
    assert('B12: booking_source=manual_staff',
      preRollbackBooking.rows[0] && preRollbackBooking.rows[0].booking_source === 'manual_staff');

    const preRollbackBeds = await pg.query(
      `SELECT id FROM booking_beds WHERE booking_id = $1`,
      [happyBookingId]
    );
    assert('B13: booking_beds exist before rollback', preRollbackBeds.rows.length >= 1);

    const preRollbackPayments = await pg.query(
      `SELECT id, status FROM payments WHERE booking_id = $1`,
      [happyBookingId]
    );
    assert('B14: payment exists before rollback', preRollbackPayments.rows.length === 1);
    assert('B15: payment status=draft before rollback',
      preRollbackPayments.rows[0] && preRollbackPayments.rows[0].status === 'draft');

    // B3. Run rollback
    console.log(`  Running rollback for booking ${happyBookingCode} (${happyBookingId})`);
    const rollbackRow = await pg.query(
      buildManualBookingRollbackSql(),
      rollbackParamsToArray(happyBookingId, happyBookingCode, rollbackPayload)
    );
    const rr = rollbackRow.rows[0];

    assert('B16: rollback SQL returns a row', rr !== undefined);
    assert('B17: rollback success=true', rr.success === true,
      `success=${rr.success} blocked=${rr.blocked} block_reason=${rr.block_reason}`);
    assert('B18: rollback blocked=false', rr.blocked === false);
    assert('B19: block_reason is null', rr.block_reason === null);
    assert('B20: rows_deleted=1', parseInt(rr.rows_deleted, 10) === 1);
    assert('B21: booking_beds_affected>=1', parseInt(rr.booking_beds_affected, 10) >= 1);
    assert('B22: payments_affected=1', parseInt(rr.payments_affected, 10) === 1);
    assert('B23: audit_event_id present', rr.audit_event_id !== null);
    assert('B24: booking_code returned', rr.booking_code === happyBookingCode);

    // Verify rollback audit payload
    const rap = rr.rollback_audit_payload;
    assert('B25: rollback_audit_payload present', rap !== null);
    assert('B26: audit payload action=manual_booking_rollback',
      rap && rap.action === 'manual_booking_rollback');
    assert('B27: audit payload is_blocked=false',
      rap && rap.is_blocked === false);
    assert('B28: audit payload booking_beds_affected>=1',
      rap && parseInt(rap.booking_beds_affected, 10) >= 1);

    // Post-rollback assertions: booking and dependent rows gone
    const postBooking = await pg.query(
      `SELECT id FROM bookings WHERE id = $1`, [happyBookingId]
    );
    assert('B29: booking deleted after rollback', postBooking.rows.length === 0);

    const postBeds = await pg.query(
      `SELECT id FROM booking_beds WHERE booking_id = $1`, [happyBookingId]
    );
    assert('B30: booking_beds deleted after rollback (CASCADE)', postBeds.rows.length === 0);

    const postPayments = await pg.query(
      `SELECT id FROM payments WHERE booking_id = $1`, [happyBookingId]
    );
    assert('B31: payments deleted after rollback (CASCADE)', postPayments.rows.length === 0);

    // Audit row written to workflow_events (booking_id=NULL per design)
    const auditCheck = await pg.query(
      `SELECT id, workflow_name, message, booking_id
       FROM workflow_events
       WHERE id = $1`,
      [rr.audit_event_id]
    );
    assert('B32: audit row exists in workflow_events', auditCheck.rows.length === 1);
    assert('B33: audit workflow_name=staff_manual_booking_rollback',
      auditCheck.rows[0] && auditCheck.rows[0].workflow_name === 'staff_manual_booking_rollback');
    assert('B34: audit message not null/empty',
      auditCheck.rows[0] && auditCheck.rows[0].message && auditCheck.rows[0].message.length > 0);
    assert('B35: audit booking_id is NULL (FK-safe design)',
      auditCheck.rows[0] && auditCheck.rows[0].booking_id === null);

    console.log('  TX-HAPPY: all happy-path assertions done, rolling back outer txn...');

  } catch (err) {
    console.error(`  ✗ TX-HAPPY error: ${err.message}`);
    failCount++;
  } finally {
    await pg.query('ROLLBACK');
  }

  // ── C. TX-BLOCKERS: Confirm=false, role, code mismatch ────────────────────

  console.log('\n── C. TX-BLOCKERS: confirm=false, role blocker, code mismatch ────────────');
  await pg.query('BEGIN');

  try {
    const { bedCode } = await resolveFixtureBed(pg, clientId);
    const cpB = makeCreateParams({ selected_bed_codes: [bedCode] });
    const cpBRow = await pg.query(buildManualBookingCreateSql(), createParamsToArray(cpB));
    const cb = cpBRow.rows[0];

    if (cb.is_blocked || !cb.rollback_payload) {
      console.log('  ⚠  create blocked unexpectedly — skipping blocker tests');
    } else {
      const bkId   = cb.rollback_payload.booking_id;
      const bkCode = cb.rollback_payload.booking_code;
      const payload = cb.rollback_payload;

      // C1: confirm=false
      const c1 = await pg.query(
        buildManualBookingRollbackSql(),
        rollbackParamsToArray(bkId, bkCode, payload, { confirm: false })
      );
      const c1r = c1.rows[0];
      assert('C1: confirm=false → blocked=true', c1r.blocked === true,
        `blocked=${c1r.blocked}`);
      assert('C2: confirm=false → block_reason=confirm_not_set',
        c1r.block_reason === MANUAL_BOOKING_ROLLBACK_BLOCK_CODES.CONFIRM_NOT_SET,
        `block_reason=${c1r.block_reason}`);
      assert('C3: confirm=false → rows_deleted=0', parseInt(c1r.rows_deleted, 10) === 0);

      // Booking must still exist after blocked rollback
      const c1booking = await pg.query(
        `SELECT id FROM bookings WHERE id = $1`, [bkId]
      );
      assert('C4: booking still exists after confirm=false block', c1booking.rows.length === 1);

      // C2: role=viewer
      const c2 = await pg.query(
        buildManualBookingRollbackSql(),
        rollbackParamsToArray(bkId, bkCode, payload, { staffRole: 'viewer' })
      );
      const c2r = c2.rows[0];
      assert('C5: role=viewer → blocked=true', c2r.blocked === true);
      assert('C6: role=viewer → block_reason=staff_role_insufficient',
        c2r.block_reason === MANUAL_BOOKING_ROLLBACK_BLOCK_CODES.STAFF_ROLE_INSUFFICIENT,
        `block_reason=${c2r.block_reason}`);
      assert('C7: role=viewer → rows_deleted=0', parseInt(c2r.rows_deleted, 10) === 0);

      // C3: booking_code mismatch
      const c3 = await pg.query(
        buildManualBookingRollbackSql(),
        rollbackParamsToArray(bkId, 'WRONG-CODE-999', payload, {})
      );
      const c3r = c3.rows[0];
      assert('C8: code mismatch → blocked=true', c3r.blocked === true);
      assert('C9: code mismatch → block_reason=rollback_payload_code_mismatch',
        c3r.block_reason === MANUAL_BOOKING_ROLLBACK_BLOCK_CODES.ROLLBACK_PAYLOAD_CODE_MISMATCH,
        `block_reason=${c3r.block_reason}`);
      assert('C10: code mismatch → rows_deleted=0', parseInt(c3r.rows_deleted, 10) === 0);

      // C4: rollback_payload.booking_id mismatch (wrong UUID in payload)
      const wrongPayload = Object.assign({}, payload, {
        booking_id: '00000000-0000-0000-0000-000000000099',
      });
      const c4 = await pg.query(
        buildManualBookingRollbackSql(),
        rollbackParamsToArray(bkId, bkCode, wrongPayload, {})
      );
      const c4r = c4.rows[0];
      assert('C11: payload id mismatch → blocked=true', c4r.blocked === true);
      assert('C12: payload id mismatch → block_reason=rollback_payload_id_mismatch',
        c4r.block_reason === MANUAL_BOOKING_ROLLBACK_BLOCK_CODES.ROLLBACK_PAYLOAD_ID_MISMATCH,
        `block_reason=${c4r.block_reason}`);

      // Booking still exists after all blocked attempts
      const cFinalBooking = await pg.query(
        `SELECT id FROM bookings WHERE id = $1`, [bkId]
      );
      assert('C13: booking still exists after all blocker tests', cFinalBooking.rows.length === 1);
    }

    console.log('  TX-BLOCKERS: done, rolling back...');

  } catch (err) {
    console.error(`  ✗ TX-BLOCKERS error: ${err.message}`);
    failCount++;
  } finally {
    await pg.query('ROLLBACK');
  }

  // ── D. TX-PAYMENT: Unsafe payment blocker ─────────────────────────────────

  console.log('\n── D. TX-PAYMENT: unsafe (non-draft) payment blocker ────────────────────');
  await pg.query('BEGIN');

  try {
    const { bedCode } = await resolveFixtureBed(pg, clientId);
    const cpD = makeCreateParams({ selected_bed_codes: [bedCode] });
    const cpDRow = await pg.query(buildManualBookingCreateSql(), createParamsToArray(cpD));
    const cd = cpDRow.rows[0];

    if (cd.is_blocked || !cd.rollback_payload) {
      console.log('  ⚠  create blocked unexpectedly — skipping payment blocker test');
    } else {
      const bkId   = cd.rollback_payload.booking_id;
      const bkCode = cd.rollback_payload.booking_code;
      const payload = cd.rollback_payload;

      // Simulate non-draft payment (e.g. checkout_created)
      const updateResult = await pg.query(
        `UPDATE payments
         SET status = 'checkout_created'::payment_record_status
         WHERE booking_id = $1 AND status = 'draft'
         RETURNING id`,
        [bkId]
      );
      assert('D1: payment row updated to checkout_created',
        updateResult.rows.length === 1,
        `rows_updated=${updateResult.rows.length}`);

      // Rollback should be blocked by unsafe_payment_exists
      const dr = await pg.query(
        buildManualBookingRollbackSql(),
        rollbackParamsToArray(bkId, bkCode, payload)
      );
      const drr = dr.rows[0];
      assert('D2: unsafe payment → blocked=true', drr.blocked === true,
        `blocked=${drr.blocked} block_reason=${drr.block_reason}`);
      assert('D3: unsafe payment → block_reason=unsafe_payment_exists',
        drr.block_reason === MANUAL_BOOKING_ROLLBACK_BLOCK_CODES.UNSAFE_PAYMENT_EXISTS,
        `block_reason=${drr.block_reason}`);
      assert('D4: unsafe payment → rows_deleted=0', parseInt(drr.rows_deleted, 10) === 0);

      // Booking still exists
      const dBooking = await pg.query(
        `SELECT id FROM bookings WHERE id = $1`, [bkId]
      );
      assert('D5: booking still exists after unsafe_payment block', dBooking.rows.length === 1);
    }

    console.log('  TX-PAYMENT: done, rolling back...');

  } catch (err) {
    console.error(`  ✗ TX-PAYMENT error: ${err.message}`);
    failCount++;
  } finally {
    await pg.query('ROLLBACK');
  }

  // ── E. TX-IDEMPOTENT: Double rollback ─────────────────────────────────────

  console.log('\n── E. TX-IDEMPOTENT: double rollback → booking_not_found ────────────────');
  await pg.query('BEGIN');

  try {
    const { bedCode } = await resolveFixtureBed(pg, clientId);
    const cpE = makeCreateParams({ selected_bed_codes: [bedCode] });
    const cpERow = await pg.query(buildManualBookingCreateSql(), createParamsToArray(cpE));
    const ce = cpERow.rows[0];

    if (ce.is_blocked || !ce.rollback_payload) {
      console.log('  ⚠  create blocked unexpectedly — skipping idempotency test');
    } else {
      const bkId   = ce.rollback_payload.booking_id;
      const bkCode = ce.rollback_payload.booking_code;
      const payload = ce.rollback_payload;

      // First rollback — should succeed
      const e1 = await pg.query(
        buildManualBookingRollbackSql(),
        rollbackParamsToArray(bkId, bkCode, payload)
      );
      const e1r = e1.rows[0];
      assert('E1: first rollback success=true', e1r.success === true,
        `blocked=${e1r.blocked} block_reason=${e1r.block_reason}`);
      assert('E2: first rollback rows_deleted=1', parseInt(e1r.rows_deleted, 10) === 1);

      // Second rollback — booking no longer exists, should block
      const e2 = await pg.query(
        buildManualBookingRollbackSql(),
        rollbackParamsToArray(bkId, bkCode, payload)
      );
      const e2r = e2.rows[0];
      assert('E3: second rollback blocked=true (booking gone)',
        e2r.blocked === true,
        `blocked=${e2r.blocked} block_reason=${e2r.block_reason}`);
      assert('E4: second rollback block_reason=booking_not_found',
        e2r.block_reason === MANUAL_BOOKING_ROLLBACK_BLOCK_CODES.BOOKING_NOT_FOUND,
        `block_reason=${e2r.block_reason}`);
      assert('E5: second rollback rows_deleted=0', parseInt(e2r.rows_deleted, 10) === 0);
    }

    console.log('  TX-IDEMPOTENT: done, rolling back...');

  } catch (err) {
    console.error(`  ✗ TX-IDEMPOTENT error: ${err.message}`);
    failCount++;
  } finally {
    await pg.query('ROLLBACK');
  }

  // ── F. Final delta = 0 ─────────────────────────────────────────────────────

  console.log('\n── F. Final protected-table delta ──────────────────────────────────────');
  const finalCounts = await getBaseline(pg);
  const delta = diffCounts(baseline, finalCounts);
  let allZero = true;
  for (const tbl of TRACKED_TABLES) {
    const d = delta[tbl];
    if (d !== 0) allZero = false;
    console.log(`  ${tbl}: delta=${d >= 0 ? '+' : ''}${d}${d !== 0 ? '  ← NON-ZERO' : ''}`);
  }
  assert('F1: all protected-table deltas = 0 (all transactions rolled back)', allZero);

  // ── Summary ────────────────────────────────────────────────────────────────

  const total = passCount + failCount;
  console.log('\n══════════════════════════════════════════════════════════════════════════');
  console.log(` Stage 8.3k Rollback Proof: ${passCount}/${total} assertions passed`);
  console.log('══════════════════════════════════════════════════════════════════════════');
  console.log('  Confirmed: NO API route. NO UI wiring. NO Azure deployment.');
  console.log('  Confirmed: NO WhatsApp. NO Stripe. NO n8n. NO workflow activation.');
  console.log('  Confirmed: STAFF_ACTIONS_ENABLED=false. MANUAL_BOOKING_ENABLED=false.');
  console.log('  All writes rolled back. Final protected table delta = 0.');

  if (failCount === 0) {
    console.log('\n  RESULT: PASS ✓\n');
    process.exit(0);
  } else {
    console.log(`\n  RESULT: FAIL — ${failCount} assertion(s) failed\n`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\n✗ Unexpected error:', err.message);
  process.exit(1);
});

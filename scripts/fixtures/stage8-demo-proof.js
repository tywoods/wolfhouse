/**
 * Stage 8.6 — Demo data proof for Luna Front Desk staging.
 *
 * Asserts that all expected demo rows exist in the correct state.
 * Reads the DB without making any modifications.
 *
 * Usage:
 *   WOLFHOUSE_DATABASE_URL="postgres://..." node scripts/fixtures/stage8-demo-proof.js
 *
 * @module stage8-demo-proof
 */

'use strict';

const path = require('path');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '..', 'infra', '.env') });

const PROD_PATTERNS = [
  /wolfhouse\.com(?!\.(test|local|staging|dev))/i,
  /prod(?:uction)?[\-._]/i,
  /\.prod\./i,
  /rds\.amazonaws\.com/i,
  /database\.windows\.net/i,
];

function getConnectionString() {
  return (
    process.env.WOLFHOUSE_DATABASE_URL ||
    `postgres://wolfhouse:${process.env.WOLFHOUSE_DB_PASSWORD || ''}@localhost:5433/wolfhouse`
  );
}

function redactUrl(url) {
  return url.replace(/:([^:@]+)@/, ':***@');
}

function assertNotProduction(url) {
  for (const pat of PROD_PATTERNS) {
    if (pat.test(url)) {
      console.error(`\n✗ SAFETY: Matches production pattern (${pat}). Refusing proof run.\n  URL: ${redactUrl(url)}\n`);
      process.exit(1);
    }
  }
}

let passes = 0;
let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passes++;
  } else {
    console.log(`  ✗  ${label}${detail ? '  →  ' + detail : ''}`);
    failures++;
  }
}

async function main() {
  const connStr = getConnectionString();
  assertNotProduction(connStr);

  console.log('\n── Stage 8.6 Demo Proof ──────────────────────────────────────────────────');
  console.log(`   Target: ${redactUrl(connStr)}`);
  console.log('─────────────────────────────────────────────────────────────────────────\n');

  const client = new Client({ connectionString: connStr });
  await client.connect();

  try {
    await run(client);
  } finally {
    await client.end();
  }

  console.log(`\n── Result ────────────────────────────────────────────────────────────────`);
  console.log(`   ${passes} passed, ${failures} failed`);
  if (failures > 0) {
    console.log('   ✗ FAIL — run stage8-demo-seed.js to populate missing data.\n');
    process.exit(1);
  } else {
    console.log('   ✓ PASS — all demo data present and correct.\n');
  }
}

async function run(db) {

  // ── Row count assertions ───────────────────────────────────────────────────
  console.log('Row counts:');

  const convCount = await db.query(
    `SELECT COUNT(*) FROM conversations WHERE metadata->>'source' = 'stage8_demo'`
  );
  check('conversations = 3', parseInt(convCount.rows[0].count, 10) === 3,
    `got ${convCount.rows[0].count}`);

  const msgCount = await db.query(
    `SELECT COUNT(*) FROM messages WHERE metadata->>'source' = 'stage8_demo'`
  );
  check('messages = 7', parseInt(msgCount.rows[0].count, 10) === 7,
    `got ${msgCount.rows[0].count}`);

  const bookCount = await db.query(
    `SELECT COUNT(*) FROM bookings WHERE metadata->>'source' = 'stage8_demo'`
  );
  check('bookings = 3', parseInt(bookCount.rows[0].count, 10) === 3,
    `got ${bookCount.rows[0].count}`);

  const bbCount = await db.query(
    `SELECT COUNT(*) FROM booking_beds bb
     JOIN bookings b ON b.id = bb.booking_id
     WHERE b.metadata->>'source' = 'stage8_demo'`
  );
  check('booking_beds = 2', parseInt(bbCount.rows[0].count, 10) === 2,
    `got ${bbCount.rows[0].count}`);

  const hCount = await db.query(
    `SELECT COUNT(*) FROM staff_handoffs WHERE metadata->>'source' = 'stage8_demo'`
  );
  check('staff_handoffs = 1', parseInt(hCount.rows[0].count, 10) === 1,
    `got ${hCount.rows[0].count}`);

  const payCount = await db.query(
    `SELECT COUNT(*) FROM payments WHERE metadata->>'source' = 'stage8_demo'`
  );
  check('payments = 2', parseInt(payCount.rows[0].count, 10) === 2,
    `got ${payCount.rows[0].count}`);

  // ── Scenario A spot-checks ─────────────────────────────────────────────────
  console.log('\nScenario A (Sofia Demo):');

  const sofia = await db.query(
    `SELECT id, display_name, needs_human, staff_reply_draft
     FROM conversations WHERE phone = '+34999000001' LIMIT 1`
  );
  check('Sofia conversation exists', sofia.rows.length > 0);
  if (sofia.rows.length > 0) {
    const s = sofia.rows[0];
    check('Sofia needs_human = true', s.needs_human === true, `got ${s.needs_human}`);
    check('Sofia staff_reply_draft exists', !!s.staff_reply_draft, 'draft is null');
  }

  const sofiaHandoff = await db.query(
    `SELECT id, priority, status FROM staff_handoffs
     WHERE phone = '+34999000001' AND status IN ('open','assigned','waiting_guest')
     LIMIT 1`
  );
  check('Sofia open handoff exists', sofiaHandoff.rows.length > 0);
  if (sofiaHandoff.rows.length > 0) {
    check('Sofia handoff priority = urgent',
      sofiaHandoff.rows[0].priority === 'urgent',
      `got ${sofiaHandoff.rows[0].priority}`);
  }

  const sofiaBooking = await db.query(
    `SELECT id, status, payment_status FROM bookings WHERE booking_code = 'DEMO-2601' LIMIT 1`
  );
  check('DEMO-2601 booking exists', sofiaBooking.rows.length > 0);
  if (sofiaBooking.rows.length > 0) {
    check('DEMO-2601 status = hold',
      sofiaBooking.rows[0].status === 'hold',
      `got ${sofiaBooking.rows[0].status}`);
  }

  // ── Scenario B spot-checks ─────────────────────────────────────────────────
  console.log('\nScenario B (Marco Demo):');

  const marcoBooking = await db.query(
    `SELECT id, status, payment_status FROM bookings WHERE booking_code = 'DEMO-2602' LIMIT 1`
  );
  check('DEMO-2602 booking exists', marcoBooking.rows.length > 0);
  if (marcoBooking.rows.length > 0) {
    check('DEMO-2602 status = payment_pending',
      marcoBooking.rows[0].status === 'payment_pending',
      `got ${marcoBooking.rows[0].status}`);
    check('DEMO-2602 payment_status = waiting_payment',
      marcoBooking.rows[0].payment_status === 'waiting_payment',
      `got ${marcoBooking.rows[0].payment_status}`);
  }

  const marcoPayment = await db.query(
    `SELECT id, status FROM payments
     WHERE booking_id = (SELECT id FROM bookings WHERE booking_code = 'DEMO-2602')
       AND metadata->>'source' = 'stage8_demo'
     LIMIT 1`
  );
  check('Marco payment row exists', marcoPayment.rows.length > 0);
  if (marcoPayment.rows.length > 0) {
    check('Marco payment status = pending',
      marcoPayment.rows[0].status === 'pending',
      `got ${marcoPayment.rows[0].status}`);
  }

  // ── Scenario C spot-checks ─────────────────────────────────────────────────
  console.log('\nScenario C (Lena Demo):');

  const lenaBooking = await db.query(
    `SELECT id, status, payment_status, check_in::text AS check_in, check_out::text AS check_out, assignment_status
     FROM bookings WHERE booking_code = 'DEMO-2603' LIMIT 1`
  );
  check('DEMO-2603 booking exists', lenaBooking.rows.length > 0);
  if (lenaBooking.rows.length > 0) {
    const lb = lenaBooking.rows[0];
    check('DEMO-2603 status = confirmed', lb.status === 'confirmed', `got ${lb.status}`);
    check('DEMO-2603 payment_status = paid', lb.payment_status === 'paid', `got ${lb.payment_status}`);
    check('DEMO-2603 assignment_status = assigned', lb.assignment_status === 'assigned', `got ${lb.assignment_status}`);
    check('DEMO-2603 check_in = 2026-07-16', lb.check_in === '2026-07-16', `got ${lb.check_in}`);

    const lenaBeds = await db.query(
      `SELECT COUNT(*) FROM booking_beds WHERE booking_id = $1`,
      [lb.id]
    );
    check('Lena booking_beds = 2',
      parseInt(lenaBeds.rows[0].count, 10) === 2,
      `got ${lenaBeds.rows[0].count}`);
  }

  const lenaPayment = await db.query(
    `SELECT id, status, amount_paid_cents FROM payments
     WHERE booking_id = (SELECT id FROM bookings WHERE booking_code = 'DEMO-2603')
       AND metadata->>'source' = 'stage8_demo'
     LIMIT 1`
  );
  check('Lena payment row exists', lenaPayment.rows.length > 0);
  if (lenaPayment.rows.length > 0) {
    check('Lena payment status = paid',
      lenaPayment.rows[0].status === 'paid',
      `got ${lenaPayment.rows[0].status}`);
  }

  // ── Demo rooms/beds ───────────────────────────────────────────────────────
  console.log('\nDemo rooms/beds (only present when staging has no real rooms):');

  const demoRooms = await db.query(
    `SELECT COUNT(*) FROM rooms WHERE room_code LIKE 'DEMO-%'`
  );
  const demoBeds = await db.query(
    `SELECT COUNT(*) FROM beds WHERE bed_code LIKE 'DEMO-%'`
  );
  const demoRoomCount = parseInt(demoRooms.rows[0].count, 10);
  const demoBedCount  = parseInt(demoBeds.rows[0].count, 10);
  console.log(`  demo rooms: ${demoRoomCount}  demo beds: ${demoBedCount}  (0 = staging has real room data)`);

  // ── Tagging check ─────────────────────────────────────────────────────────
  console.log('\nTagging:');

  const untaggedConvs = await db.query(
    `SELECT COUNT(*) FROM conversations WHERE phone = ANY(ARRAY['+34999000001','+34999000002','+34999000003'])
     AND (metadata->>'source') IS DISTINCT FROM 'stage8_demo'`
  );
  check('All demo conversations tagged stage8_demo',
    parseInt(untaggedConvs.rows[0].count, 10) === 0,
    `${untaggedConvs.rows[0].count} untagged`);

  const untaggedBooks = await db.query(
    `SELECT COUNT(*) FROM bookings WHERE booking_code LIKE 'DEMO-%'
     AND (metadata->>'source') IS DISTINCT FROM 'stage8_demo'`
  );
  check('All demo bookings tagged stage8_demo',
    parseInt(untaggedBooks.rows[0].count, 10) === 0,
    `${untaggedBooks.rows[0].count} untagged`);
}

main().catch(err => {
  console.error('\n✗ Proof failed unexpectedly:', err.message);
  process.exit(1);
});

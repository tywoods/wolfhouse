'use strict';
/**
 * Stage 5 — Migration 007+008 fixture smoke proof.
 *
 * Proves add-on and staff-handoff schemas work against the live dev DB.
 * Runs safe fixture inserts, verifies staff query helpers return expected rows,
 * tests staff_handoffs idempotency, then cleans up all fixture rows.
 *
 * Fixture scope:
 *   client: wolfhouse-somo
 *   phones: +34600000170, +34600000171
 *   booking_code: WH-5MIG-ADDON-001, WH-5MIG-HOFF-001
 *   add_on_order_code: AO-5MIG-001
 *
 * Non-negotiables:
 *   - No workflow activation.
 *   - No webhook POST.
 *   - No WhatsApp / Stripe / Airtable writes.
 *   - Cleanup always runs (finally block).
 *
 * Usage: node scripts/verify-stage5-migrations-smoke.js
 */

const { withPgClient } = require('./lib/pg-connect');
const addOnQ = require('./lib/staff-addon-queries');
const handoffQ = require('./lib/staff-handoff-queries');

const CLIENT_SLUG = 'wolfhouse-somo';
const PHONE_ADDON = '+34600000170';
const PHONE_HOFF  = '+34600000171';
const BOOKING_CODE_ADDON = 'WH-5MIG-ADDON-001';
const BOOKING_CODE_HOFF  = 'WH-5MIG-HOFF-001';
const ORDER_CODE  = 'AO-5MIG-001';
const CHECK_IN    = '2026-09-01';
const CHECK_OUT   = '2026-09-08';
const LESSON_DATE = '2026-09-03';
const MEAL_DATE   = '2026-09-04';

let failures = 0;
function ok(label)        { console.log(`  ✓ ${label}`); }
function fail(label, why) { console.error(`  ✗ ${label}${why ? ': ' + why : ''}`); failures++; }
function check(cond, pass, failLabel, why) {
  if (cond) ok(pass); else fail(failLabel || pass, why);
}
function assertCount(label, rows, expected) {
  check(rows.length === expected, `${label}: count=${rows.length} (expected ${expected})`);
}

async function cleanup(c, clientId) {
  // Remove in FK-safe order
  await c.query('DELETE FROM staff_tasks    WHERE client_id = $1', [clientId]);
  await c.query('DELETE FROM staff_handoffs WHERE client_id = $1', [clientId]);
  await c.query(`DELETE FROM transfer_requests WHERE booking_id IN
    (SELECT id FROM bookings WHERE client_id = $1)`, [clientId]);
  await c.query(`DELETE FROM meal_requests     WHERE booking_id IN
    (SELECT id FROM bookings WHERE client_id = $1)`, [clientId]);
  await c.query(`DELETE FROM rental_requests   WHERE booking_id IN
    (SELECT id FROM bookings WHERE client_id = $1)`, [clientId]);
  await c.query(`DELETE FROM yoga_requests     WHERE booking_id IN
    (SELECT id FROM bookings WHERE client_id = $1)`, [clientId]);
  await c.query(`DELETE FROM lesson_requests   WHERE booking_id IN
    (SELECT id FROM bookings WHERE client_id = $1)`, [clientId]);
  await c.query(`DELETE FROM add_on_items  WHERE order_id IN
    (SELECT id FROM add_on_orders WHERE client_id = $1)`, [clientId]);
  await c.query('DELETE FROM add_on_orders WHERE client_id = $1', [clientId]);
  await c.query('DELETE FROM conversations  WHERE client_id = $1', [clientId]);
  await c.query(`DELETE FROM bookings WHERE client_id = $1
    AND booking_code IN ($2, $3)`, [clientId, BOOKING_CODE_ADDON, BOOKING_CODE_HOFF]);
}

withPgClient(async c => {
  // ── 0. Resolve client_id ──────────────────────────────────────────────────
  console.log('\n── 0. Resolve client ──');
  const clientR = await c.query('SELECT id FROM clients WHERE slug = $1', [CLIENT_SLUG]);
  if (!clientR.rows.length) { fail('client found'); process.exit(1); }
  const clientId = clientR.rows[0].id;
  ok(`client found: ${clientId}`);

  // Always cleanup first (idempotency)
  await cleanup(c, clientId);
  console.log('  Pre-cleanup done.');

  try {
    // ── 1. Seed fixture bookings ───────────────────────────────────────────
    console.log('\n── 1. Seed fixture bookings ──');
    const bAddonR = await c.query(`
      INSERT INTO bookings (client_id, booking_code, phone, guest_name,
        check_in, check_out, status, payment_status)
      VALUES ($1,$2,$3,'Fixture Addon Guest',$4,$5,'payment_pending','waiting_payment')
      RETURNING id`,
      [clientId, BOOKING_CODE_ADDON, PHONE_ADDON, CHECK_IN, CHECK_OUT]);
    const bookingAddonId = bAddonR.rows[0].id;
    ok(`booking ${BOOKING_CODE_ADDON}: ${bookingAddonId}`);

    const bHoffR = await c.query(`
      INSERT INTO bookings (client_id, booking_code, phone, guest_name,
        check_in, check_out, status, payment_status)
      VALUES ($1,$2,$3,'Fixture Handoff Guest',$4,$5,'payment_pending','waiting_payment')
      RETURNING id`,
      [clientId, BOOKING_CODE_HOFF, PHONE_HOFF, CHECK_IN, CHECK_OUT]);
    const bookingHoffId = bHoffR.rows[0].id;
    ok(`booking ${BOOKING_CODE_HOFF}: ${bookingHoffId}`);

    // ── 2. Seed conversation (for handoff FK) ──────────────────────────────
    console.log('\n── 2. Seed fixture conversation ──');
    const convR = await c.query(`
      INSERT INTO conversations (client_id, phone, needs_human, conversation_stage)
      VALUES ($1,$2,TRUE,'human_handoff') RETURNING id`,
      [clientId, PHONE_HOFF]);
    const convId = convR.rows[0].id;
    ok(`conversation: ${convId}`);

    // ── 3. Seed add_on_orders + items + typed requests ─────────────────────
    console.log('\n── 3. Seed add-on order + items ──');
    const orderR = await c.query(`
      INSERT INTO add_on_orders (client_id, booking_id, phone, order_code,
        status, payment_status, total_amount_cents, currency)
      VALUES ($1,$2,$3,$4,'pending_staff','not_requested',13000,'EUR')
      RETURNING id`,
      [clientId, bookingAddonId, PHONE_ADDON, ORDER_CODE]);
    const orderId = orderR.rows[0].id;
    ok(`add_on_order: ${orderId}`);

    const lessonItemR = await c.query(`
      INSERT INTO add_on_items (order_id, item_type, item_name, quantity,
        unit_price_cents, total_price_cents, service_date, fulfillment_status)
      VALUES ($1,'surf_lesson','Surf Lesson',2,3250,6500,$2,'requested')
      RETURNING id`, [orderId, LESSON_DATE]);
    const lessonItemId = lessonItemR.rows[0].id;
    ok(`lesson item: ${lessonItemId}`);

    await c.query(`
      INSERT INTO lesson_requests (add_on_item_id, booking_id, guest_count,
        lesson_date, scheduling_status)
      VALUES ($1,$2,2,$3,'staff_required')`,
      [lessonItemId, bookingAddonId, LESSON_DATE]);
    ok('lesson_request seeded');

    const mealItemR = await c.query(`
      INSERT INTO add_on_items (order_id, item_type, item_name, quantity,
        unit_price_cents, total_price_cents, service_date, fulfillment_status)
      VALUES ($1,'dinner_meal','Dinner',2,3250,6500,$2,'requested')
      RETURNING id`, [orderId, MEAL_DATE]);
    const mealItemId = mealItemR.rows[0].id;
    await c.query(`
      INSERT INTO meal_requests (add_on_item_id, booking_id, meal_type,
        meal_date, guest_count, service_status)
      VALUES ($1,$2,'dinner',$3,2,'requested')`,
      [mealItemId, bookingAddonId, MEAL_DATE]);
    ok('meal_request seeded');

    // ── 4. Seed staff_handoffs + staff_tasks ───────────────────────────────
    console.log('\n── 4. Seed staff handoffs ──');
    const hoffR = await c.query(`
      INSERT INTO staff_handoffs (client_id, conversation_id, booking_id, phone,
        reason_code, summary, priority, status)
      VALUES ($1,$2,$3,$4,'cancellation_request','Guest wants to cancel','high','open')
      RETURNING id`,
      [clientId, convId, bookingHoffId, PHONE_HOFF]);
    const hoffId = hoffR.rows[0].id;
    ok(`staff_handoff: ${hoffId}`);

    await c.query(`
      INSERT INTO staff_tasks (client_id, handoff_id, booking_id, task_type,
        title, status, priority)
      VALUES ($1,$2,$3,'cancellation','Review cancellation request','open','high')`,
      [clientId, hoffId, bookingHoffId]);
    ok('staff_task seeded');

    // ── 5. Run add-on queries ──────────────────────────────────────────────
    console.log('\n── 5. Staff add-on queries ──');

    const unpaid = await c.query(addOnQ.getUnpaidAddOnsQuery(), [CLIENT_SLUG]);
    const unpaidFixture = unpaid.rows.filter(r => r.order_code === ORDER_CODE);
    assertCount('unpaid add-ons (fixture)', unpaidFixture, 1);

    const lessons = await c.query(addOnQ.getLessonsByDateQuery(), [CLIENT_SLUG, LESSON_DATE]);
    const lessonFixture = lessons.rows.filter(r => r.booking_code === BOOKING_CODE_ADDON);
    assertCount('lessons on date (fixture)', lessonFixture, 1);

    const meals = await c.query(addOnQ.getMealsByDateQuery(), [CLIENT_SLUG, MEAL_DATE]);
    const mealFixture = meals.rows.filter(r => r.booking_code === BOOKING_CODE_ADDON);
    assertCount('meals on date (fixture)', mealFixture, 1);

    const staffReq = await c.query(addOnQ.getStaffRequiredAddOnsQuery(), [CLIENT_SLUG]);
    const staffReqFixture = staffReq.rows.filter(r => r.booking_code === BOOKING_CODE_ADDON);
    assertCount('staff-required add-ons (fixture)', staffReqFixture, 1);

    const byBooking = await c.query(addOnQ.getAddonsByBookingQuery(), [CLIENT_SLUG, BOOKING_CODE_ADDON]);
    assertCount('add-ons by booking (fixture)', byBooking.rows, 2); // lesson + meal items

    // ── 6. Run handoff queries ─────────────────────────────────────────────
    console.log('\n── 6. Staff handoff queries ──');

    const openH = await c.query(handoffQ.getOpenHandoffsQuery(), [CLIENT_SLUG]);
    const openFixture = openH.rows.filter(r => r.phone === PHONE_HOFF);
    assertCount('open handoffs (fixture)', openFixture, 1);
    check(openFixture[0]?.reason_code === 'cancellation_request',
      'reason_code = cancellation_request');

    const highH = await c.query(handoffQ.getHighPriorityHandoffsQuery(), [CLIENT_SLUG]);
    const highFixture = highH.rows.filter(r => r.phone === PHONE_HOFF);
    assertCount('high-priority handoffs (fixture)', highFixture, 1);

    const byReason = await c.query(handoffQ.getHandoffsByReasonQuery(), [CLIENT_SLUG, 'cancellation_request']);
    const byReasonFixture = byReason.rows.filter(r => r.phone === PHONE_HOFF);
    assertCount('handoffs by reason (fixture)', byReasonFixture, 1);

    const cancelH = await c.query(handoffQ.getCancellationRefundHandoffsQuery(), [CLIENT_SLUG]);
    const cancelFixture = cancelH.rows.filter(r => r.phone === PHONE_HOFF);
    assertCount('cancellation/refund handoffs (fixture)', cancelFixture, 1);

    const bookingH = await c.query(handoffQ.getBookingHandoffsQuery(), [CLIENT_SLUG, BOOKING_CODE_HOFF]);
    assertCount('booking-linked handoffs (fixture)', bookingH.rows, 1);

    // Reconciliation query: needs_human=TRUE but no open handoff? Should be 0 for PHONE_HOFF (has open handoff)
    const reconcile = await c.query(handoffQ.getNeedsHumanWithoutOpenHandoffQuery(), [CLIENT_SLUG]);
    const reconcileFixture = reconcile.rows.filter(r => r.phone === PHONE_HOFF);
    assertCount('reconciliation gap for PHONE_HOFF (should be 0 — has open handoff)', reconcileFixture, 0);

    // ── 7. Idempotency test: duplicate open handoff should conflict ─────────
    console.log('\n── 7. Idempotency test ──');
    let dupErrorCaught = false;
    try {
      await c.query(`
        INSERT INTO staff_handoffs (client_id, conversation_id, booking_id, phone,
          reason_code, summary, priority, status)
        VALUES ($1,$2,$3,$4,'cancellation_request','Duplicate attempt','high','open')`,
        [clientId, convId, bookingHoffId, PHONE_HOFF]);
    } catch (e) {
      if (e.code === '23505') { // unique_violation
        dupErrorCaught = true;
        ok('idempotency: duplicate open handoff correctly rejected (23505 unique_violation)');
      } else {
        fail('idempotency: unexpected error', e.message);
      }
    }
    if (!dupErrorCaught) fail('idempotency: duplicate insert should have been rejected');

  } finally {
    // ── 8. Cleanup ────────────────────────────────────────────────────────
    console.log('\n── 8. Cleanup ──');
    await cleanup(c, clientId);
    ok('fixture rows removed');

    // Post-cleanup verification
    const postAddon = await c.query(
      'SELECT COUNT(*) AS n FROM add_on_orders WHERE client_id = $1', [clientId]);
    check(parseInt(postAddon.rows[0].n) === 0, 'add_on_orders: 0 fixture rows after cleanup');

    const postHoff = await c.query(
      'SELECT COUNT(*) AS n FROM staff_handoffs WHERE client_id = $1', [clientId]);
    check(parseInt(postHoff.rows[0].n) === 0, 'staff_handoffs: 0 fixture rows after cleanup');

    const postBookings = await c.query(
      `SELECT COUNT(*) AS n FROM bookings WHERE client_id = $1
       AND booking_code IN ($2,$3)`,
      [clientId, BOOKING_CODE_ADDON, BOOKING_CODE_HOFF]);
    check(parseInt(postBookings.rows[0].n) === 0, 'bookings: 0 fixture rows after cleanup');
  }

  // ── Result ────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  if (failures === 0) {
    console.log('Result: PASS — all checks green (0 failures)');
    process.exit(0);
  } else {
    console.error(`Result: FAIL — ${failures} check(s) failed`);
    process.exit(1);
  }
}).catch(e => { console.error('Fatal:', e.message); process.exit(1); });

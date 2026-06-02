/**
 * Stage 8.6 — Demo data seed for Luna Front Desk staging.
 *
 * Inserts 3 clearly-fake demo guest scenarios so the hosted dashboard
 * shows non-zero state for an Ale/Cami walkthrough.
 *
 *   A. Sofia Demo  — needs_human=true, urgent handoff, date-change request
 *   B. Marco Demo  — payment_pending, waiting_payment
 *   C. Lena Demo   — confirmed booking, bed assigned, visible in Jul 16–22 calendar
 *
 * Safety:
 *   - Refuses to run against any URL that looks like a production host.
 *   - No external API calls. No WhatsApp. No Stripe. No workflow activation.
 *   - Idempotent: skips insert if phone/booking_code already exists.
 *
 * Usage:
 *   WOLFHOUSE_DATABASE_URL="postgres://..." node scripts/fixtures/stage8-demo-seed.js
 *
 * @module stage8-demo-seed
 */

'use strict';

const path = require('path');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '..', 'infra', '.env') });

// ─── Safety ───────────────────────────────────────────────────────────────────

const PROD_PATTERNS = [
  /wolfhouse\.com(?!\.(test|local|staging|dev))/i,
  /prod(?:uction)?[\-._]/i,
  /\.prod\./i,
  /rds\.amazonaws\.com/i,
  /database\.windows\.net/i,
];

const DEMO_TAG = { source: 'stage8_demo', note: 'Stage 8 demo data — safe to delete' };

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
      console.error(`\n✗ SAFETY: Connection string matches production pattern (${pat}).\n  Refusing to seed demo data to a production database.\n  URL (redacted): ${redactUrl(url)}\n`);
      process.exit(1);
    }
  }
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r.toISOString().slice(0, 10);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const connStr = getConnectionString();
  assertNotProduction(connStr);

  console.log('\n── Stage 8.6 Demo Seed ───────────────────────────────────────────────────');
  console.log(`   Target: ${redactUrl(connStr)}`);
  console.log('   Safety: not production ✓');
  console.log('   Mode:   idempotent — skips existing rows');
  console.log('─────────────────────────────────────────────────────────────────────────\n');

  const client = new Client({ connectionString: connStr });
  await client.connect();

  try {
    await run(client);
  } finally {
    await client.end();
  }
}

async function run(db) {
  const today = new Date().toISOString().slice(0, 10);

  // ── 1. Resolve client_id ───────────────────────────────────────────────────
  const clientRow = await db.query(
    `SELECT id FROM clients WHERE slug = $1 LIMIT 1`,
    ['wolfhouse-somo']
  );
  if (clientRow.rows.length === 0) {
    console.error('✗ Client wolfhouse-somo not found. Cannot seed demo data.');
    process.exit(1);
  }
  const clientId = clientRow.rows[0].id;
  console.log(`Client wolfhouse-somo → id: ${clientId}`);

  // ── 2. Resolve (or create) bed IDs for Lena Demo (Scenario C) ────────────
  let bedsRows = await db.query(
    `SELECT b.id, b.bed_code, b.bed_label, b.planning_row_label, r.room_code, r.name AS room_name
     FROM beds b
     JOIN rooms r ON r.id = b.room_id
     WHERE b.client_id = $1 AND b.active = TRUE AND b.sellable = TRUE
     ORDER BY r.sort_order NULLS LAST, r.room_code, b.bed_number NULLS LAST, b.bed_code
     LIMIT 4`,
    [clientId]
  );
  if (bedsRows.rows.length < 2) {
    console.log(`  No sellable beds found — creating demo rooms + beds for staging...`);
    await upsertDemoRoomsAndBeds(db, clientId);
    bedsRows = await db.query(
      `SELECT b.id, b.bed_code, b.bed_label, b.planning_row_label, r.room_code, r.name AS room_name
       FROM beds b
       JOIN rooms r ON r.id = b.room_id
       WHERE b.client_id = $1 AND b.active = TRUE AND b.sellable = TRUE
         AND b.bed_code LIKE 'DEMO-%'
       ORDER BY r.room_code, b.bed_code
       LIMIT 4`,
      [clientId]
    );
    if (bedsRows.rows.length < 2) {
      console.error(`✗ Still not enough beds after demo room creation (${bedsRows.rows.length}). Aborting.`);
      process.exit(1);
    }
    console.log(`  Demo rooms/beds created.`);
  }
  const bed1 = bedsRows.rows[0];
  const bed2 = bedsRows.rows[1];
  console.log(`Beds for Lena: ${bed1.bed_code} (${bed1.room_code}), ${bed2.bed_code} (${bed2.room_code})`);

  // ── 3. Scenario dates ──────────────────────────────────────────────────────
  const sofiaCi = addDays(today, 7);
  const sofiaCo = addDays(today, 10);
  const marcoCi = addDays(today, 14);
  const marcoCo = addDays(today, 17);
  const lenaCi  = '2026-07-16';
  const lenaCo  = '2026-07-22';

  console.log(`\nScenario A (Sofia):  ${sofiaCi} → ${sofiaCo}`);
  console.log(`Scenario B (Marco):  ${marcoCi} → ${marcoCo}`);
  console.log(`Scenario C (Lena):   ${lenaCi}  → ${lenaCo}  (fixed, matches default calendar)`);

  const counts = {
    conversations: 0,
    messages: 0,
    bookings: 0,
    booking_beds: 0,
    staff_handoffs: 0,
    payments: 0,
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO A — Sofia Demo: needs-human, urgent date-change handoff
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n── Scenario A: Sofia Demo ────────────────────────────────────────────────');

  // A1. Booking
  const sofiaBooking = await upsertBooking(db, {
    clientId, bookingCode: 'DEMO-2601', guestName: 'Sofia Demo',
    phone: '+34999000001', email: 'sofia.demo@example.test',
    status: 'hold', paymentStatus: 'not_requested', assignmentStatus: 'unassigned',
    checkIn: sofiaCi, checkOut: sofiaCo, guestCount: 1,
    totalAmountCents: 18000, depositRequiredCents: 9000, balanceDueCents: 18000,
    holdExpiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    staffNotes: 'Stage 8 demo data — date change request scenario',
    metadata: DEMO_TAG,
  });
  counts.bookings += sofiaBooking.inserted ? 1 : 0;
  const sofiaBookingId = sofiaBooking.id;
  console.log(`  Booking DEMO-2601: ${sofiaBooking.inserted ? 'inserted' : 'already existed'} (id: ${sofiaBookingId})`);

  // A2. Conversation
  const sofiaDraft = 'Hi Sofia! Thanks for reaching out. Let me check our availability for July 5th and get back to you shortly. We want to make this work for you! 🙏';
  const sofiaConv = await upsertConversation(db, {
    clientId, phone: '+34999000001', displayName: 'Sofia Demo',
    email: 'sofia.demo@example.test', language: 'en',
    needsHuman: true, status: 'open', botMode: 'bot',
    conversationStage: 'booking_active',
    lastMessagePreview: 'Hola, is it possible to move my check-in to July 5th? I had a flight change.',
    staffReplyDraft: sofiaDraft,
    currentHoldBookingId: sofiaBookingId,
    metadata: DEMO_TAG,
  });
  counts.conversations += sofiaConv.inserted ? 1 : 0;
  const sofiaConvId = sofiaConv.id;
  console.log(`  Conversation Sofia: ${sofiaConv.inserted ? 'inserted' : 'already existed'} (id: ${sofiaConvId})`);

  // A3. Messages
  const sofiaMsgs = [
    { direction: 'inbound',  text: 'Hola! I just booked the surf week package for July 9th. Could I change to July 5th? My flight changed last minute.' },
    { direction: 'outbound', text: 'Hi Sofia! Got your message — let me check availability for July 5th and come back to you shortly.' },
    { direction: 'inbound',  text: 'Thanks! Also, would the price change? Same package or different?' },
  ];
  const sofiaInserted = await insertMessages(db, clientId, sofiaConvId, sofiaMsgs);
  counts.messages += sofiaInserted;
  console.log(`  Messages Sofia: ${sofiaInserted} inserted`);

  // A4. Staff handoff
  const sofiaHandoff = await upsertHandoff(db, {
    clientId, conversationId: sofiaConvId, bookingId: sofiaBookingId,
    phone: '+34999000001',
    reasonCode: 'date_change_request',
    summary: 'Guest wants to move check-in from original date to July 5th. Needs staff to check availability and confirm. Guest is also asking whether the price changes.',
    guestMessage: 'Could I change my check-in to July 5th? My flight changed last minute.',
    priority: 'urgent', status: 'open',
    openedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    firstResponseDueAt: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
    metadata: DEMO_TAG,
  });
  counts.staff_handoffs += sofiaHandoff.inserted ? 1 : 0;
  console.log(`  Handoff Sofia: ${sofiaHandoff.inserted ? 'inserted' : 'already existed'}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO B — Marco Demo: payment_pending, waiting_payment
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n── Scenario B: Marco Demo ────────────────────────────────────────────────');

  // B1. Booking
  const marcoBooking = await upsertBooking(db, {
    clientId, bookingCode: 'DEMO-2602', guestName: 'Marco Demo',
    phone: '+34999000002', email: 'marco.demo@example.test',
    status: 'payment_pending', paymentStatus: 'waiting_payment', assignmentStatus: 'unassigned',
    checkIn: marcoCi, checkOut: marcoCo, guestCount: 1,
    totalAmountCents: 20000, depositRequiredCents: 10000, balanceDueCents: 20000,
    holdExpiresAt: null,
    staffNotes: 'Stage 8 demo data — payment pending scenario',
    metadata: DEMO_TAG,
  });
  counts.bookings += marcoBooking.inserted ? 1 : 0;
  const marcoBookingId = marcoBooking.id;
  console.log(`  Booking DEMO-2602: ${marcoBooking.inserted ? 'inserted' : 'already existed'} (id: ${marcoBookingId})`);

  // B2. Conversation
  const marcoDraft = "Hi Marco! We're checking our records now. We'll confirm as soon as the transfer clears — usually within 1 business day. Thanks for your patience!";
  const marcoConv = await upsertConversation(db, {
    clientId, phone: '+34999000002', displayName: 'Marco Demo',
    email: 'marco.demo@example.test', language: 'en',
    needsHuman: false, status: 'open', botMode: 'bot',
    conversationStage: 'payment_pending',
    lastMessagePreview: 'I sent the payment yesterday via bank transfer — can you confirm receipt?',
    staffReplyDraft: marcoDraft,
    currentHoldBookingId: marcoBookingId,
    metadata: DEMO_TAG,
  });
  counts.conversations += marcoConv.inserted ? 1 : 0;
  const marcoConvId = marcoConv.id;
  console.log(`  Conversation Marco: ${marcoConv.inserted ? 'inserted' : 'already existed'} (id: ${marcoConvId})`);

  // B3. Messages
  const marcoMsgs = [
    { direction: 'inbound',  text: 'Hi! I completed the bank transfer for booking DEMO-2602 yesterday afternoon. Can you confirm you received it?' },
    { direction: 'outbound', text: "Hi Marco! Thanks for the transfer. We'll check and confirm within 1 business day. 👍" },
  ];
  const marcoInserted = await insertMessages(db, clientId, marcoConvId, marcoMsgs);
  counts.messages += marcoInserted;
  console.log(`  Messages Marco: ${marcoInserted} inserted`);

  // B4. Payment row
  const marcoPayment = await upsertPayment(db, {
    clientId, bookingId: marcoBookingId,
    status: 'pending', paymentKind: 'deposit_only',
    amountDueCents: 10000, amountPaidCents: 0,
    stripePaymentIntentId: null,
    metadata: DEMO_TAG,
  });
  counts.payments += marcoPayment.inserted ? 1 : 0;
  console.log(`  Payment Marco: ${marcoPayment.inserted ? 'inserted' : 'already existed'}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO C — Lena Demo: confirmed, bed assigned, bed calendar visible
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n── Scenario C: Lena Demo ─────────────────────────────────────────────────');

  // C1. Booking
  const lenaBooking = await upsertBooking(db, {
    clientId, bookingCode: 'DEMO-2603', guestName: 'Lena Demo',
    phone: '+34999000003', email: 'lena.demo@example.test',
    status: 'confirmed', paymentStatus: 'paid', assignmentStatus: 'assigned',
    checkIn: lenaCi, checkOut: lenaCo, guestCount: 2,
    totalAmountCents: 58000, depositRequiredCents: 29000, balanceDueCents: 0,
    amountPaidCents: 58000,
    holdExpiresAt: null,
    primaryRoomCode: bed1.room_code,
    staffNotes: 'Stage 8 demo data — confirmed booking + bed calendar scenario',
    metadata: DEMO_TAG,
  });
  counts.bookings += lenaBooking.inserted ? 1 : 0;
  const lenaBookingId = lenaBooking.id;
  console.log(`  Booking DEMO-2603: ${lenaBooking.inserted ? 'inserted' : 'already existed'} (id: ${lenaBookingId})`);

  // C2. Conversation
  const lenaConv = await upsertConversation(db, {
    clientId, phone: '+34999000003', displayName: 'Lena Demo',
    email: 'lena.demo@example.test', language: 'en',
    needsHuman: false, status: 'open', botMode: 'bot',
    conversationStage: 'confirmed',
    lastMessagePreview: "Can't wait for the surf week! See you soon 🤙",
    staffReplyDraft: null,
    currentHoldBookingId: null,
    metadata: DEMO_TAG,
  });
  counts.conversations += lenaConv.inserted ? 1 : 0;
  const lenaConvId = lenaConv.id;
  console.log(`  Conversation Lena: ${lenaConv.inserted ? 'inserted' : 'already existed'} (id: ${lenaConvId})`);

  // C3. Messages
  const lenaMsgs = [
    { direction: 'outbound', text: 'Hi Lena! Your booking for July 16–22 is confirmed. We\'re looking forward to welcoming you! 🏄' },
    { direction: 'inbound',  text: "Amazing, can't wait! Do I need to bring anything specific for the surf lessons?" },
  ];
  const lenaInserted = await insertMessages(db, clientId, lenaConvId, lenaMsgs);
  counts.messages += lenaInserted;
  console.log(`  Messages Lena: ${lenaInserted} inserted`);

  // C4. Booking beds
  const bbInserted = await upsertBookingBeds(db, clientId, lenaBookingId, [
    { bed: bed1, guestName: 'Lena Demo',      startDate: lenaCi, endDate: lenaCo },
    { bed: bed2, guestName: 'Lena Demo (+1)', startDate: lenaCi, endDate: lenaCo },
  ]);
  counts.booking_beds += bbInserted;
  console.log(`  Booking beds Lena: ${bbInserted} inserted`);

  // C5. Payment
  const lenaPayment = await upsertPayment(db, {
    clientId, bookingId: lenaBookingId,
    status: 'paid', paymentKind: 'full_amount',
    amountDueCents: 58000, amountPaidCents: 58000,
    stripePaymentIntentId: 'demo_pi_stage8_lena',
    paidAt: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
    metadata: DEMO_TAG,
  });
  counts.payments += lenaPayment.inserted ? 1 : 0;
  console.log(`  Payment Lena: ${lenaPayment.inserted ? 'inserted' : 'already existed'}`);

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n── Seed summary ──────────────────────────────────────────────────────────');
  for (const [tbl, n] of Object.entries(counts)) {
    console.log(`  ${tbl.padEnd(18)} ${n} inserted`);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`  ${'TOTAL'.padEnd(18)} ${total} rows`);
  console.log('\n✓ Seed complete.\n');
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function upsertBooking(db, opts) {
  const check = await db.query(
    `SELECT id FROM bookings WHERE client_id = $1 AND booking_code = $2 LIMIT 1`,
    [opts.clientId, opts.bookingCode]
  );
  if (check.rows.length > 0) {
    return { id: check.rows[0].id, inserted: false };
  }
  const r = await db.query(
    `INSERT INTO bookings
       (client_id, booking_code, guest_name, phone, email,
        status, payment_status, assignment_status,
        check_in, check_out, guest_count,
        total_amount_cents, deposit_required_cents, balance_due_cents,
        amount_paid_cents, hold_expires_at, primary_room_code,
        booking_source, staff_notes, metadata)
     VALUES ($1,$2,$3,$4,$5,
             $6::booking_status,$7::payment_status,$8::assignment_status,
             $9,$10,$11,$12,$13,$14,$15,$16,$17,
             'manual_staff',$18,$19::jsonb)
     RETURNING id`,
    [
      opts.clientId, opts.bookingCode, opts.guestName, opts.phone, opts.email,
      opts.status, opts.paymentStatus, opts.assignmentStatus,
      opts.checkIn, opts.checkOut, opts.guestCount,
      opts.totalAmountCents || null, opts.depositRequiredCents || null,
      opts.balanceDueCents || null, opts.amountPaidCents || null,
      opts.holdExpiresAt || null, opts.primaryRoomCode || null,
      opts.staffNotes || null,
      JSON.stringify(opts.metadata),
    ]
  );
  return { id: r.rows[0].id, inserted: true };
}

async function upsertConversation(db, opts) {
  const check = await db.query(
    `SELECT id FROM conversations WHERE client_id = $1 AND phone = $2 LIMIT 1`,
    [opts.clientId, opts.phone]
  );
  if (check.rows.length > 0) {
    // Update critical fields on re-run to keep demo fresh
    await db.query(
      `UPDATE conversations SET
         needs_human = $3, staff_reply_draft = $4, last_message_preview = $5,
         current_hold_booking_id = $6, updated_at = NOW()
       WHERE id = $7`,
      [opts.needsHuman, opts.staffReplyDraft || null, opts.lastMessagePreview,
       opts.currentHoldBookingId || null, check.rows[0].id]
    );
    return { id: check.rows[0].id, inserted: false };
  }
  const r = await db.query(
    `INSERT INTO conversations
       (client_id, phone, display_name, email, language,
        needs_human, status, bot_mode, conversation_stage,
        last_message_preview, staff_reply_draft,
        current_hold_booking_id, metadata)
     VALUES ($1,$2,$3,$4,$5,
             $6,$7::conversation_status,$8::bot_mode,$9,
             $10,$11,$12,$13::jsonb)
     RETURNING id`,
    [
      opts.clientId, opts.phone, opts.displayName, opts.email, opts.language || 'en',
      opts.needsHuman, opts.status, opts.botMode, opts.conversationStage || null,
      opts.lastMessagePreview || null, opts.staffReplyDraft || null,
      opts.currentHoldBookingId || null,
      JSON.stringify(opts.metadata),
    ]
  );
  return { id: r.rows[0].id, inserted: true };
}

async function insertMessages(db, clientId, conversationId, msgs) {
  // Check if messages already exist for this conversation to stay idempotent
  const existing = await db.query(
    `SELECT COUNT(*) AS n FROM messages WHERE client_id = $1 AND conversation_id = $2`,
    [clientId, conversationId]
  );
  if (parseInt(existing.rows[0].n, 10) >= msgs.length) {
    return 0; // already seeded
  }
  let inserted = 0;
  for (const m of msgs) {
    await db.query(
      `INSERT INTO messages
         (client_id, conversation_id, direction, message_text, source, metadata)
       VALUES ($1,$2,$3::message_direction,$4,'stage8_demo',$5::jsonb)`,
      [clientId, conversationId, m.direction, m.text, JSON.stringify(DEMO_TAG)]
    );
    inserted++;
  }
  return inserted;
}

async function upsertHandoff(db, opts) {
  // Check using the partial unique index: (client_id, conversation_id, reason_code) where status open
  const check = await db.query(
    `SELECT id FROM staff_handoffs
     WHERE client_id = $1 AND conversation_id = $2 AND reason_code = $3
       AND status IN ('open','assigned','waiting_guest')
     LIMIT 1`,
    [opts.clientId, opts.conversationId, opts.reasonCode]
  );
  if (check.rows.length > 0) {
    return { id: check.rows[0].id, inserted: false };
  }
  const r = await db.query(
    `INSERT INTO staff_handoffs
       (client_id, conversation_id, booking_id, phone,
        reason_code, summary, guest_message, language,
        priority, status, opened_at, first_response_due_at, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
     RETURNING id`,
    [
      opts.clientId, opts.conversationId, opts.bookingId, opts.phone,
      opts.reasonCode, opts.summary, opts.guestMessage || null, opts.language || 'en',
      opts.priority, opts.status,
      opts.openedAt || null, opts.firstResponseDueAt || null,
      JSON.stringify(opts.metadata),
    ]
  );
  return { id: r.rows[0].id, inserted: true };
}

async function upsertBookingBeds(db, clientId, bookingId, assignments) {
  // Idempotent: check if beds already assigned for this booking
  const existing = await db.query(
    `SELECT COUNT(*) AS n FROM booking_beds WHERE client_id = $1 AND booking_id = $2`,
    [clientId, bookingId]
  );
  if (parseInt(existing.rows[0].n, 10) >= assignments.length) {
    return 0; // already seeded
  }
  let inserted = 0;
  for (const a of assignments) {
    await db.query(
      `INSERT INTO booking_beds
         (client_id, booking_id, bed_id, room_code, bed_code,
          assignment_start_date, assignment_end_date,
          assignment_type, assignment_label, planning_row_label, guest_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed',$8,$9,$10)`,
      [
        clientId, bookingId, a.bed.id,
        a.bed.room_code, a.bed.bed_code,
        a.startDate, a.endDate,
        `${a.bed.bed_code} — ${a.guestName}`,
        a.bed.planning_row_label || a.bed.bed_label || a.bed.bed_code,
        a.guestName,
      ]
    );
    inserted++;
  }
  return inserted;
}

async function upsertDemoRoomsAndBeds(db, clientId) {
  // Create 2 demo rooms + 2 beds each (4 beds total) for Lena Demo scenario.
  // Tagged via notes field (rooms/beds have no metadata JSONB).
  const demoNote = 'Stage 8 demo room — safe to delete (stage8_demo)';

  const rooms = [
    { code: 'DEMO-R1', name: 'Demo Dorm Room 1', sortOrder: 1, capacity: 6 },
    { code: 'DEMO-R2', name: 'Demo Dorm Room 2', sortOrder: 2, capacity: 4 },
  ];

  for (const r of rooms) {
    const existing = await db.query(
      `SELECT id FROM rooms WHERE client_id = $1 AND room_code = $2 LIMIT 1`,
      [clientId, r.code]
    );
    if (existing.rows.length === 0) {
      await db.query(
        `INSERT INTO rooms (client_id, room_code, name, capacity, sort_order, active, notes,
           room_type, gender_strategy, fill_priority, private_priority)
         VALUES ($1, $2, $3, $4, $5, TRUE, $6, 'dormitory', 'Flexible', 50, 50)`,
        [clientId, r.code, r.name, r.capacity, r.sortOrder, demoNote]
      );
    }
  }

  // Fetch room ids
  const roomIds = {};
  for (const r of rooms) {
    const row = await db.query(
      `SELECT id FROM rooms WHERE client_id = $1 AND room_code = $2 LIMIT 1`,
      [clientId, r.code]
    );
    roomIds[r.code] = row.rows[0].id;
  }

  const beds = [
    { code: 'DEMO-R1-B1', label: 'Demo Dorm 1 — Bed 1', num: 1, roomCode: 'DEMO-R1' },
    { code: 'DEMO-R1-B2', label: 'Demo Dorm 1 — Bed 2', num: 2, roomCode: 'DEMO-R1' },
    { code: 'DEMO-R2-B1', label: 'Demo Dorm 2 — Bed 1', num: 1, roomCode: 'DEMO-R2' },
    { code: 'DEMO-R2-B2', label: 'Demo Dorm 2 — Bed 2', num: 2, roomCode: 'DEMO-R2' },
  ];

  for (const b of beds) {
    const existing = await db.query(
      `SELECT id FROM beds WHERE client_id = $1 AND bed_code = $2 LIMIT 1`,
      [clientId, b.code]
    );
    if (existing.rows.length === 0) {
      await db.query(
        `INSERT INTO beds (client_id, room_id, bed_code, bed_label, planning_row_label,
           bed_number, active, sellable, notes)
         VALUES ($1, $2, $3, $4, $4, $5, TRUE, TRUE, $6)`,
        [clientId, roomIds[b.roomCode], b.code, b.label, b.num, demoNote]
      );
    }
  }
}

async function upsertPayment(db, opts) {
  // Idempotent: check if a demo payment exists for this booking
  const check = await db.query(
    `SELECT id FROM payments WHERE client_id = $1 AND booking_id = $2
       AND metadata->>'source' = 'stage8_demo'
     LIMIT 1`,
    [opts.clientId, opts.bookingId]
  );
  if (check.rows.length > 0) {
    return { id: check.rows[0].id, inserted: false };
  }
  const r = await db.query(
    `INSERT INTO payments
       (client_id, booking_id, status, payment_kind,
        amount_due_cents, amount_paid_cents, stripe_payment_intent_id,
        paid_at, metadata)
     VALUES ($1,$2,$3::payment_record_status,$4::payment_kind,
             $5,$6,$7,$8,$9::jsonb)
     RETURNING id`,
    [
      opts.clientId, opts.bookingId,
      opts.status, opts.paymentKind,
      opts.amountDueCents, opts.amountPaidCents || 0,
      opts.stripePaymentIntentId || null,
      opts.paidAt || null,
      JSON.stringify(opts.metadata),
    ]
  );
  return { id: r.rows[0].id, inserted: true };
}

main().catch(err => {
  console.error('\n✗ Seed failed:', err.message);
  if (err.detail) console.error('  Detail:', err.detail);
  process.exit(1);
});

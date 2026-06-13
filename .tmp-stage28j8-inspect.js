'use strict';
/** Stage 28j.8 — inspect calendar + payment truth after live WhatsApp deposit. Temp — do not commit. */
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');
const { getBedCalendarBlocksQuery } = require('./scripts/lib/staff-bed-calendar-queries');

const CLIENT = 'wolfhouse-somo';
const CONV_ID = '7361e380-1074-4441-a9e1-f92c127a4e76';
const PHONE_RAW = '491726422307';
const SINCE = process.env.SINCE_ISO || '2026-06-10T13:06:12.460Z';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function pgConnect() {
  const db = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: 'staff-staging.lunafrontdesk.com', path, method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(headers.cookie ? { Cookie: headers.cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function staffLogin() {
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  return cookie;
}

(async () => {
  const pg = await pgConnect();

  const messages = await pg.query(
    `SELECT m.id::text, m.direction::text, m.message_text, m.source, m.whatsapp_message_id, m.created_at::text
       FROM messages m
      WHERE m.conversation_id = $1::uuid
        AND m.created_at >= $2::timestamptz
      ORDER BY m.created_at ASC`,
    [CONV_ID, SINCE],
  );

  const sends = await pg.query(
    `SELECT id::text, status, message_text, provider_message_id, send_kind, idempotency_key, created_at::text
       FROM guest_message_sends
      WHERE client_slug = $1
        AND REPLACE(COALESCE(to_phone,''),'+','') = $2
        AND created_at >= $3::timestamptz
      ORDER BY created_at ASC`,
    [CLIENT, PHONE_RAW, SINCE],
  );

  const events = await pg.query(
    `SELECT id::text, created_at::text, message_text, suggested_reply, next_action, send_status,
            normalized->'open_demo_result' AS open_demo_result
       FROM guest_message_events
      WHERE client_slug = $1
        AND REPLACE(COALESCE(from_phone,''),'+','') = $2
        AND created_at >= $3::timestamptz
      ORDER BY created_at ASC`,
    [CLIENT, PHONE_RAW, SINCE],
  );

  const bookings = await pg.query(
    `SELECT b.id::text, b.booking_code, b.guest_name, b.phone, b.email, b.package_code,
            b.status::text, b.payment_status::text, b.assignment_status::text,
            b.check_in::text, b.check_out::text, b.guest_count,
            b.amount_paid_cents, b.balance_due_cents, b.deposit_required_cents,
            b.confirmation_sent_at::text, b.created_at::text, b.updated_at::text
       FROM bookings b JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1
        AND (REPLACE(COALESCE(b.phone,''),'+','') = $2
             OR b.id IN (
               SELECT DISTINCT (normalized->'open_demo_result'->'booking_write'->>'booking_id')::uuid
                 FROM guest_message_events
                WHERE client_slug = $1 AND REPLACE(COALESCE(from_phone,''),'+','') = $2
                  AND created_at >= $3::timestamptz
                  AND normalized->'open_demo_result'->'booking_write'->>'booking_id' IS NOT NULL
             ))
      ORDER BY b.created_at DESC
      LIMIT 5`,
    [CLIENT, PHONE_RAW, SINCE],
  );

  const booking = bookings.rows[0] || null;
  let bookingBeds = [];
  let payments = [];
  let paymentEvents = [];
  if (booking) {
    const bb = await pg.query(
      `SELECT bb.id::text AS booking_bed_id, bb.bed_id::text, bb.bed_code, bb.room_code,
              bb.assignment_start_date::text, bb.assignment_end_date::text,
              bb.assignment_type, bb.assignment_label, bb.created_at::text
         FROM booking_beds bb
        WHERE bb.booking_id = $1::uuid
        ORDER BY bb.bed_code ASC`,
      [booking.id],
    );
    bookingBeds = bb.rows;

    const pay = await pg.query(
      `SELECT p.id::text, p.status::text, p.payment_kind::text, p.amount_due_cents,
              p.amount_paid_cents, p.stripe_checkout_session_id, p.checkout_url,
              p.paid_at::text, p.created_at::text, p.updated_at::text
         FROM payments p WHERE p.booking_id = $1::uuid ORDER BY p.created_at DESC`,
      [booking.id],
    );
    payments = pay.rows;

    if (payments[0]) {
      const pe = await pg.query(
        `SELECT id::text, event_type, payload, created_at::text
           FROM payment_events
          WHERE payment_id = $1::uuid
          ORDER BY created_at ASC`,
        [payments[0].id],
      );
      paymentEvents = pe.rows;
    }
  }

  // deposit turn open_demo from events
  const depositEvent = events.rows.find((e) => /deposit/i.test(e.message_text || ''));
  const odr = depositEvent?.open_demo_result || {};

  const turns = events.rows.map((ev) => {
    const od = ev.open_demo_result || {};
    const brain = od?.result?.conversation_brain || {};
    const matchingSends = sends.rows.filter((s) =>
      Math.abs(new Date(s.created_at) - new Date(ev.created_at)) < 300000);
    return {
      inbound: ev.message_text,
      suggested_reply: ev.suggested_reply,
      outbound_sends: matchingSends.map((s) => ({
        id: s.id,
        text: s.message_text,
        provider_message_id: s.provider_message_id,
        idempotency_key: s.idempotency_key,
        at: s.created_at,
      })),
      final_reply_source: brain.final_reply_source || od.final_reply_source || null,
      composer_state: brain.composer_state || od.composer_state || null,
      brain_source: brain.source || null,
      model_used: brain.model_used || null,
      open_demo_summary: {
        booking_write: od.booking_write || od.bookingWrite || null,
        bed_assignment: od.bed_assignment || od.bedAssignment || null,
        stripe_link: od.stripe_link || od.stripeLink || null,
        payment_link_send: od.payment_link_send || od.paymentLinkSend || null,
        live_reply: od.live_reply || null,
      },
    };
  });

  // bed calendar API
  let bedCalendar = null;
  try {
    const cookie = await staffLogin();
    bedCalendar = await req(
      'GET',
      `/staff/bed-calendar?client=${CLIENT}&start=2026-07-01&end=2026-07-06`,
      null,
      { cookie },
    );
  } catch (e) {
    bedCalendar = { error: String(e.message || e) };
  }

  const calBlocks = booking
    ? (bedCalendar?.body?.blocks || []).filter((b) => b.booking_id === booking.id || b.booking_code === booking.booking_code)
    : [];

  // Stripe session status if key available
  let stripeSession = null;
  const sessionId = payments[0]?.stripe_checkout_session_id;
  if (sessionId) {
    try {
      const key = az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name stripe-secret-key --query value -o tsv');
      const Stripe = require('stripe');
      const stripe = new Stripe(key);
      stripeSession = await stripe.checkout.sessions.retrieve(sessionId);
    } catch (e) {
      stripeSession = { error: String(e.message || e) };
    }
  }

  const webhookReceived = paymentEvents.some((e) =>
    /stripe|webhook|checkout\.session/i.test(e.event_type || '') || /stripe/i.test(e.source || ''));
  const paymentTruthApplied = booking?.payment_status === 'deposit_paid'
    || booking?.payment_status === 'paid'
    || payments[0]?.status === 'paid'
    || paymentEvents.some((e) => /paid|payment_truth/i.test(e.event_type || ''));

  const duplicateSendsOnDeposit = sends.rows.filter((s) =>
    /deposit|checkout\.stripe|payment link/i.test(s.message_text || '')).length;

  await pg.end();

  const report = {
    since: SINCE,
    conversation_id: CONV_ID,
    transcript: messages.rows.map((m) => ({ direction: m.direction, text: m.message_text, at: m.created_at, source: m.source })),
    guest_message_sends: sends.rows,
    turns,
    deposit_open_demo: odr,
    booking: booking,
    booking_beds: bookingBeds,
    payments,
    payment_events: paymentEvents,
    bed_calendar_blocks_for_booking: calBlocks,
    bed_calendar_http: bedCalendar?.status,
    bed_calendar_total_blocks: bedCalendar?.body?.blocks?.length ?? null,
    stripe_session: stripeSession ? {
      id: stripeSession.id,
      status: stripeSession.status,
      payment_status: stripeSession.payment_status,
      amount_total: stripeSession.amount_total,
      mode: stripeSession.mode,
      error: stripeSession.error,
    } : null,
    findings: {
      webhook_received: webhookReceived,
      payment_truth_applied: paymentTruthApplied,
      confirmation_sent_at_null: !booking?.confirmation_sent_at,
      bed_assignment_exists: bookingBeds.length > 0,
      calendar_visible: calBlocks.length > 0,
      duplicate_payment_link_sends: duplicateSendsOnDeposit,
      stripe_paid: stripeSession?.payment_status === 'paid' || stripeSession?.status === 'complete',
    },
  };

  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

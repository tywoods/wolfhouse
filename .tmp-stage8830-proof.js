'use strict';
/**
 * Stage 8.8.30 — hosted bot addon create idempotency proof
 */
const https = require('https');
const path = require('path');
const fs = require('fs');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, 'infra', '.env') });

const BASE = 'https://staff-staging.lunafrontdesk.com';
const BOOKING_CODE = 'MB-WOLFHO-20260901-cb4799';
const BOOKING_ID = 'e15b7554-c766-4357-beb3-d23262e3b7b8';
const TOKEN = process.env.LUNA_BOT_INTERNAL_TOKEN;
const WEBHOOK_URL = `${BASE}/staff/stripe/webhook`;
const STATE_FILE = path.join(__dirname, '.tmp-stage8830-state.json');

const WETSUIT_KEY = 'stage8830-wetsuit-20260903-001';
const MEAL_KEY = 'stage8830-meal-20260903-001';

const WETSUIT_PAYLOAD = {
  client_slug: 'wolfhouse-somo',
  booking_code: BOOKING_CODE,
  guest_phone: '+34999000123',
  service_type: 'wetsuit',
  service_date: '2026-09-03',
  quantity: 1,
  payment_choice: 'pay_now',
  source: 'luna_whatsapp',
  confirm: true,
  idempotency_key: WETSUIT_KEY,
};

const MEAL_PAYLOAD = {
  client_slug: 'wolfhouse-somo',
  booking_code: BOOKING_CODE,
  guest_phone: '+34999000123',
  service_type: 'meal',
  service_date: '2026-09-03',
  quantity: 1,
  payment_choice: 'record_only',
  source: 'luna_whatsapp',
  confirm: true,
  idempotency_key: MEAL_KEY,
};

function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }

function botPost(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'staff-staging.lunafrontdesk.com',
      path: '/staff/bot/addon-requests/create',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Luna-Bot-Token': TOKEN,
      },
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function getDb() {
  const c = new Client({
    connectionString: process.env.WOLFHOUSE_DATABASE_URL,
    ssl: process.env.WOLFHOUSE_DATABASE_URL?.includes('azure') ? { rejectUnauthorized: false } : undefined,
  });
  await c.connect();
  return c;
}

async function snapshotBooking(c) {
  const r = await c.query(
    `SELECT payment_status, amount_paid_cents, balance_due_cents, confirmation_sent_at
       FROM bookings WHERE booking_code = $1`,
    [BOOKING_CODE],
  );
  return r.rows[0];
}

async function countByKey(c, key) {
  const svc = await c.query(
    `SELECT COUNT(*)::int AS n FROM booking_service_records
      WHERE booking_id = $1 AND source = 'luna_guest'
        AND metadata->>'idempotency_key' = $2`,
    [BOOKING_ID, key],
  );
  const pm = await c.query(
    `SELECT COUNT(*)::int AS n FROM payments
      WHERE booking_id = $1 AND payment_kind = 'addon_service'
        AND metadata->>'idempotency_key' = $2`,
    [BOOKING_ID, key],
  );
  return { service_rows: svc.rows[0].n, payments: pm.rows[0].n };
}

async function getServiceByKey(c, key) {
  const r = await c.query(
    `SELECT bsr.*, p.status AS pm_status, p.checkout_url, p.stripe_checkout_session_id
       FROM booking_service_records bsr
       LEFT JOIN payments p ON p.id = bsr.payment_id
      WHERE bsr.booking_id = $1 AND bsr.source = 'luna_guest'
        AND bsr.metadata->>'idempotency_key' = $2`,
    [BOOKING_ID, key],
  );
  return r.rows;
}

function stripeSignature(payload, secret) {
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
  return stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
}

async function webhook(paymentId, sessionId, serviceRecordId, amountCents) {
  const eventId = `evt_stage8830_${Date.now()}`;
  const piId = `pi_test_stage8830_${Date.now()}`;
  const event = {
    id: eventId,
    object: 'event',
    type: 'checkout.session.completed',
    livemode: false,
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        amount_total: amountCents,
        currency: 'eur',
        payment_intent: piId,
        metadata: {
          payment_id: paymentId,
          booking_id: BOOKING_ID,
          booking_code: BOOKING_CODE,
          payment_kind: 'addon_service',
          service_record_ids: JSON.stringify([serviceRecordId]),
        },
      },
    },
  };
  const payload = JSON.stringify(event);
  const sig = stripeSignature(payload, process.env.STRIPE_WEBHOOK_SECRET);
  return new Promise((resolve, reject) => {
    const u = new URL(WEBHOOK_URL);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'stripe-signature': sig,
      },
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let body;
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  if (!TOKEN) throw new Error('LUNA_BOT_INTERNAL_TOKEN required');

  const c = await getDb();
  let baseline;
  try {
    baseline = await snapshotBooking(c);
  } finally {
    await c.end();
  }

  const results = { checks: {} };

  // 1. First create
  const first = await botPost(WETSUIT_PAYLOAD);
  console.log('FIRST CREATE', first.status, JSON.stringify(first.body, null, 2));
  const b1 = first.body || {};
  results.checks.first_201 = first.status === 201;
  results.checks.first_success = b1.success === true;
  results.checks.first_has_ids = !!b1.service_record_id && !!b1.payment_id && !!b1.checkout_url;
  results.checks.first_no_missing_warn = !b1.idempotency_key_missing;
  results.checks.first_safety = b1.sends_whatsapp === false && b1.no_n8n === true && b1.no_payment_truth_recorded === true;

  const st = {
    baseline,
    service_record_id: b1.service_record_id,
    payment_id: b1.payment_id,
    checkout_url: b1.checkout_url,
    stripe_session_id: b1.stripe_checkout_session_id,
  };

  const c2 = await getDb();
  try {
    const rows = await getServiceByKey(c2, WETSUIT_KEY);
    const counts = await countByKey(c2, WETSUIT_KEY);
    const bk = await snapshotBooking(c2);
    console.log('DB AFTER FIRST', JSON.stringify({ counts, row: rows[0], booking: bk }, null, 2));
    results.checks.db_one_service = counts.service_rows === 1;
    results.checks.db_one_payment = counts.payments === 1;
    results.checks.db_pending = rows[0]?.payment_status === 'pending';
    results.checks.db_amount_paid_0 = Number(rows[0]?.amount_paid_cents) === 0;
    results.checks.db_key_stored = rows[0]?.metadata?.idempotency_key === WETSUIT_KEY;
    results.checks.booking_unchanged_first = bk.payment_status === baseline.payment_status
      && Number(bk.balance_due_cents) === Number(baseline.balance_due_cents);
    st.first_session = rows[0]?.stripe_checkout_session_id;
  } finally {
    await c2.end();
  }

  // 2. Retry (pending)
  const retry1 = await botPost(WETSUIT_PAYLOAD);
  console.log('RETRY PENDING', retry1.status, JSON.stringify(retry1.body, null, 2));
  const b2 = retry1.body || {};
  results.checks.retry_200 = retry1.status === 200;
  results.checks.retry_idempotent = b2.idempotent === true && b2.write_performed === false;
  results.checks.retry_same_ids = b2.service_record_id === st.service_record_id
    && b2.payment_id === st.payment_id
    && b2.checkout_url === st.checkout_url;

  const c3 = await getDb();
  try {
    const counts = await countByKey(c3, WETSUIT_KEY);
    const rows = await getServiceByKey(c3, WETSUIT_KEY);
    console.log('DB AFTER RETRY PENDING', JSON.stringify({ counts, session: rows[0]?.stripe_checkout_session_id }, null, 2));
    results.checks.db_still_one_after_retry = counts.service_rows === 1 && counts.payments === 1;
    results.checks.session_unchanged = rows[0]?.stripe_checkout_session_id === st.first_session;
  } finally {
    await c3.end();
  }

  // 3. Webhook + paid retry
  const wh = await webhook(st.payment_id, st.stripe_session_id, st.service_record_id, 500);
  console.log('WEBHOOK', wh.status, JSON.stringify(wh.body, null, 2));
  results.checks.webhook_200 = wh.status === 200;
  results.checks.webhook_addon = wh.body?.addon_service_payment === true;
  results.checks.webhook_paid_count = wh.body?.service_records_paid_count === 1;

  const retry2 = await botPost(WETSUIT_PAYLOAD);
  console.log('RETRY PAID', retry2.status, JSON.stringify(retry2.body, null, 2));
  const b3 = retry2.body || {};
  results.checks.retry_paid_idempotent = b3.idempotent === true && b3.payment_status === 'paid';
  results.checks.retry_paid_no_checkout = !b3.checkout_url;

  const c4 = await getDb();
  try {
    const counts = await countByKey(c4, WETSUIT_KEY);
    results.checks.db_still_one_after_paid_retry = counts.service_rows === 1 && counts.payments === 1;
  } finally {
    await c4.end();
  }

  // 4. Meal idempotency
  const meal1 = await botPost(MEAL_PAYLOAD);
  console.log('MEAL FIRST', meal1.status, JSON.stringify(meal1.body, null, 2));
  const m1 = meal1.body || {};
  results.checks.meal_first_success = m1.success === true && !!m1.service_record_id && !m1.payment_id;

  const meal2 = await botPost(MEAL_PAYLOAD);
  console.log('MEAL RETRY', meal2.status, JSON.stringify(meal2.body, null, 2));
  const m2 = meal2.body || {};
  results.checks.meal_retry_idempotent = meal2.status === 200 && m2.idempotent === true;
  results.checks.meal_same_id = m2.service_record_id === m1.service_record_id;
  results.checks.meal_no_payment = !m2.payment_id && !m2.checkout_url;

  const c5 = await getDb();
  try {
    const counts = await countByKey(c5, MEAL_KEY);
    results.checks.meal_one_row = counts.service_rows === 1 && counts.payments === 0;
    st.meal_service_record_id = m1.service_record_id;
  } finally {
    await c5.end();
  }

  saveState(st);
  const flat = Object.values(results.checks);
  const pass = flat.every(Boolean);
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(results.checks, null, 2));
  console.log(`\nSTAGE 8.8.30: ${pass ? 'PASS' : 'PARTIAL/FAIL'} (${flat.filter(Boolean).length}/${flat.length})`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

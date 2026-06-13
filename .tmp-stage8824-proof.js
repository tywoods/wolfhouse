'use strict';
/**
 * Stage 8.8.24 — hosted addon_service payment-link proof helper.
 * Usage: node .tmp-stage8824-proof.js [lookup|link|verify-link|idempotent|webhook|verify-paid|drawer|luna|all]
 */
const crypto = require('crypto');
const https = require('https');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, 'infra', '.env') });

const BASE = 'https://staff-staging.lunafrontdesk.com';
const BOOKING_CODE = 'MB-WOLFHO-20260901-cb4799';
const CLIENT = 'wolfhouse-somo';
const OPERATOR_EMAIL = 'operator.stage72c@example.test';
const OPERATOR_PASS = 'OperatorPass123!';
const WEBHOOK_URL = `${BASE}/staff/stripe/webhook`;
const STATE_FILE = path.join(__dirname, '.tmp-stage8824-state.json');

const cmd = process.argv[2] || 'all';

function httpsReq(method, urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload = body != null ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method,
      headers: {
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        } : {}),
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function extractCookie(resHeaders) {
  const sc = resHeaders['set-cookie'];
  if (!sc) return null;
  const line = Array.isArray(sc) ? sc[0] : sc;
  return line.split(';')[0];
}

async function getDb() {
  const c = new Client({
    connectionString: process.env.WOLFHOUSE_DATABASE_URL,
    ssl: process.env.WOLFHOUSE_DATABASE_URL?.includes('azure') ? { rejectUnauthorized: false } : undefined,
  });
  await c.connect();
  return c;
}

async function login() {
  const r = await httpsReq('POST', `${BASE}/staff/auth/login`, {
    email: OPERATOR_EMAIL,
    password: OPERATOR_PASS,
    client: CLIENT,
  });
  if (r.status !== 200 || !r.body?.success) {
    throw new Error(`login failed ${r.status}: ${JSON.stringify(r.body)}`);
  }
  const cookie = extractCookie(r.headers);
  if (!cookie) throw new Error('no session cookie');
  return cookie;
}

function loadState() {
  try { return JSON.parse(require('fs').readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  require('fs').writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function lookup() {
  const c = await getDb();
  try {
    const bk = await c.query(
      `SELECT id, booking_code, payment_status, amount_paid_cents, balance_due_cents, total_amount_cents
         FROM bookings WHERE booking_code = $1`,
      [BOOKING_CODE],
    );
    const svc = await c.query(
      `SELECT id, service_type, payment_status, payment_id, amount_due_cents, amount_paid_cents, status
         FROM booking_service_records
        WHERE booking_id = $1
        ORDER BY service_type`,
      [bk.rows[0]?.id],
    );
    const surf = svc.rows.find((r) => r.service_type === 'surf_lesson');
    console.log(JSON.stringify({
      booking: bk.rows[0],
      services: svc.rows,
      surf_lesson: surf,
    }, null, 2));
    if (surf) {
      const st = loadState();
      st.booking_id = bk.rows[0].id;
      st.service_record_id = surf.id;
      st.surf_amount_due_cents = Number(surf.amount_due_cents);
      st.booking_payment_status = bk.rows[0].payment_status;
      st.booking_amount_paid_cents = Number(bk.rows[0].amount_paid_cents);
      st.booking_balance_due_cents = Number(bk.rows[0].balance_due_cents);
      saveState(st);
    }
  } finally {
    await c.end();
  }
}

async function link() {
  const st = loadState();
  const cookie = await login();
  const url = `${BASE}/staff/bookings/${st.booking_id}/service-records/create-payment-link`;
  const r = await httpsReq('POST', url, { service_record_ids: [st.service_record_id] }, { Cookie: cookie });
  console.log('LINK', r.status, JSON.stringify(r.body, null, 2));
  if (r.status === 200 && r.body?.success) {
    st.payment_id = r.body.payment_id;
    st.checkout_url = r.body.checkout_url;
    st.stripe_checkout_session_id = r.body.stripe_checkout_session_id;
    st.link_response = r.body;
    saveState(st);
  }
  return r;
}

async function idempotent() {
  const st = loadState();
  const cookie = await login();
  const url = `${BASE}/staff/bookings/${st.booking_id}/service-records/create-payment-link`;
  const r = await httpsReq('POST', url, { service_record_ids: [st.service_record_id] }, { Cookie: cookie });
  console.log('IDEMPOTENT', r.status, JSON.stringify(r.body, null, 2));
  return r;
}

async function verifyLink() {
  const st = loadState();
  const c = await getDb();
  try {
    const pm = await c.query('SELECT * FROM payments WHERE id = $1', [st.payment_id]);
    const svc = await c.query('SELECT * FROM booking_service_records WHERE id = $1', [st.service_record_id]);
    const bk = await c.query('SELECT payment_status, amount_paid_cents, balance_due_cents FROM bookings WHERE id = $1', [st.booking_id]);
    const payCount = await c.query(
      `SELECT COUNT(*)::int AS n FROM payments
        WHERE booking_id = $1 AND payment_kind = 'addon_service' AND id = $2`,
      [st.booking_id, st.payment_id],
    );
    console.log(JSON.stringify({
      payment: pm.rows[0],
      service_row: svc.rows[0],
      booking: bk.rows[0],
      expected_booking_payment_status: st.booking_payment_status,
      expected_booking_amount_paid: st.booking_amount_paid_cents,
      expected_booking_balance: st.booking_balance_due_cents,
    }, null, 2));
  } finally {
    await c.end();
  }
}

function stripeSignature(payload, secret) {
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
  return stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });
}

async function webhook() {
  const st = loadState();
  const c = await getDb();
  let pm;
  try {
    const r = await c.query('SELECT * FROM payments WHERE id = $1', [st.payment_id]);
    pm = r.rows[0];
  } finally {
    await c.end();
  }
  const sessionId = pm.stripe_checkout_session_id || st.stripe_checkout_session_id;
  const eventId = `evt_stage8824_addon_${Date.now()}`;
  const piId = `pi_test_stage8824_addon_${Date.now()}`;
  const event = {
    id: eventId,
    object: 'event',
    type: 'checkout.session.completed',
    livemode: false,
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        amount_total: Number(pm.amount_due_cents),
        currency: 'eur',
        payment_intent: piId,
        metadata: {
          payment_id: st.payment_id,
          booking_id: st.booking_id,
          booking_code: BOOKING_CODE,
          payment_kind: 'addon_service',
          service_record_ids: JSON.stringify([st.service_record_id]),
        },
      },
    },
  };
  const payload = JSON.stringify(event);
  const sig = stripeSignature(payload, process.env.STRIPE_WEBHOOK_SECRET);
  const r = await new Promise((resolve, reject) => {
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
  console.log('WEBHOOK', r.status, JSON.stringify(r.body, null, 2));
  st.webhook_response = r.body;
  saveState(st);
  return r;
}

async function verifyPaid() {
  const st = loadState();
  const c = await getDb();
  try {
    const svc = await c.query(
      `SELECT id, service_type, payment_status, payment_id, amount_due_cents, amount_paid_cents, status
         FROM booking_service_records
        WHERE booking_id = $1
        ORDER BY service_type`,
      [st.booking_id],
    );
    const pm = await c.query('SELECT * FROM payments WHERE id = $1', [st.payment_id]);
    const bk = await c.query(
      'SELECT payment_status, amount_paid_cents, balance_due_cents FROM bookings WHERE id = $1',
      [st.booking_id],
    );
    const addonCount = await c.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE booking_id = $1 AND payment_kind = 'addon_service'`,
      [st.booking_id],
    );
    console.log(JSON.stringify({
      services: svc.rows,
      new_payment: pm.rows[0],
      booking: bk.rows[0],
      addon_service_payment_count: addonCount.rows[0].n,
      booking_unchanged: {
        payment_status: bk.rows[0].payment_status === st.booking_payment_status,
        amount_paid_cents: Number(bk.rows[0].amount_paid_cents) === st.booking_amount_paid_cents,
        balance_due_cents: Number(bk.rows[0].balance_due_cents) === st.booking_balance_due_cents,
      },
    }, null, 2));
  } finally {
    await c.end();
  }
}

async function drawer() {
  const cookie = await login();
  const r = await httpsReq(
    'GET',
    `${BASE}/staff/bookings/${encodeURIComponent(BOOKING_CODE)}/context?client=${encodeURIComponent(CLIENT)}`,
    null,
    { Cookie: cookie },
  );
  const svc = r.body?.service_records || [];
  console.log('DRAWER', r.status, JSON.stringify({
    booking_code: r.body?.booking_code,
    payment_status: r.body?.payment_status,
    amount_paid_cents: r.body?.amount_paid_cents,
    balance_due_cents: r.body?.balance_due_cents,
    service_records: svc.map((s) => ({
      service_type: s.service_type,
      payment_status: s.payment_status,
      amount_paid_cents: s.amount_paid_cents,
      status: s.status,
    })),
  }, null, 2));
  return r;
}

async function luna() {
  const cookie = await login();
  for (const q of [
    'Who has a lesson on September 1 2026?',
    'Who has a paid surf lesson on September 1 2026?',
  ]) {
    const r = await httpsReq('POST', `${BASE}/staff/ask-luna`, {
      client: CLIENT,
      question: q,
      source: 'staff_portal',
    }, { Cookie: cookie });
    console.log('LUNA', q, r.status, JSON.stringify({
      intent: r.body?.intent,
      answer: r.body?.answer,
      row_count: r.body?.row_count,
      unsupported: r.body?.unsupported_intent,
    }, null, 2));
  }
}

async function main() {
  const steps = cmd === 'all'
    ? ['lookup', 'link', 'verify-link', 'idempotent', 'webhook', 'verify-paid', 'drawer', 'luna']
    : [cmd];
  for (const s of steps) {
    console.log('\n===', s.toUpperCase(), '===');
    if (s === 'lookup') await lookup();
    else if (s === 'link') await link();
    else if (s === 'verify-link') await verifyLink();
    else if (s === 'idempotent') await idempotent();
    else if (s === 'webhook') await webhook();
    else if (s === 'verify-paid') await verifyPaid();
    else if (s === 'drawer') await drawer();
    else if (s === 'luna') await luna();
    else throw new Error('unknown cmd: ' + s);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

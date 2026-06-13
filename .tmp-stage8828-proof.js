'use strict';
/**
 * Stage 8.8.28 — hosted bot addon-requests/create proof
 * Usage: node .tmp-stage8828-proof.js [create|verify-pre|webhook|verify-post|drawer|luna|meal|all]
 */
const crypto = require('crypto');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, 'infra', '.env') });

const BASE = 'https://staff-staging.lunafrontdesk.com';
const BOOKING_CODE = 'MB-WOLFHO-20260901-cb4799';
const BOOKING_ID = 'e15b7554-c766-4357-beb3-d23262e3b7b8';
const CLIENT = 'wolfhouse-somo';
const OPERATOR_EMAIL = 'operator.stage72c@example.test';
const OPERATOR_PASS = 'OperatorPass123!';
const TOKEN = process.env.LUNA_BOT_INTERNAL_TOKEN;
const WEBHOOK_URL = `${BASE}/staff/stripe/webhook`;
const STATE_FILE = path.join(__dirname, '.tmp-stage8828-state.json');

const WETSUIT_PAYLOAD = {
  client_slug: CLIENT,
  booking_code: BOOKING_CODE,
  guest_phone: '+34999000123',
  service_type: 'wetsuit',
  service_date: '2026-09-02',
  quantity: 1,
  payment_choice: 'pay_now',
  source: 'luna_whatsapp',
  confirm: true,
};

const MEAL_PAYLOAD = {
  client_slug: CLIENT,
  booking_code: BOOKING_CODE,
  guest_phone: '+34999000123',
  service_type: 'meal',
  service_date: '2026-09-02',
  quantity: 1,
  payment_choice: 'record_only',
  source: 'luna_whatsapp',
  confirm: true,
};

const cmd = process.argv[2] || 'all';

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function httpsReq(method, urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload = body != null ? JSON.stringify(body) : null;
    const req = https.request({
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
    }, (res) => {
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

async function snapshotBooking(c) {
  const bk = await c.query(
    `SELECT id, booking_code, payment_status, amount_paid_cents, balance_due_cents, total_amount_cents, confirmation_sent_at
       FROM bookings WHERE booking_code = $1`,
    [BOOKING_CODE],
  );
  return bk.rows[0];
}

async function baseline() {
  const c = await getDb();
  try {
    const bk = await snapshotBooking(c);
    const svc = await c.query(
      `SELECT COUNT(*)::int AS n FROM booking_service_records WHERE booking_id = $1`,
      [BOOKING_ID],
    );
    const pm = await c.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE booking_id = $1`,
      [BOOKING_ID],
    );
    const st = {
      booking_id: bk.id,
      booking_payment_status: bk.payment_status,
      booking_amount_paid_cents: Number(bk.amount_paid_cents),
      booking_balance_due_cents: Number(bk.balance_due_cents),
      confirmation_sent_at: bk.confirmation_sent_at,
      service_count: svc.rows[0].n,
      payment_count: pm.rows[0].n,
    };
    saveState(st);
    console.log('BASELINE', JSON.stringify(st, null, 2));
  } finally {
    await c.end();
  }
}

async function create() {
  if (!TOKEN) throw new Error('LUNA_BOT_INTERNAL_TOKEN required');
  const r = await httpsReq('POST', `${BASE}/staff/bot/addon-requests/create`, WETSUIT_PAYLOAD, {
    'X-Luna-Bot-Token': TOKEN,
  });
  console.log('CREATE', r.status, JSON.stringify(r.body, null, 2));
  const b = r.body || {};
  const checks = {
    success: b.success === true,
    service_record_id: !!b.service_record_id,
    payment_id: !!b.payment_id,
    payment_kind: b.payment_kind === 'addon_service',
    checkout_url: !!b.checkout_url,
    no_payment_truth_recorded: b.no_payment_truth_recorded === true,
    sends_whatsapp: b.sends_whatsapp === false,
    whatsapp_dry_run: b.whatsapp_dry_run === true,
    no_n8n: b.no_n8n === true,
    reply_draft: !!b.reply_draft,
    auth_mode: b.auth_mode === 'bot_token',
  };
  console.log('CREATE_CHECKS', JSON.stringify(checks, null, 2));
  if ((r.status === 200 || r.status === 201) && b.success) {
    const st = loadState();
    st.wetsuit_service_record_id = b.service_record_id;
    st.payment_id = b.payment_id;
    st.checkout_url = b.checkout_url;
    st.stripe_checkout_session_id = b.stripe_checkout_session_id;
    st.create_response = b;
    st.create_checks = checks;
    saveState(st);
  }
  return { r, checks };
}

async function verifyPre() {
  const st = loadState();
  const c = await getDb();
  try {
    const svc = await c.query('SELECT * FROM booking_service_records WHERE id = $1', [st.wetsuit_service_record_id]);
    const pm = await c.query('SELECT * FROM payments WHERE id = $1', [st.payment_id]);
    const bk = await snapshotBooking(c);
    const row = svc.rows[0];
    const pay = pm.rows[0];
    const checks = {
      service_exists: !!row,
      source_luna_guest: row?.source === 'luna_guest',
      service_type_wetsuit: row?.service_type === 'wetsuit',
      service_date: String(row?.service_date).slice(0, 10) === '2026-09-02',
      payment_status_pending: row?.payment_status === 'pending',
      amount_paid_cents_0: Number(row?.amount_paid_cents) === 0,
      payment_id_linked: row?.payment_id === st.payment_id,
      payment_kind_addon: pay?.payment_kind === 'addon_service',
      payment_status_checkout: pay?.status === 'checkout_created',
      payment_amount_500: Number(pay?.amount_due_cents) === 500,
      metadata_service_record_ids: Array.isArray(pay?.metadata?.service_record_ids)
        && pay.metadata.service_record_ids.includes(st.wetsuit_service_record_id),
      booking_payment_unchanged: bk.payment_status === st.booking_payment_status
        && Number(bk.amount_paid_cents) === st.booking_amount_paid_cents
        && Number(bk.balance_due_cents) === st.booking_balance_due_cents,
      confirmation_sent_at_unchanged: String(bk.confirmation_sent_at) === String(st.confirmation_sent_at),
    };
    console.log('VERIFY_PRE', JSON.stringify({ service_row: row, payment: pay, booking: bk, checks }, null, 2));
    st.verify_pre = checks;
    saveState(st);
    return checks;
  } finally {
    await c.end();
  }
}

function stripeSignature(payload, secret) {
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
  return stripe.webhooks.generateTestHeaderString({ payload, secret });
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
  const eventId = `evt_stage8828_bot_addon_${Date.now()}`;
  const piId = `pi_test_stage8828_bot_addon_${Date.now()}`;
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
          service_record_ids: JSON.stringify([st.wetsuit_service_record_id]),
        },
      },
    },
  };
  const payload = JSON.stringify(event);
  const sig = stripeSignature(payload, process.env.STRIPE_WEBHOOK_SECRET);
  const r = await httpsReq('POST', WEBHOOK_URL, JSON.parse(payload), { 'stripe-signature': sig });
  console.log('WEBHOOK', r.status, JSON.stringify(r.body, null, 2));
  const b = r.body || {};
  const checks = {
    http_200: r.status === 200,
    addon_service_payment: b.addon_service_payment === true,
    service_records_paid_count: b.service_records_paid_count === 1,
    no_booking_payment_status_change: b.no_booking_payment_status_change === true,
    no_confirmation_sent: b.no_confirmation_sent === true,
    no_whatsapp: b.no_whatsapp === true,
    no_n8n: b.no_n8n === true,
  };
  console.log('WEBHOOK_CHECKS', JSON.stringify(checks, null, 2));
  st.webhook_response = b;
  st.webhook_checks = checks;
  saveState(st);
  return { r, checks };
}

async function verifyPost() {
  const st = loadState();
  const c = await getDb();
  try {
    const svc = await c.query('SELECT * FROM booking_service_records WHERE id = $1', [st.wetsuit_service_record_id]);
    const pm = await c.query('SELECT * FROM payments WHERE id = $1', [st.payment_id]);
    const bk = await snapshotBooking(c);
    const row = svc.rows[0];
    const pay = pm.rows[0];
    const checks = {
      service_payment_status_paid: row?.payment_status === 'paid',
      service_amount_paid_set: Number(row?.amount_paid_cents) === 500,
      service_status_paid: row?.status === 'paid',
      payment_status_paid: pay?.status === 'paid',
      booking_payment_unchanged: bk.payment_status === st.booking_payment_status
        && Number(bk.amount_paid_cents) === st.booking_amount_paid_cents
        && Number(bk.balance_due_cents) === st.booking_balance_due_cents,
    };
    console.log('VERIFY_POST', JSON.stringify({ service_row: row, payment: pay, booking: bk, checks }, null, 2));
    st.verify_post = checks;
    saveState(st);
    return checks;
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
  const st = loadState();
  const svc = r.body?.service_records || [];
  const wetsuit = svc.find((s) => s.id === st.wetsuit_service_record_id
    || (s.service_type === 'wetsuit' && String(s.service_date).slice(0, 10) === '2026-09-02'));
  const checks = {
    context_200: r.status === 200,
    wetsuit_found: !!wetsuit,
    wetsuit_paid: wetsuit?.payment_status === 'paid',
    wetsuit_date: String(wetsuit?.service_date).slice(0, 10) === '2026-09-02',
    booking_payment_unchanged: r.body?.payment_status === loadState().booking_payment_status,
  };
  console.log('DRAWER', r.status, JSON.stringify({
    booking_code: r.body?.booking_code,
    payment_status: r.body?.payment_status,
    wetsuit_row: wetsuit,
    checks,
  }, null, 2));
  return checks;
}

async function luna() {
  const cookie = await login();
  const q = 'Who needs a wetsuit on September 2 2026?';
  const r = await httpsReq('POST', `${BASE}/staff/ask-luna`, {
    client: CLIENT,
    question: q,
    source: 'staff_portal',
  }, { Cookie: cookie });
  const rows = r.body?.rows || r.body?.data || [];
  const guestHit = JSON.stringify(r.body).includes('Stage8817 Addon Test');
  const checks = {
    http_200: r.status === 200,
    intent: r.body?.intent === 'services.wetsuit.on_date',
    includes_guest: guestHit,
    read_only: r.body?.read_only === true,
    no_write: r.body?.no_write_performed === true,
    sends_whatsapp: r.body?.sends_whatsapp === false,
  };
  console.log('LUNA', q, r.status, JSON.stringify({
    intent: r.body?.intent,
    row_count: r.body?.row_count,
    answer: r.body?.answer,
    rows: rows.slice(0, 3),
    checks,
  }, null, 2));
  return checks;
}

async function meal() {
  if (!TOKEN) throw new Error('LUNA_BOT_INTERNAL_TOKEN required');
  const before = loadState();
  const c = await getDb();
  let mealCountBefore;
  try {
    const r = await c.query(
      `SELECT COUNT(*)::int AS n FROM booking_service_records
        WHERE booking_id = $1 AND service_type = 'meal' AND service_date = '2026-09-02'::date`,
      [BOOKING_ID],
    );
    mealCountBefore = r.rows[0].n;
  } finally {
    await c.end();
  }

  const r = await httpsReq('POST', `${BASE}/staff/bot/addon-requests/create`, MEAL_PAYLOAD, {
    'X-Luna-Bot-Token': TOKEN,
  });
  console.log('MEAL_CREATE', r.status, JSON.stringify(r.body, null, 2));
  const b = r.body || {};
  const checks = {
    success: b.success === true,
    service_record_id: !!b.service_record_id,
    no_payment_id: !b.payment_id,
    no_checkout_url: !b.checkout_url,
    reason_meal: b.reason === 'meal_on_site_only',
    payment_required_false: b.payment_required === false,
  };

  const c2 = await getDb();
  try {
    const svc = await c2.query('SELECT * FROM booking_service_records WHERE id = $1', [b.service_record_id]);
    const row = svc.rows[0];
    checks.source_luna_guest = row?.source === 'luna_guest';
    checks.payment_status_not_requested = row?.payment_status === 'not_requested';
    checks.no_payment_id_db = !row?.payment_id;
    const pmStripe = await c2.query(
      `SELECT COUNT(*)::int AS n FROM payments
        WHERE booking_id = $1 AND metadata->>'service_record_ids' LIKE $2`,
      [BOOKING_ID, `%${b.service_record_id}%`],
    );
    checks.no_stripe_payment_for_meal = pmStripe.rows[0].n === 0;
    console.log('MEAL_DB', JSON.stringify({ row, checks }, null, 2));
    const st = loadState();
    st.meal_service_record_id = b.service_record_id;
    st.meal_checks = checks;
    saveState(st);
  } finally {
    await c2.end();
  }
  return { r, checks };
}

async function all() {
  await baseline();
  const createResult = await create();
  const pre = await verifyPre();
  const wh = await webhook();
  const post = await verifyPost();
  const dr = await drawer();
  const lu = await luna();
  const mealResult = await meal();

  const allChecks = {
    create: createResult.checks,
    verify_pre: pre,
    webhook: wh.checks,
    verify_post: post,
    drawer: dr,
    luna: lu,
    meal: mealResult.checks,
  };
  const flat = Object.values(allChecks).flatMap((o) => Object.values(o));
  const pass = flat.every(Boolean);
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(allChecks, null, 2));
  console.log(`\nSTAGE 8.8.28: ${pass ? 'PASS' : 'PARTIAL/FAIL'} (${flat.filter(Boolean).length}/${flat.length} checks)`);
  process.exit(pass ? 0 : 1);
}

const handlers = { baseline, create, 'verify-pre': verifyPre, webhook, 'verify-post': verifyPost, drawer, luna, meal, all };
(async () => {
  const fn = handlers[cmd];
  if (!fn) {
    console.error('Unknown cmd:', cmd);
    process.exit(1);
  }
  await fn();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BED = 'DEMO-R2-B2';
const PKG = 'malibu';
const EMAIL = 'operator.stage72c@example.test';
const PASS = 'OperatorPass123!';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function login() {
  const res = await req('POST', '/staff/auth/login', { client: CLIENT, email: EMAIL, password: PASS });
  if (res.status !== 200) throw new Error('login failed');
  return (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
}

function pgClient() {
  const url = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  return new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
}

function ledgerPaid(rows) {
  return (rows || []).reduce((s, pr) => {
    if (String(pr.payment_status || pr.status || '').toLowerCase() !== 'paid') return s;
    return s + Number(pr.amount_paid_cents || 0);
  }, 0);
}

async function snapshot(c, code) {
  const bk = await c.query(
    `SELECT id, booking_code, payment_status, amount_paid_cents, balance_due_cents, total_amount_cents
       FROM bookings WHERE booking_code = $1`, [code]);
  const pays = await c.query(
    `SELECT p.id, p.status, p.amount_due_cents, p.amount_paid_cents, p.paid_at,
            p.stripe_checkout_session_id, p.stripe_payment_intent_id, p.checkout_url, p.metadata
       FROM payments p JOIN bookings b ON b.id = p.booking_id
      WHERE b.booking_code = $1 ORDER BY p.created_at`, [code]);
  const svc = await c.query(
    `SELECT COUNT(*)::int n FROM booking_service_records bsr
      JOIN bookings b ON b.id = bsr.booking_id WHERE b.booking_code = $1`, [code]);
  const beds = await c.query(
    `SELECT COUNT(*)::int n FROM booking_beds bb
      JOIN bookings b ON b.id = bb.booking_id WHERE b.booking_code = $1`, [code]);
  return { booking: bk.rows[0], payments: pays.rows, service_records: svc.rows[0].n, booking_beds: beds.rows[0].n };
}

async function createBooking(cookie) {
  const ts = Date.now();
  const beds = [BED, 'DEMO-R1-B1', 'DEMO-R1-B2', 'DEMO-R2-B1'];
  let res;
  let ci;
  let co;
  let bedUsed = BED;
  for (let offset = 0; offset < 12; offset++) {
    const base = 1 + ((Math.floor(ts / 1000) + offset * 4) % 22);
    ci = `2028-07-${String(base).padStart(2, '0')}`;
    co = `2028-07-${String(Math.min(base + 3, 31)).padStart(2, '0')}`;
    bedUsed = beds[offset % beds.length];
    res = await req('POST', '/staff/manual-bookings/create', {
    client_slug: CLIENT,
    check_in: ci,
    check_out: co,
    selected_bed_codes: [bedUsed],
    guest_count: 1,
    guest_name: 'Stage106e1 Real Stripe Checkout',
    phone: '+34600666' + String(ts).slice(-4),
    package_code: PKG,
    room_type: 'shared',
    payment_choice: 'stripe_deposit',
    add_ons: [],
    confirm: true,
    idempotency_key: 'stage106e1-real-checkout-' + ts + '-' + offset,
  }, cookie);
    if (res.status === 201 && res.body && res.body.success) break;
    if (res.status !== 409) break;
  }
  return { res, ci, co, bedUsed };
}

async function context(cookie, code) {
  return req('GET', `/staff/bookings/${encodeURIComponent(code)}/context?client=${CLIENT}`, null, { Cookie: cookie });
}

(async () => {
  const cmd = process.argv[2] || 'create';
  const cookie = await login();

  if (cmd === 'create') {
    const { res, ci, co } = await createBooking(cookie);
    const body = res.body || {};
    const out = {
      http: res.status,
      success: body.success,
      booking_code: body.booking_code,
      payment_link_url: body.payment_link_url,
      check_in: ci,
      check_out: co,
      body,
    };
    if (body.booking_code) {
      const c = await pgClient();
      await c.connect();
      out.before = await snapshot(c, body.booking_code);
      await c.end();
      const fs = require('fs');
      fs.writeFileSync(__dirname + '/.tmp-stage106e1-state.json', JSON.stringify({
        booking_code: body.booking_code,
        payment_link_url: body.payment_link_url,
        session_id: out.before.payments[0] && out.before.payments[0].stripe_checkout_session_id,
        payment_id: out.before.payments[0] && out.before.payments[0].id,
        created_at: new Date().toISOString(),
      }, null, 2));
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'verify') {
    const st = JSON.parse(require('fs').readFileSync(__dirname + '/.tmp-stage106e1-state.json', 'utf8'));
    const code = st.booking_code;
    const c = await pgClient();
    await c.connect();
    const after = await snapshot(c, code);
    await c.end();

    const stripe = require('stripe')(execSync(
      'az keyvault secret show --vault-name wh-staging-kv --name stripe-secret-key --query value -o tsv',
      { encoding: 'utf8' },
    ).trim());
    let session = null;
    if (st.session_id) {
      session = await stripe.checkout.sessions.retrieve(st.session_id);
    }

    const ctx = await context(cookie, code);
    const ctxBk = ctx.body && ctx.body.booking;
    const ctxPays = (ctx.body && ctx.body.payments && ctx.body.payments.rows) || [];

    const paidRows = after.payments.filter((p) => p.status === 'paid');
    const checkoutRows = after.payments.filter((p) => p.status === 'checkout_created');
    const meta = paidRows[0] && paidRows[0].metadata || {};
    const stripeDelivered = !!(meta.stripe_event_id && meta.stripe_event_type === 'checkout.session.completed');

    const out = {
      booking_code: code,
      stripe_session: session ? {
        status: session.status,
        payment_status: session.payment_status,
        amount_total: session.amount_total,
      } : null,
      stripe_webhook_from_stripe: stripeDelivered,
      stripe_event_id: meta.stripe_event_id || null,
      skip_verify_used: meta.skip_verify_used,
      after,
      drawer: {
        payment_status: ctxBk && ctxBk.payment_status,
        amount_paid_cents: ctxBk && ctxBk.amount_paid_cents,
        balance_due_cents: ctxBk && ctxBk.balance_due_cents,
        payment_rows: ctxPays.length,
        paid_payment_rows: ctxPays.filter((p) => p.payment_status === 'paid').length,
      },
      checks: {
        session_complete: session && (session.status === 'complete' || session.payment_status === 'paid'),
        payment_paid: paidRows.length >= 1,
        paid_amount_10000: paidRows.some((p) => Number(p.amount_paid_cents) === 10000),
        paid_at_set: paidRows.some((p) => p.paid_at),
        webhook_stripe_metadata: stripeDelivered && meta.skip_verify_used === false,
        no_extra_checkout_rows: checkoutRows.length === 0,
        single_payment_row: after.payments.length === 1,
        balance_5000: Number(after.booking.balance_due_cents) === 5000,
        booking_deposit_paid: after.booking.payment_status === 'deposit_paid',
        ledger_10000: ledgerPaid(after.payments) === 10000,
      },
    };
    out.failures = Object.entries(out.checks).filter(([, v]) => !v).map(([k]) => k);
    out.result = out.failures.length === 0 ? 'PASS' : (out.failures.length <= 2 ? 'PARTIAL' : 'FAIL');
    console.log(JSON.stringify(out, null, 2));
  }
})().catch((e) => { console.error(e); process.exit(1); });

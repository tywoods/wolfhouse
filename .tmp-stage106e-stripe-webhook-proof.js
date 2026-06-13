'use strict';

const https = require('https');
const crypto = require('crypto');
const path = require('path');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const BASE = `https://${HOST}`;
const CLIENT = 'wolfhouse-somo';
const BOOKING_CODE = 'MB-WOLFHO-20280824-77d718';
const WEBHOOK_URL = `${BASE}/staff/stripe/webhook`;
const EMAIL = 'operator.stage72c@example.test';
const PASS = 'OperatorPass123!';

function req(method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path: urlPath, method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(headers || {}),
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
  if (res.status !== 200) throw new Error('login failed ' + res.status);
  const cookie = (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  return cookie;
}

function pgConn() {
  const url = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  return new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
}

function stripeSecret() {
  return execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name stripe-secret-key --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
}

function webhookSecret() {
  return execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name stripe-webhook-secret --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
}

function ledgerPaid(rows) {
  return (rows || []).reduce((s, pr) => {
    if (String(pr.payment_status || '').toLowerCase() !== 'paid') return s;
    return s + Number(pr.amount_paid_cents || 0);
  }, 0);
}

async function dbSnapshot(c, bookingCode) {
  const bk = await c.query(
    `SELECT id, booking_code, payment_status, amount_paid_cents, balance_due_cents, total_amount_cents
       FROM bookings WHERE booking_code = $1`,
    [bookingCode],
  );
  const pays = await c.query(
    `SELECT p.id, p.status, p.payment_kind, p.amount_due_cents, p.amount_paid_cents,
            p.paid_at, p.stripe_checkout_session_id, p.stripe_payment_intent_id,
            p.checkout_url, p.metadata
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE b.booking_code = $1
      ORDER BY p.created_at ASC`,
    [bookingCode],
  );
  const svcCount = await c.query(
    `SELECT COUNT(*)::int AS n FROM booking_service_records bsr
      JOIN bookings b ON b.id = bsr.booking_id WHERE b.booking_code = $1`,
    [bookingCode],
  );
  const bedCount = await c.query(
    `SELECT COUNT(*)::int AS n FROM booking_beds bb
      JOIN bookings b ON b.id = bb.booking_id WHERE b.booking_code = $1`,
    [bookingCode],
  );
  const peCount = await c.query(
    `SELECT COUNT(*)::int AS n FROM payment_events pe
      JOIN payments p ON p.id = pe.payment_id
      JOIN bookings b ON b.id = p.booking_id
     WHERE b.booking_code = $1`,
    [bookingCode],
  );
  return {
    booking: bk.rows[0] || null,
    payments: pays.rows,
    service_records: svcCount.rows[0].n,
    booking_beds: bedCount.rows[0].n,
    payment_events: peCount.rows[0].n,
  };
}

function stripeSig(payload, secret) {
  const stripe = require('stripe')(stripeSecret());
  return stripe.webhooks.generateTestHeaderString({ payload, secret });
}

async function postWebhook(event) {
  const payload = JSON.stringify(event);
  const sig = stripeSig(payload, webhookSecret());
  return req('POST', '/staff/stripe/webhook', JSON.parse(payload), { 'stripe-signature': sig });
}

async function context(cookie) {
  return req('GET', `/staff/bookings/${encodeURIComponent(BOOKING_CODE)}/context?client=${CLIENT}`, null, { Cookie: cookie });
}

(async () => {
  const mode = process.argv[2] || 'all';
  const out = { booking_code: BOOKING_CODE, revision: 'wh-staging-staff-api--0000096', commit: 'f5ff03d' };

  const cookie = await login();
  const ctxBefore = await context(cookie);
  out.context_before_ok = ctxBefore.status === 200;

  const c = await pgConn();
  await c.connect();
  const before = await dbSnapshot(c, BOOKING_CODE);
  out.before = {
    booking: before.booking,
    payments: before.payments.map((p) => ({
      id: p.id,
      status: p.status,
      amount_due_cents: p.amount_due_cents,
      amount_paid_cents: p.amount_paid_cents,
      stripe_checkout_session_id: p.stripe_checkout_session_id,
      checkout_url: p.checkout_url,
      paid_at: p.paid_at,
    })),
    paid_ledger: ledgerPaid(before.payments.map((p) => ({
      payment_status: p.status,
      amount_paid_cents: p.amount_paid_cents,
    }))),
    service_records: before.service_records,
    booking_beds: before.booking_beds,
    payment_events: before.payment_events,
  };

  const checkoutRow = before.payments.find((p) => p.status === 'checkout_created')
    || before.payments[before.payments.length - 1];
  if (!checkoutRow) throw new Error('no checkout payment row');

  out.checkout = {
    payment_id: checkoutRow.id,
    session_id: checkoutRow.stripe_checkout_session_id,
    checkout_url: checkoutRow.checkout_url,
    amount_due_cents: checkoutRow.amount_due_cents,
    status: checkoutRow.status,
  };

  if (mode === 'before' || mode === 'snapshot') {
    await c.end();
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const stripe = require('stripe')(stripeSecret());
  let session = null;
  if (checkoutRow.stripe_checkout_session_id) {
    session = await stripe.checkout.sessions.retrieve(checkoutRow.stripe_checkout_session_id);
    out.stripe_session_before = {
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      amount_total: session.amount_total,
    };
  }

  let paidViaStripe = false;
  if (session && session.status === 'open' && session.url) {
    try {
      const paid = await stripe.checkout.sessions.pay(session.id, {
        payment_method: 'pm_card_visa',
      });
      out.stripe_pay_attempt = { id: paid.id, status: paid.status, payment_status: paid.payment_status };
      paidViaStripe = paid.payment_status === 'paid' || paid.status === 'complete';
      session = paid;
    } catch (e) {
      out.stripe_pay_attempt = { error: e.message };
    }
  }

  if (session && (session.status === 'complete' || session.payment_status === 'paid')) {
    paidViaStripe = true;
    out.stripe_already_complete = true;
  }

  await new Promise((r) => setTimeout(r, paidViaStripe ? 8000 : 500));

  let afterWebhook = await dbSnapshot(c, BOOKING_CODE);
  let paidAfterFirst = ledgerPaid(afterWebhook.payments.map((p) => ({
    payment_status: p.status,
    amount_paid_cents: p.amount_paid_cents,
  })));

  if (paidAfterFirst === 0) {
    const eventId = `evt_stage106e_${Date.now()}`;
    const piId = session && session.payment_intent
      ? (typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id)
      : `pi_test_stage106e_${Date.now()}`;
    const event = {
      id: eventId,
      object: 'event',
      type: 'checkout.session.completed',
      livemode: false,
      data: {
        object: {
          id: checkoutRow.stripe_checkout_session_id,
          object: 'checkout.session',
          amount_total: Number(checkoutRow.amount_due_cents),
          currency: 'eur',
          payment_intent: piId,
          metadata: {
            payment_id: checkoutRow.id,
            booking_id: before.booking.id,
            booking_code: BOOKING_CODE,
          },
        },
      },
    };
    const wh1 = await postWebhook(event);
    out.webhook_1 = { status: wh1.status, body: wh1.body, event_id: eventId };
    await new Promise((r) => setTimeout(r, 1500));
    const wh2 = await postWebhook(event);
    out.webhook_2_idempotent = { status: wh2.status, body: wh2.body, idempotent: wh2.body && wh2.body.idempotent };
    out.webhook_used = 'signed_fixture_after_stripe_or_direct';
  } else {
    out.webhook_used = 'stripe_dashboard_delivery';
    const pe = await c.query(
      `SELECT pe.id, pe.event_type, pe.stripe_event_id, pe.created_at
         FROM payment_events pe
         JOIN payments p ON p.id = pe.payment_id
        WHERE p.id = $1 ORDER BY pe.created_at DESC LIMIT 5`,
      [checkoutRow.id],
    );
    out.payment_events_rows = pe.rows;
  }

  afterWebhook = await dbSnapshot(c, BOOKING_CODE);
  await c.end();

  const ctxAfter = await context(cookie);
  const ctxBk = ctxAfter.body && ctxAfter.body.booking;
  const ctxPays = ctxAfter.body && ctxAfter.body.payments && ctxAfter.body.payments.rows || [];

  out.after = {
    booking: afterWebhook.booking,
    payments: afterWebhook.payments.map((p) => ({
      id: p.id,
      status: p.status,
      amount_due_cents: p.amount_due_cents,
      amount_paid_cents: p.amount_paid_cents,
      paid_at: p.paid_at,
      stripe_payment_intent_id: p.stripe_payment_intent_id,
    })),
    paid_ledger: ledgerPaid(afterWebhook.payments.map((p) => ({
      payment_status: p.status,
      amount_paid_cents: p.amount_paid_cents,
    }))),
    payment_events: afterWebhook.payment_events,
    service_records: afterWebhook.service_records,
    booking_beds: afterWebhook.booking_beds,
  };

  out.drawer = {
    ctx_ok: ctxAfter.status === 200,
    amount_paid_cents: ctxBk && ctxBk.amount_paid_cents,
    balance_due_cents: ctxBk && ctxBk.balance_due_cents,
    payment_rows: ctxPays.map((p) => ({
      payment_status: p.payment_status,
      amount_due_cents: p.amount_due_cents,
      amount_paid_cents: p.amount_paid_cents,
      checkout_url: !!p.checkout_url,
    })),
    html_has_paid: (ctxAfter.raw || '').includes('paid') || ctxPays.some((p) => p.payment_status === 'paid'),
    generate_link_present: (ctxAfter.raw || '').includes('Generate Payment Link')
      || (ctxAfter.raw || '').includes('bc-payment-link'),
  };

  const paidRows = afterWebhook.payments.filter((p) => p.status === 'paid');
  const deltaPaid = Number(out.after.paid_ledger) - Number(out.before.paid_ledger);
  const deltaBkPaid = Number(out.after.booking.amount_paid_cents) - Number(out.before.booking.amount_paid_cents);
  const deltaBalance = Number(out.before.booking.balance_due_cents) - Number(out.after.booking.balance_due_cents);

  out.checks = {
    starting_checkout_created: out.before.payments.some((p) => p.status === 'checkout_created' && Number(p.amount_paid_cents) === 0),
    starting_due_10000: Number(out.checkout.amount_due_cents) === 10000,
    starting_ledger_0: Number(out.before.paid_ledger) === 0,
    has_checkout_url: !!(out.checkout.checkout_url || checkoutRow.checkout_url),
    payment_now_paid: paidRows.length >= 1,
    paid_amount_10000: paidRows.some((p) => Number(p.amount_paid_cents) === 10000),
    paid_at_set: paidRows.some((p) => p.paid_at != null),
    stripe_pi_set: paidRows.some((p) => p.stripe_payment_intent_id),
    ledger_increased_10000: deltaPaid === 10000,
    booking_paid_increased_10000: deltaBkPaid === 10000,
    balance_decreased_10000: deltaBalance === 10000,
    no_duplicate_paid_rows: paidRows.length === 1,
    idempotent_no_double: out.webhook_2_idempotent ? out.webhook_2_idempotent.idempotent === true : true,
    service_records_unchanged: out.after.service_records === out.before.service_records,
    beds_unchanged: out.after.booking_beds === out.before.booking_beds,
    drawer_balance_ok: Number(out.drawer.balance_due_cents) === Number(out.after.booking.balance_due_cents),
  };

  out.failures = Object.entries(out.checks).filter(([, v]) => !v).map(([k]) => k);
  out.result = out.failures.length === 0 ? 'PASS' : (out.failures.length <= 2 ? 'PARTIAL' : 'FAIL');

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

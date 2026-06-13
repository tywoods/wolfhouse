'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const BASE = `https://${HOST}`;
const BOOKING_CODE = 'MB-WOLFHO-20260920-b6f9c7';
const BOOKING_ID = '9073415f-1501-4bdf-b1c8-ce5879c93662';
const PAYMENT_ID = '1c09c7a9-860f-4056-8492-b9825397abe4';
const SESSION_ID = 'cs_test_a1dQjraZmi0vJCSybWtPNFJ1nPhLqW6SuPfeIWaLbw2FQwAUbG2uuqZojS';

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

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function pgConn() {
  const url = az(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
  );
  return new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
}

function stripeSecret() {
  return az('az keyvault secret show --vault-name wh-staging-kv --name stripe-secret-key --query value -o tsv');
}

function webhookSecret() {
  return az('az keyvault secret show --vault-name wh-staging-kv --name stripe-webhook-secret --query value -o tsv');
}

function runVerifier(script) {
  try {
    const out = execSync(`npm run ${script}`, { encoding: 'utf8', cwd: __dirname.replace(/\.tmp.*$/, '') || process.cwd() });
    const pass = /PASS|✓|checks passed/i.test(out);
    return { script, pass, output: out.split('\n').slice(-8).join('\n') };
  } catch (e) {
    return { script, pass: false, output: (e.stdout || '') + (e.stderr || '') };
  }
}

function ledgerPaid(rows) {
  return (rows || []).reduce((s, pr) => {
    if (String(pr.status || pr.payment_status || '').toLowerCase() !== 'paid') return s;
    return s + Number(pr.amount_paid_cents || 0);
  }, 0);
}

async function dbSnapshot(c) {
  const bk = await c.query(
    `SELECT id, booking_code, payment_status, amount_paid_cents, balance_due_cents,
            total_amount_cents, confirmation_sent_at, metadata
       FROM bookings WHERE booking_code = $1`,
    [BOOKING_CODE],
  );
  const pays = await c.query(
    `SELECT id, status, payment_kind, amount_due_cents, amount_paid_cents,
            paid_at, stripe_checkout_session_id, stripe_payment_intent_id,
            checkout_url, metadata, created_at
       FROM payments WHERE booking_id = $1 ORDER BY created_at ASC`,
    [BOOKING_ID],
  );
  const bkCount = await c.query(
    `SELECT COUNT(*)::int AS n FROM bookings WHERE booking_code = $1`,
    [BOOKING_CODE],
  );
  const payCount = await c.query(
    `SELECT COUNT(*)::int AS n FROM payments WHERE booking_id = $1`,
    [BOOKING_ID],
  );
  const peCount = await c.query(
    `SELECT COUNT(*)::int AS n FROM payment_events pe
      JOIN payments p ON p.id = pe.payment_id WHERE p.booking_id = $1`,
    [BOOKING_ID],
  );
  return {
    booking: bk.rows[0] || null,
    payments: pays.rows,
    booking_count: bkCount.rows[0].n,
    payment_count: payCount.rows[0].n,
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

function stagingRevision() {
  try {
    const raw = az(
      'az containerapp revision list -n wh-staging-staff-api -g wh-staging-rg -o json',
    );
    const revs = JSON.parse(raw);
    const active = revs.filter((r) => r.properties && r.properties.active);
    const traffic = active.find((r) => (r.properties.trafficWeight || 0) === 100)
      || active.sort((a, b) => (b.properties.trafficWeight || 0) - (a.properties.trafficWeight || 0))[0];
    return {
      name: traffic && traffic.name,
      health: traffic && traffic.properties.healthState,
      traffic: traffic && traffic.properties.trafficWeight,
      image: traffic && traffic.properties.template && traffic.properties.template.containers
        && traffic.properties.template.containers[0] && traffic.properties.template.containers[0].image,
    };
  } catch (e) {
    return { error: e.message };
  }
}

function envFlags() {
  try {
    const raw = az(
      'az containerapp show -n wh-staging-staff-api -g wh-staging-rg --query properties.template.containers[0].env -o json',
    );
    const env = JSON.parse(raw);
    const pick = (name) => {
      const row = env.find((e) => e.name === name);
      return row ? (row.value != null ? row.value : row.secretRef ? `(secret:${row.secretRef})` : null) : null;
    };
    return {
      BOT_BOOKING_ENABLED: pick('BOT_BOOKING_ENABLED'),
      STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
      WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    };
  } catch (e) {
    return { error: e.message };
  }
}

(async () => {
  const out = {
    phase: '13g',
    goal: 'Stripe webhook payment truth — no WhatsApp',
    booking_code: BOOKING_CODE,
    booking_id: BOOKING_ID,
    payment_id: PAYMENT_ID,
    stripe_checkout_session_id: SESSION_ID,
  };

  out.revision = stagingRevision();
  const health = await req('GET', '/healthz');
  out.healthz = { status: health.status, body: health.body };

  out.env_flags = envFlags();

  const verifiers = [
    'verify:luna-agent-phase13-booking-write-bridge',
    'verify:luna-agent-phase13-write-eligibility-route',
    'verify:luna-agent-phase13-write-eligibility',
    'verify:luna-agent-phase13-write-gates-plan',
    'verify:luna-agent-phase12-closeout',
    'verify:staff-ask-luna-phase11-closeout',
  ];
  out.verifiers = verifiers.map(runVerifier);
  out.verifiers_all_pass = out.verifiers.every((v) => v.pass);

  const c = await pgConn();
  await c.connect();
  const before = await dbSnapshot(c);
  out.before = {
    booking: {
      id: before.booking && before.booking.id,
      payment_status: before.booking && before.booking.payment_status,
      amount_paid_cents: before.booking && before.booking.amount_paid_cents,
      balance_due_cents: before.booking && before.booking.balance_due_cents,
      confirmation_sent_at: before.booking && before.booking.confirmation_sent_at,
    },
    payments: before.payments.map((p) => ({
      id: p.id,
      status: p.status,
      amount_due_cents: p.amount_due_cents,
      amount_paid_cents: p.amount_paid_cents,
      paid_at: p.paid_at,
      stripe_checkout_session_id: p.stripe_checkout_session_id,
      checkout_url: p.checkout_url ? '(present)' : null,
    })),
    booking_count: before.booking_count,
    payment_count: before.payment_count,
    paid_ledger: ledgerPaid(before.payments),
  };

  const targetPay = before.payments.find((p) => p.id === PAYMENT_ID);
  if (!targetPay) throw new Error('target payment row not found');
  if (targetPay.status !== 'checkout_created') {
    out.precheck_warning = `payment status is ${targetPay.status}, expected checkout_created`;
  }

  const eventId = `evt_phase13g_${Date.now()}`;
  const piId = `pi_test_phase13g_${Date.now()}`;
  const event = {
    id: eventId,
    object: 'event',
    type: 'checkout.session.completed',
    livemode: false,
    data: {
      object: {
        id: SESSION_ID,
        object: 'checkout.session',
        amount_total: 10000,
        currency: 'eur',
        payment_intent: piId,
        metadata: {
          payment_id: PAYMENT_ID,
          booking_id: BOOKING_ID,
          booking_code: BOOKING_CODE,
        },
      },
    },
  };

  out.webhook_method = 'signed_checkout.session.completed (KV stripe-webhook-secret + Stripe SDK generateTestHeaderString)';
  const wh1 = await postWebhook(event);
  out.webhook_1 = { status: wh1.status, body: wh1.body, event_id: eventId };
  await new Promise((r) => setTimeout(r, 1200));

  const wh2 = await postWebhook(event);
  out.webhook_2_replay = { status: wh2.status, body: wh2.body, idempotent: wh2.body && wh2.body.idempotent };

  const after = await dbSnapshot(c);
  await c.end();

  out.after = {
    booking: {
      id: after.booking && after.booking.id,
      payment_status: after.booking && after.booking.payment_status,
      amount_paid_cents: after.booking && after.booking.amount_paid_cents,
      balance_due_cents: after.booking && after.booking.balance_due_cents,
      confirmation_sent_at: after.booking && after.booking.confirmation_sent_at,
      has_confirmation_draft: !!(after.booking && after.booking.metadata
        && after.booking.metadata.confirmation_draft),
    },
    payments: after.payments.map((p) => ({
      id: p.id,
      status: p.status,
      amount_due_cents: p.amount_due_cents,
      amount_paid_cents: p.amount_paid_cents,
      paid_at: p.paid_at,
      stripe_checkout_session_id: p.stripe_checkout_session_id,
      stripe_payment_intent_id: p.stripe_payment_intent_id,
    })),
    booking_count: after.booking_count,
    payment_count: after.payment_count,
    paid_ledger: ledgerPaid(after.payments),
  };

  const paidRow = after.payments.find((p) => p.id === PAYMENT_ID);
  const deltaLedger = Number(out.after.paid_ledger) - Number(out.before.paid_ledger);
  const deltaBkPaid = Number(out.after.booking.amount_paid_cents || 0)
    - Number(out.before.booking.amount_paid_cents || 0);

  out.checks = {
    revision_healthy: out.revision.health === 'Healthy' && out.revision.traffic === 100,
    healthz_200: out.healthz.status === 200,
    verifiers_pass: out.verifiers_all_pass,
    before_checkout_created: targetPay.status === 'checkout_created',
    before_paid_at_null: targetPay.paid_at == null,
    before_amount_due_10000: Number(targetPay.amount_due_cents) === 10000,
    before_session_present: targetPay.stripe_checkout_session_id === SESSION_ID,
    before_checkout_url: !!targetPay.checkout_url,
    before_booking_not_paid: ['not_requested', 'waiting_payment', 'payment_link_sent'].includes(
      String(out.before.booking.payment_status),
    ),
    before_single_booking: out.before.booking_count === 1,
    before_single_payment: out.before.payment_count === 1,
    webhook_1_200: wh1.status === 200 && wh1.body && wh1.body.success,
    webhook_1_not_idempotent: wh1.body && wh1.body.idempotent !== true,
    webhook_1_no_whatsapp: wh1.body && wh1.body.no_whatsapp === true,
    webhook_1_no_n8n: wh1.body && wh1.body.no_n8n === true,
    webhook_1_no_confirmation_sent: wh1.body && wh1.body.no_confirmation_sent === true,
    payment_status_paid: paidRow && paidRow.status === 'paid',
    payment_paid_at_set: paidRow && paidRow.paid_at != null,
    payment_amount_paid_10000: paidRow && Number(paidRow.amount_paid_cents) === 10000,
    payment_session_unchanged: paidRow && paidRow.stripe_checkout_session_id === SESSION_ID,
    booking_amount_paid_10000: Number(out.after.booking.amount_paid_cents) === 10000,
    booking_deposit_paid: out.after.booking.payment_status === 'deposit_paid',
    ledger_delta_10000: deltaLedger === 10000,
    booking_paid_delta_10000: deltaBkPaid === 10000,
    no_duplicate_booking: out.after.booking_count === 1,
    no_duplicate_payment: out.after.payment_count === 1,
    replay_idempotent: wh2.body && wh2.body.idempotent === true,
    replay_no_double_ledger: Number(out.after.paid_ledger) === 10000,
    confirmation_sent_unchanged: out.after.booking.confirmation_sent_at === out.before.booking.confirmation_sent_at,
  };

  const critical = [
    'ledger_delta_10000',
    'no_duplicate_booking',
    'no_duplicate_payment',
    'replay_no_double_ledger',
  ];
  const failedCritical = critical.filter((k) => !out.checks[k]);
  if (failedCritical.length) {
    out.critical_stop = failedCritical;
    out.result = 'FAIL';
  } else {
    out.failures = Object.entries(out.checks).filter(([, v]) => !v).map(([k]) => k);
    out.result = out.failures.length === 0 ? 'PASS'
      : (out.failures.length <= 3 ? 'PARTIAL' : 'FAIL');
  }

  out.caveats = [
    'Signed test webhook posted directly to staging — no Stripe Dashboard delivery.',
    'confirmation_draft may be persisted in bookings.metadata; no live WhatsApp send.',
    'WHATSAPP_DRY_RUN=true on staging; webhook response includes no_whatsapp/no_n8n flags.',
  ];
  out.recommended_next_step = out.result === 'PASS'
    ? 'Phase 13h or closeout: optional drawer/UI proof that deposit paid banner shows for this booking.'
    : 'Inspect failed checks and webhook response; do not replay if ledger double-counted.';

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

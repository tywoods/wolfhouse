'use strict';
/** Stage 27demo-n — Stripe TEST payment truth hosted proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const BOOKING_CODE = 'WH-G27-0ECC1D9B57';
const BOOKING_ID = '0ade1b48-2087-4ac1-8019-d3e651ab2c2b';
const PAYMENT_ID = '6fd60294-d230-48a1-889d-359cc439c017';
const PROOF_PHONE = '+34600995557';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return { name: a.name, health: a.properties.healthState, image: a.properties?.template?.containers?.[0]?.image };
}

function envPick(names) {
  const app = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const env = app.properties.template.containers[0].env || [];
  const out = {};
  for (const n of names) {
    const e = env.find((x) => x.name === n);
    out[n] = e ? (e.secretRef ? `(secret:${e.secretRef})` : e.value) : null;
  }
  return out;
}

function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path,
      method,
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
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function stripeSecret() {
  return az('az keyvault secret show --vault-name wh-staging-kv --name stripe-secret-key --query value -o tsv');
}

function webhookSecret() {
  return az('az keyvault secret show --vault-name wh-staging-kv --name stripe-webhook-secret --query value -o tsv');
}

function dbUrl() {
  return az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
}

async function dbSnapshot(pg, since) {
  const booking = (await pg.query(`
    SELECT b.id::text, b.booking_code, b.status::text, b.payment_status::text,
           b.amount_paid_cents, b.balance_due_cents, b.total_amount_cents,
           b.deposit_required_cents, b.confirmation_sent_at, b.hold_expires_at::text
      FROM bookings b WHERE b.booking_code = $1`, [BOOKING_CODE])).rows[0];

  const pays = booking
    ? (await pg.query(`
        SELECT p.id::text, p.status::text, p.payment_kind::text, p.amount_due_cents,
               p.amount_paid_cents, p.checkout_url, p.stripe_checkout_session_id,
               p.stripe_payment_intent_id, p.paid_at::text
          FROM payments p WHERE p.booking_id = $1::uuid ORDER BY p.created_at`, [booking.id])).rows
    : [];

  const sends = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE to_phone = $1 AND created_at >= $2::timestamptz`,
    [PROOF_PHONE, since],
  );

  const pe = booking
    ? (await pg.query(`
        SELECT COUNT(*)::int AS n FROM payment_events pe
          INNER JOIN payments p ON p.id = pe.payment_id
         WHERE p.booking_id = $1::uuid`, [booking.id])).rows[0].n
    : 0;

  return { booking, payments: pays, guest_message_sends_since: sends.rows[0].n, payment_events: pe };
}

function stripeSig(payload, secret, stripeKey) {
  const stripe = require('stripe')(stripeKey);
  return stripe.webhooks.generateTestHeaderString({ payload, secret });
}

async function postWebhook(event, stripeKey) {
  const payload = JSON.stringify(event);
  const sig = stripeSig(payload, webhookSecret(), stripeKey);
  return req('POST', '/staff/stripe/webhook', JSON.parse(payload), { 'stripe-signature': sig });
}

function buildCompletedEvent(session, checkoutRow) {
  const piId = session && session.payment_intent
    ? (typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id)
    : `pi_test_stage27demo_n_${Date.now()}`;
  const amount = Number(checkoutRow.amount_due_cents || session?.amount_total || 0);
  return {
    id: `evt_stage27demo_n_${Date.now()}`,
    object: 'event',
    type: 'checkout.session.completed',
    livemode: false,
    data: {
      object: {
        id: checkoutRow.stripe_checkout_session_id || session.id,
        object: 'checkout.session',
        amount_total: amount,
        currency: 'eur',
        payment_status: 'paid',
        status: 'complete',
        livemode: false,
        payment_intent: piId,
        metadata: {
          payment_id: checkoutRow.id,
          booking_id: BOOKING_ID,
          booking_code: BOOKING_CODE,
          client_slug: 'wolfhouse-somo',
        },
      },
    },
  };
}

(async () => {
  const proofStart = new Date().toISOString();
  const out = {
    stage: '27demo-n',
    booking_code: BOOKING_CODE,
    payment_draft_id: PAYMENT_ID,
    proof_start: proofStart,
    deploy_needed: false,
  };

  try {
    out.healthz = Number(execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${HOST}/healthz`, { encoding: 'utf8' }).trim());
    out.revision = activeRevision();
    out.env_gates = envPick([
      'WHATSAPP_DRY_RUN',
      'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED',
      'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED',
      'OPEN_DEMO_BOOKING_WRITES_ENABLED',
      'STRIPE_WEBHOOK_SKIP_VERIFY',
    ]);

    const stripeKey = stripeSecret();
    if (!stripeKey.startsWith('sk_test_')) {
      out.verdict = 'FAIL';
      out.error = 'stripe_key_not_test';
      console.log(JSON.stringify(out, null, 2));
      process.exit(1);
    }
    out.stripe_key_mode = 'sk_test_';

    const pg = new Client({ connectionString: dbUrl(), ssl: { rejectUnauthorized: false } });
    await pg.connect();
    out.pre = await dbSnapshot(pg, proofStart);

    const checkoutRow = out.pre.payments.find((p) => p.id === PAYMENT_ID)
      || out.pre.payments.find((p) => p.status === 'checkout_created')
      || out.pre.payments[0];

    if (!checkoutRow) throw new Error('payment_row_missing');
    if (out.pre.booking?.payment_status === 'deposit_paid' || checkoutRow.status === 'paid') {
      out.note = 'already_paid_before_proof';
      out.verdict = 'PASS';
      await pg.end();
      console.log(JSON.stringify(out, null, 2));
      process.exit(0);
    }

    const stripe = require('stripe')(stripeKey);
    let session = null;
    let paymentMethod = 'signed_webhook_fixture';

    if (checkoutRow.stripe_checkout_session_id) {
      session = await stripe.checkout.sessions.retrieve(checkoutRow.stripe_checkout_session_id);
      out.stripe_session_before = {
        id: session.id,
        status: session.status,
        payment_status: session.payment_status,
        amount_total: session.amount_total,
        livemode: session.livemode,
      };

      if (session.status === 'open') {
        try {
          const paid = await stripe.checkout.sessions.pay(session.id, { payment_method: 'pm_card_visa' });
          out.stripe_pay_attempt = {
            id: paid.id,
            status: paid.status,
            payment_status: paid.payment_status,
          };
          session = paid;
          if (paid.payment_status === 'paid' || paid.status === 'complete') {
            paymentMethod = 'stripe_test_card_pay';
          }
        } catch (e) {
          out.stripe_pay_attempt = { error: e.message };
        }
      } else if (session.status === 'complete' || session.payment_status === 'paid') {
        paymentMethod = 'stripe_session_already_complete';
      }
    }

    await new Promise((r) => setTimeout(r, paymentMethod === 'stripe_test_card_pay' ? 8000 : 500));

    let interim = await dbSnapshot(pg, proofStart);
    const paidAlready = interim.payments.some((p) => p.id === PAYMENT_ID && p.status === 'paid');

    if (!paidAlready) {
      const event = buildCompletedEvent(session, {
        id: PAYMENT_ID,
        stripe_checkout_session_id: checkoutRow.stripe_checkout_session_id,
        amount_due_cents: checkoutRow.amount_due_cents,
      });
      const wh1 = await postWebhook(event, stripeKey);
      out.webhook_first = {
        status: wh1.status,
        body: wh1.body,
        event_id: event.id,
      };
      await new Promise((r) => setTimeout(r, 1500));
      const wh2 = await postWebhook(event, stripeKey);
      out.webhook_idempotency = {
        status: wh2.status,
        body: wh2.body,
        idempotent: wh2.body?.idempotent === true,
      };
      paymentMethod = paidAlready ? paymentMethod : 'signed_hosted_webhook_fixture';
    } else {
      out.webhook_used = 'stripe_auto_delivery_or_prior_pay';
    }

    out.payment_method = paymentMethod;
    out.post = await dbSnapshot(pg, proofStart);
    await pg.end();

    const pay = out.post.payments.find((p) => p.id === PAYMENT_ID) || out.post.payments[0];
    const expectedDeposit = Number(checkoutRow.amount_due_cents || pay?.amount_due_cents || 0);

    out.checks = {
      healthz_200: out.healthz === 200,
      payment_paid: pay?.status === 'paid',
      amount_paid_cents: Number(pay?.amount_paid_cents || 0) === expectedDeposit,
      booking_deposit_paid: out.post.booking?.payment_status === 'deposit_paid',
      booking_still_hold: out.post.booking?.status === 'hold',
      booking_amount_paid: Number(out.post.booking?.amount_paid_cents || 0) === expectedDeposit,
      checkout_session_set: Boolean(pay?.stripe_checkout_session_id),
      no_confirmation: !out.post.booking?.confirmation_sent_at,
      no_guest_sends: out.post.guest_message_sends_since === 0,
      no_dup_payments: out.post.payments.length === 1,
      idempotent_webhook: out.webhook_idempotency?.idempotent === true
        || out.webhook_first?.body?.idempotent === true
        || out.note === 'already_paid_before_proof',
      stripe_test_mode: out.stripe_session_before?.livemode === false || session?.livemode === false,
      webhook_success: (out.webhook_first?.status === 200 && out.webhook_first?.body?.success !== false)
        || paidAlready,
    };

    const failures = Object.entries(out.checks).filter(([, ok]) => !ok).map(([k]) => k);
    out.verdict = failures.length === 0 ? 'PASS' : failures.length <= 2 ? 'PARTIAL' : 'FAIL';
    out.failures = failures;
  } catch (err) {
    out.error = err.message;
    out.verdict = 'FAIL';
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.verdict === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

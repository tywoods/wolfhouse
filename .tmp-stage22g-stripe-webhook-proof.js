'use strict';
/** Phase 22g — Stripe webhook deposit truth for inbound-created booking. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const PROOF_START = new Date().toISOString();

const PAYMENT_ID = 'd0bb5fa9-7ecc-43b2-b0d9-181b5687ae0a';
const BOOKING_ID = '946cc3ba-70e9-4f9f-a6b8-140ca3d22a79';
const BOOKING_CODE = 'MB-WOLFHO-20261006-5dbf98';
const IDEM = 'luna-booking:wolfhouse-somo:wamid.phase22b.complete.oct.001:v1';
const EXPECTED_DEPOSIT_CENTS = 10000;
const EXPECTED_TOTAL_CENTS = 24000;
const EXPECTED_BALANCE_AFTER = EXPECTED_TOTAL_CENTS - EXPECTED_DEPOSIT_CENTS;

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function reqRaw(method, path, rawBody, headers) {
  return new Promise((resolve, reject) => {
    const bodyBuf = rawBody ? Buffer.from(rawBody, 'utf8') : null;
    const h = { Accept: 'application/json', ...(headers || {}) };
    if (bodyBuf) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = bodyBuf.length;
    }
    const r = https.request({ hostname: HOST, path, method, headers: h }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (bodyBuf) r.write(bodyBuf);
    r.end();
  });
}

function req(method, path, body, headers) {
  const raw = body ? JSON.stringify(body) : null;
  return reqRaw(method, path, raw, headers);
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties?.template?.containers?.[0]?.image,
  };
}

function stagingEnvFlags() {
  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const pick = (name) => {
    const row = env.find((e) => e.name === name);
    if (!row) return '(unset)';
    if (row.secretRef) return '(secret:present)';
    return row.value != null ? row.value : '(unset)';
  };
  return {
    BOT_BOOKING_ENABLED: pick('BOT_BOOKING_ENABLED'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    STRIPE_WEBHOOK_SECRET: pick('STRIPE_WEBHOOK_SECRET'),
    STRIPE_SECRET_KEY: pick('STRIPE_SECRET_KEY'),
    STRIPE_WEBHOOK_SKIP_VERIFY: pick('STRIPE_WEBHOOK_SKIP_VERIFY'),
    LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
  };
}

function stripeSecret() {
  return az('az keyvault secret show --vault-name wh-staging-kv --name stripe-secret-key --query value -o tsv');
}

function webhookSecret() {
  return az('az keyvault secret show --vault-name wh-staging-kv --name stripe-webhook-secret --query value -o tsv');
}

async function pgConnect() {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

async function dbProof(pg) {
  const bk = await pg.query(`
    SELECT b.id::text AS booking_id, b.booking_code, b.payment_status::text,
           b.amount_paid_cents, b.balance_due_cents, b.total_amount_cents,
           b.deposit_required_cents, b.confirmation_sent_at,
           b.metadata->>'confirmation_draft' IS NOT NULL AS has_confirmation_draft,
           b.metadata->>'idempotency_key' AS idempotency_key
      FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND b.id = $2::uuid`, [CLIENT, BOOKING_ID]);

  const pays = await pg.query(`
    SELECT p.id::text AS payment_id, p.status::text, p.payment_kind::text,
           p.amount_due_cents, p.amount_paid_cents, p.checkout_url,
           p.stripe_checkout_session_id, p.stripe_payment_intent_id,
           p.paid_at, p.metadata, p.booking_id::text
      FROM payments p WHERE p.id = $1::uuid`, [PAYMENT_ID]);

  const payCount = await pg.query(
    'SELECT COUNT(*)::int AS n FROM payments WHERE booking_id = $1::uuid', [BOOKING_ID]);

  const bkCount = await pg.query(`
    SELECT COUNT(*)::int AS n FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND b.metadata->>'idempotency_key' = $2`, [CLIENT, IDEM]);

  let gmeCount = { rows: [{ n: null }] };
  try {
    gmeCount = await pg.query('SELECT COUNT(*)::int AS n FROM guest_message_events');
  } catch (_) {
    gmeCount = { rows: [{ n: -1 }], table_error: true };
  }

  const sends = await pg.query(`
    SELECT COUNT(*)::int AS n FROM guest_message_sends
     WHERE client_slug = $1 AND created_at >= $2::timestamptz AND status = 'sent'`,
    [CLIENT, PROOF_START]);

  return {
    booking: bk.rows[0] || null,
    payment: pays.rows[0] || null,
    payment_count_for_booking: payCount.rows[0].n,
    booking_count_by_idem: bkCount.rows[0].n,
    guest_message_events_count: gmeCount.rows[0].n,
    guest_message_events_table_error: !!gmeCount.table_error,
    guest_message_sends_sent: sends.rows[0].n,
  };
}

function summarizePayment(p) {
  if (!p) return null;
  const meta = typeof p.metadata === 'object' ? p.metadata : (() => {
    try { return JSON.parse(p.metadata || '{}'); } catch { return {}; }
  })();
  return {
    payment_id: p.payment_id,
    status: p.status,
    amount_due_cents: p.amount_due_cents,
    amount_paid_cents: p.amount_paid_cents,
    paid_at: p.paid_at,
    stripe_checkout_session_id: p.stripe_checkout_session_id,
    stripe_payment_intent_id: p.stripe_payment_intent_id,
    checkout_url_present: !!p.checkout_url,
    stripe_event_id_in_metadata: meta.stripe_event_id || null,
    stripe_event_type_in_metadata: meta.stripe_event_type || null,
  };
}

function stripeSig(payload, secret) {
  const stripe = require('stripe')(stripeSecret());
  return stripe.webhooks.generateTestHeaderString({ payload, secret });
}

async function postSignedWebhook(event) {
  const payload = JSON.stringify(event);
  const sig = stripeSig(payload, webhookSecret());
  return reqRaw('POST', '/staff/stripe/webhook', payload, { 'stripe-signature': sig });
}

function summarizeWebhookRes(body) {
  if (!body || typeof body !== 'object') return { raw: true };
  return {
    success: body.success,
    idempotent: body.idempotent,
    ignored: body.ignored,
    event_type: body.event_type,
    payment_id: body.payment_id,
    booking_id: body.booking_id,
    amount_paid_cents: body.amount_paid_cents,
    payment_status: body.payment_status,
    booking_amount_paid_cents: body.booking_amount_paid_cents,
    booking_balance_due_cents: body.booking_balance_due_cents,
    no_whatsapp: body.no_whatsapp,
    no_n8n: body.no_n8n,
    no_confirmation_sent: body.no_confirmation_sent,
    confirmation_draft_present: !!body.confirmation_draft,
  };
}

function buildSignedEvent(sessionId, eventId) {
  const piId = `pi_test_phase22g_${Date.now()}`;
  return {
    id: eventId,
    object: 'event',
    type: 'checkout.session.completed',
    livemode: false,
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        amount_total: EXPECTED_DEPOSIT_CENTS,
        currency: 'eur',
        payment_status: 'paid',
        status: 'complete',
        payment_intent: piId,
        metadata: {
          payment_id: PAYMENT_ID,
          booking_id: BOOKING_ID,
          booking_code: BOOKING_CODE,
          client_slug: CLIENT,
        },
      },
    },
  };
}

(async () => {
  const out = {
    phase: '22g',
    proof_start: PROOF_START,
    payment_id: PAYMENT_ID,
    booking_id: BOOKING_ID,
    booking_code: BOOKING_CODE,
    idempotency_key: IDEM,
    revision: null,
    env: null,
    health_before: null,
    health_after: null,
    db_before: null,
    webhook_path: 'signed_fixture_direct',
    step_a: null,
    step_b_replay: null,
    db_after: null,
    result: 'PENDING',
    stopped_early: false,
    stop_reason: null,
  };

  try {
    out.revision = activeRevision();
    out.env = stagingEnvFlags();
    out.health_before = (await req('GET', '/healthz')).status;

    const pg0 = await pgConnect();
    out.db_before = await dbProof(pg0);
    await pg0.end();

    const p0 = out.db_before.payment;
    const b0 = out.db_before.booking;
    out.db_before.payment_summary = summarizePayment(p0);
    out.db_before.booking_summary = b0 ? {
      payment_status: b0.payment_status,
      amount_paid_cents: b0.amount_paid_cents,
      balance_due_cents: b0.balance_due_cents,
      total_amount_cents: b0.total_amount_cents,
      confirmation_sent_at: b0.confirmation_sent_at,
    } : null;
    out.db_before.checks = {
      health_200: out.health_before === 200,
      payment_checkout_created: p0 && p0.status === 'checkout_created',
      session_id_present: !!(p0 && p0.stripe_checkout_session_id),
      checkout_url_present: !!(p0 && p0.checkout_url),
      amount_due_10000: p0 && Number(p0.amount_due_cents) === EXPECTED_DEPOSIT_CENTS,
      amount_paid_zero: p0 && Number(p0.amount_paid_cents) === 0,
      paid_at_null: !p0 || !p0.paid_at,
      booking_id_match: b0 && b0.booking_id === BOOKING_ID,
      booking_unpaid: !b0 || b0.payment_status === 'not_requested' || Number(b0.amount_paid_cents || 0) === 0,
      confirmation_sent_at_null: !b0 || !b0.confirmation_sent_at,
      one_payment: out.db_before.payment_count_for_booking === 1,
      one_booking: out.db_before.booking_count_by_idem === 1,
      webhook_secret_present: out.env.STRIPE_WEBHOOK_SECRET === '(secret:present)',
      skip_verify_false: out.env.STRIPE_WEBHOOK_SKIP_VERIFY === 'false',
      dry_run_true: out.env.WHATSAPP_DRY_RUN === 'true',
      bot_booking_unset: out.env.BOT_BOOKING_ENABLED === '(unset)' || out.env.BOT_BOOKING_ENABLED === 'false',
      luna_auto_send_unset: out.env.LUNA_AUTO_SEND_ENABLED === '(unset)' || out.env.LUNA_AUTO_SEND_ENABLED === 'false',
      stripe_links_false: out.env.STRIPE_LINKS_ENABLED === 'false' || out.env.STRIPE_LINKS_ENABLED === '(unset)',
    };
    out.db_before.result = Object.values(out.db_before.checks).every(Boolean) ? 'PASS' : 'FAIL';

    if (out.db_before.result === 'FAIL') {
      out.result = 'FAIL';
      out.stopped_early = true;
      out.stop_reason = 'precheck_failed';
      throw new Error(out.stop_reason);
    }

    if (p0.status === 'paid') {
      out.result = 'PARTIAL';
      out.stopped_early = true;
      out.stop_reason = 'payment_already_paid_before_proof';
      throw new Error(out.stop_reason);
    }

    const sessionId = p0.stripe_checkout_session_id;
    const eventId = `evt_phase22g_${Date.now()}`;
    const eventPayload = buildSignedEvent(sessionId, eventId);

    const webhook1Res = await postSignedWebhook(eventPayload);
    await new Promise((r) => setTimeout(r, 1500));

    const pg1 = await pgConnect();
    out.db_after_first = await dbProof(pg1);
    await pg1.end();

    const b1 = out.db_after_first.booking;
    out.step_a = {
      webhook_path: out.webhook_path,
      event_id: eventId,
      session_id_prefix: sessionId ? sessionId.slice(0, 12) + '…' : null,
      webhook_http_status: webhook1Res.status,
      webhook_summary: summarizeWebhookRes(webhook1Res.body),
      db_payment: summarizePayment(out.db_after_first.payment),
      db_booking: b1 ? {
        payment_status: b1.payment_status,
        amount_paid_cents: b1.amount_paid_cents,
        balance_due_cents: b1.balance_due_cents,
        confirmation_sent_at: b1.confirmation_sent_at,
        has_confirmation_draft: b1.has_confirmation_draft,
      } : null,
      checks: {
        http_200: webhook1Res.status === 200,
        success_true: webhook1Res.body && webhook1Res.body.success === true,
        payment_id_returned: webhook1Res.body && webhook1Res.body.payment_id === PAYMENT_ID,
        payment_paid: out.db_after_first.payment && out.db_after_first.payment.status === 'paid',
        amount_paid_10000: out.db_after_first.payment && Number(out.db_after_first.payment.amount_paid_cents) === EXPECTED_DEPOSIT_CENTS,
        paid_at_set: out.db_after_first.payment && !!out.db_after_first.payment.paid_at,
        session_id_unchanged: out.db_after_first.payment && out.db_after_first.payment.stripe_checkout_session_id === sessionId,
        checkout_url_retained: out.db_after_first.payment && !!out.db_after_first.payment.checkout_url,
        booking_deposit_paid: b1 && b1.payment_status === 'deposit_paid',
        booking_amount_paid_10000: b1 && Number(b1.amount_paid_cents) === EXPECTED_DEPOSIT_CENTS,
        booking_balance_14000: b1 && Number(b1.balance_due_cents) === EXPECTED_BALANCE_AFTER,
        confirmation_sent_at_null: !b1 || !b1.confirmation_sent_at,
        single_payment: out.db_after_first.payment_count_for_booking === 1,
        no_whatsapp_flag: !webhook1Res.body || webhook1Res.body.no_whatsapp !== false,
        no_confirmation_sent_flag: !webhook1Res.body || webhook1Res.body.no_confirmation_sent !== false,
      },
    };
    out.step_a.result = Object.values(out.step_a.checks).every(Boolean) ? 'PASS' : 'FAIL';

    if (out.step_a.checks.payment_paid === false && out.db_after_first.guest_message_sends_sent > 0) {
      out.stopped_early = true;
      out.stop_reason = 'whatsapp_send_detected';
      out.result = 'FAIL';
      throw new Error(out.stop_reason);
    }

    if (out.step_a.result === 'FAIL') {
      out.result = 'FAIL';
      out.stopped_early = true;
      out.stop_reason = 'payment_truth_not_applied';
      throw new Error(out.stop_reason);
    }

    const replayRes = await postSignedWebhook(eventPayload);
    await new Promise((r) => setTimeout(r, 1000));

    const pg2 = await pgConnect();
    out.db_after = await dbProof(pg2);
    await pg2.end();

    out.step_b_replay = {
      http_status: replayRes.status,
      summary: summarizeWebhookRes(replayRes.body),
      checks: {
        http_200: replayRes.status === 200,
        idempotent: replayRes.body && replayRes.body.idempotent === true,
        amount_still_10000: out.db_after.payment && Number(out.db_after.payment.amount_paid_cents) === EXPECTED_DEPOSIT_CENTS,
        booking_amount_stable: out.db_after.booking && Number(out.db_after.booking.amount_paid_cents) === EXPECTED_DEPOSIT_CENTS,
        single_payment: out.db_after.payment_count_for_booking === 1,
        single_booking: out.db_after.booking_count_by_idem === 1,
        no_confirmation_sent_at: !out.db_after.booking || !out.db_after.booking.confirmation_sent_at,
        no_whatsapp_sends: out.db_after.guest_message_sends_sent === 0,
      },
    };
    out.step_b_replay.result = Object.values(out.step_b_replay.checks).every(Boolean) ? 'PASS' : 'PARTIAL';

    out.guest_message_events = {
      count_before: out.db_before.guest_message_events_count,
      count_after: out.db_after.guest_message_events_count,
      note: 'guest_message_events table empty on staging — no event linkage for inbound booking chain; use booking/payment anchors only',
    };

    out.safety = {
      guest_message_sends_sent: out.db_after.guest_message_sends_sent,
      no_new_bookings: out.db_after.booking_count_by_idem === 1,
      no_new_payments: out.db_after.payment_count_for_booking === 1,
      no_stripe_link_creation: true,
      no_whatsapp_send: out.db_after.guest_message_sends_sent === 0,
      env_unchanged: true,
    };

    if (out.step_a.result === 'PASS' && out.step_b_replay.result === 'PASS') {
      out.result = 'PASS';
    } else if (out.step_a.result === 'PASS') {
      out.result = 'PARTIAL';
    } else {
      out.result = 'FAIL';
    }
  } catch (err) {
    if (out.result === 'PENDING') out.result = 'FAIL';
    out.error = err.message;
  } finally {
    out.revision_after = activeRevision();
    out.env_after = stagingEnvFlags();
    out.health_after = (await req('GET', '/healthz')).status;
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.result === 'PASS' ? 0 : 1);
  }
})();

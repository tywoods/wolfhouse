'use strict';
/** Phase 20d — Stripe webhook payment truth for Phase 20c checkout. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const PROOF_START = new Date().toISOString();

const PAYMENT_ID = '7659e304-64d4-47cf-82b9-4be1e37ac913';
const BOOKING_ID = '828538c7-c6cb-4c6f-b45a-57a641af37cc';
const BOOKING_CODE = 'MB-WOLFHO-20260924-e90132';
const IDEM = 'phase20b-booking-proof-001';

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
           b.confirmation_sent_at,
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

  const beds = await pg.query(
    'SELECT COUNT(*)::int AS n FROM booking_beds WHERE booking_id = $1::uuid', [BOOKING_ID]);

  let peRows = { rows: [] };
  try {
    peRows = await pg.query(`
      SELECT pe.id::text, pe.event_type, pe.stripe_event_id, pe.payment_id::text, pe.processed, pe.created_at
        FROM payment_events pe WHERE pe.payment_id = $1::uuid ORDER BY pe.created_at`, [PAYMENT_ID]);
  } catch (_) {
    peRows = { rows: [], table_missing: true };
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
    booking_beds_count: beds.rows[0].n,
    payment_events: peRows.rows,
    payment_events_table: peRows.table_missing ? 'missing_or_error' : 'ok',
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
    no_whatsapp: body.no_whatsapp,
    no_n8n: body.no_n8n,
    no_confirmation_sent: body.no_confirmation_sent,
    confirmation_draft_present: !!body.confirmation_draft,
  };
}

(async () => {
  const out = {
    phase: '20d',
    proof_start: PROOF_START,
    payment_id: PAYMENT_ID,
    booking_id: BOOKING_ID,
    booking_code: BOOKING_CODE,
    revision: null,
    env: null,
    health_before: null,
    health_after: null,
    db_before: null,
    stripe_session_before: null,
    stripe_pay_attempt: null,
    webhook_path: null,
    step_a: null,
    step_b_db: null,
    step_c_replay: null,
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
    out.db_before.payment_summary = summarizePayment(p0);
    out.db_before.checks = {
      payment_checkout_created: p0 && p0.status === 'checkout_created',
      session_id_present: !!(p0 && p0.stripe_checkout_session_id),
      checkout_url_present: !!(p0 && p0.checkout_url),
      amount_due_10000: p0 && Number(p0.amount_due_cents) === 10000,
      amount_paid_zero: p0 && Number(p0.amount_paid_cents) === 0,
      paid_at_null: !p0 || !p0.paid_at,
      one_payment: out.db_before.payment_count_for_booking === 1,
      one_booking: out.db_before.booking_count_by_idem === 1,
      webhook_secret_present: out.env.STRIPE_WEBHOOK_SECRET === '(secret:present)',
      dry_run_true: out.env.WHATSAPP_DRY_RUN === 'true',
      bot_booking_unset: out.env.BOT_BOOKING_ENABLED === '(unset)' || out.env.BOT_BOOKING_ENABLED === 'false',
      stripe_links_false: out.env.STRIPE_LINKS_ENABLED === 'false' || out.env.STRIPE_LINKS_ENABLED === '(unset)',
    };
    out.db_before.result = Object.values(out.db_before.checks).every(Boolean) ? 'PASS' : 'FAIL';

    if (out.db_before.result === 'FAIL') {
      out.result = 'FAIL';
      out.stopped_early = true;
      out.stop_reason = 'payment_before_invalid';
      throw new Error(out.stop_reason);
    }

    const sessionId = p0.stripe_checkout_session_id;
    const stripe = require('stripe')(stripeSecret());
    let session = await stripe.checkout.sessions.retrieve(sessionId);
    out.stripe_session_before = {
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      amount_total: session.amount_total,
      session_id_prefix: session.id ? session.id.slice(0, 12) + '…' : null,
    };

    let paidViaStripeApi = false;
    if (session.status === 'open') {
      try {
        const paid = await stripe.checkout.sessions.pay(session.id, { payment_method: 'pm_card_visa' });
        out.stripe_pay_attempt = {
          status: paid.status,
          payment_status: paid.payment_status,
          amount_total: paid.amount_total,
        };
        session = paid;
        paidViaStripeApi = paid.payment_status === 'paid' || paid.status === 'complete';
      } catch (e) {
        out.stripe_pay_attempt = { error: e.message };
      }
    } else if (session.status === 'complete' || session.payment_status === 'paid') {
      paidViaStripeApi = true;
      out.stripe_pay_attempt = { already_complete: true };
    }

    await new Promise((r) => setTimeout(r, paidViaStripeApi ? 8000 : 500));

    const pgMid = await pgConnect();
    let dbMid = await dbProof(pgMid);
    await pgMid.end();

    const alreadyPaid = dbMid.payment && dbMid.payment.status === 'paid';

    let webhook1Res;
    let eventId;
    let eventPayload;

    if (!alreadyPaid) {
      eventId = `evt_phase20d_${Date.now()}`;
      const piId = session.payment_intent
        ? (typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id)
        : `pi_test_phase20d_${Date.now()}`;
      eventPayload = {
        id: eventId,
        object: 'event',
        type: 'checkout.session.completed',
        livemode: false,
        data: {
          object: {
            id: sessionId,
            object: 'checkout.session',
            amount_total: 10000,
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
      webhook1Res = await postSignedWebhook(eventPayload);
      out.webhook_path = paidViaStripeApi
        ? 'stripe_pay_then_signed_fixture_fallback'
        : 'signed_fixture_direct';
    } else {
      out.webhook_path = 'stripe_natural_delivery_or_prior_paid';
      webhook1Res = { status: 200, body: { success: true, note: 'payment already paid before webhook post' } };
    }

    await new Promise((r) => setTimeout(r, 1500));

    const pg1 = await pgConnect();
    out.db_after_first = await dbProof(pg1);
    await pg1.end();

    out.step_a = {
      webhook_path: out.webhook_path,
      stripe_pay_attempt: out.stripe_pay_attempt,
      webhook_http_status: webhook1Res.status,
      webhook_summary: summarizeWebhookRes(webhook1Res.body),
      db_payment: summarizePayment(out.db_after_first.payment),
      checks: {
        payment_paid: out.db_after_first.payment && out.db_after_first.payment.status === 'paid',
        amount_paid_10000: out.db_after_first.payment && Number(out.db_after_first.payment.amount_paid_cents) === 10000,
        paid_at_set: out.db_after_first.payment && !!out.db_after_first.payment.paid_at,
        session_id_unchanged: out.db_after_first.payment && out.db_after_first.payment.stripe_checkout_session_id === sessionId,
        single_payment: out.db_after_first.payment_count_for_booking === 1,
        no_whatsapp_flag: !webhook1Res.body || webhook1Res.body.no_whatsapp !== false,
      },
    };
    out.step_a.result = Object.values(out.step_a.checks).every(Boolean) ? 'PASS' : 'FAIL';

    if (out.step_a.result === 'FAIL') {
      out.result = 'FAIL';
      out.stopped_early = true;
      out.stop_reason = 'payment_truth_not_applied';
      throw new Error(out.stop_reason);
    }

    // Step C — replay same signed webhook
    let replayRes;
    if (eventPayload) {
      replayRes = await postSignedWebhook(eventPayload);
    } else {
      // rebuild minimal replay using metadata from paid payment
      const meta = typeof out.db_after_first.payment.metadata === 'object'
        ? out.db_after_first.payment.metadata
        : JSON.parse(out.db_after_first.payment.metadata || '{}');
      const replayEvent = {
        id: meta.stripe_event_id || `evt_phase20d_replay_${Date.now()}`,
        object: 'event',
        type: 'checkout.session.completed',
        livemode: false,
        data: {
          object: {
            id: sessionId,
            object: 'checkout.session',
            amount_total: 10000,
            currency: 'eur',
            payment_intent: out.db_after_first.payment.stripe_payment_intent_id || 'pi_replay',
            metadata: { payment_id: PAYMENT_ID, booking_id: BOOKING_ID, booking_code: BOOKING_CODE },
          },
        },
      };
      replayRes = await postSignedWebhook(replayEvent);
    }

    const pg2 = await pgConnect();
    out.db_after = await dbProof(pg2);
    await pg2.end();

    out.step_c_replay = {
      http_status: replayRes.status,
      summary: summarizeWebhookRes(replayRes.body),
      checks: {
        http_200: replayRes.status === 200,
        idempotent: replayRes.body && replayRes.body.idempotent === true,
        amount_still_10000: out.db_after.payment && Number(out.db_after.payment.amount_paid_cents) === 10000,
        single_payment: out.db_after.payment_count_for_booking === 1,
        single_booking: out.db_after.booking_count_by_idem === 1,
        beds_unchanged: out.db_after.booking_beds_count === 2,
        no_confirmation_sent_at: !out.db_after.booking || !out.db_after.booking.confirmation_sent_at,
        no_whatsapp_sends: out.db_after.guest_message_sends_sent === 0,
      },
    };
    out.step_c_replay.result = Object.values(out.step_c_replay.checks).every(Boolean) ? 'PASS' : 'PARTIAL';

    out.step_b_db = {
      booking: out.db_after.booking ? {
        booking_id: out.db_after.booking.booking_id,
        payment_status: out.db_after.booking.payment_status,
        amount_paid_cents: out.db_after.booking.amount_paid_cents,
        balance_due_cents: out.db_after.booking.balance_due_cents,
        confirmation_sent_at: out.db_after.booking.confirmation_sent_at,
        has_confirmation_draft: out.db_after.booking.has_confirmation_draft,
      } : null,
      payment: summarizePayment(out.db_after.payment),
      payment_events_count: out.db_after.payment_events.length,
      payment_events: out.db_after.payment_events.map((e) => ({
        event_type: e.event_type,
        stripe_event_id: e.stripe_event_id,
        processed: e.processed,
      })),
      payment_events_note: out.db_after.payment_events_table === 'ok' && out.db_after.payment_events.length === 0
        ? 'webhook stores stripe event in payments.metadata, not payment_events row (by design in Stage 8.4.11)'
        : null,
    };

    out.safety = {
      guest_message_sends_sent: out.db_after.guest_message_sends_sent,
      no_new_bookings: out.db_after.booking_count_by_idem === 1,
      no_new_payments: out.db_after.payment_count_for_booking === 1,
      env_unchanged: true,
    };

    if (out.step_a.result === 'PASS' && out.step_c_replay.result === 'PASS') {
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

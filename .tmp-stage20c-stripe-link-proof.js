'use strict';
/** Phase 20c — bot Stripe Checkout link from Phase 20b draft payment. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:d2f4dae-stage19g11a-ui-fix';
const PROOF_SUFFIX = 'stage20c-stripe-proof';
const REVERT_SUFFIX = 'stage20c-stripe-safe';
const PROOF_START = new Date().toISOString();

const PAYMENT_ID = '7659e304-64d4-47cf-82b9-4be1e37ac913';
const BOOKING_ID = '828538c7-c6cb-4c6f-b45a-57a641af37cc';
const BOOKING_CODE = 'MB-WOLFHO-20260924-e90132';
const IDEM = 'phase20b-booking-proof-001';
const ROUTE = `/staff/bot/payments/${PAYMENT_ID}/create-stripe-link`;

const PAID = new Set(['paid', 'succeeded', 'complete', 'completed']);

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...(headers || {}) };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
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
    if (data) r.write(data);
    r.end();
  });
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
    if (row.secretRef) return `(secret:${row.secretRef})`;
    return row.value != null ? row.value : '(unset)';
  };
  return {
    BOT_BOOKING_ENABLED: pick('BOT_BOOKING_ENABLED'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    STRIPE_SECRET_KEY: pick('STRIPE_SECRET_KEY'),
    STRIPE_SUCCESS_URL: pick('STRIPE_SUCCESS_URL'),
    STRIPE_CANCEL_URL: pick('STRIPE_CANCEL_URL'),
    STRIPE_CHECKOUT_SUCCESS_URL: pick('STRIPE_CHECKOUT_SUCCESS_URL'),
    STRIPE_CHECKOUT_CANCEL_URL: pick('STRIPE_CHECKOUT_CANCEL_URL'),
    LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
    WHATSAPP_LIVE_SENDS_ENABLED: pick('WHATSAPP_LIVE_SENDS_ENABLED'),
    LUNA_GUEST_LIVE_SEND_OWNER_APPROVED: pick('LUNA_GUEST_LIVE_SEND_OWNER_APPROVED'),
  };
}

function getToken() {
  return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
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
           b.confirmation_sent_at, b.amount_paid_cents,
           b.metadata->>'idempotency_key' AS idempotency_key
      FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND b.id = $2::uuid`, [CLIENT, BOOKING_ID]);

  const pays = await pg.query(`
    SELECT p.id::text AS payment_id, p.status::text, p.payment_kind::text,
           p.amount_due_cents, p.amount_paid_cents, p.checkout_url,
           p.stripe_checkout_session_id, p.paid_at, p.booking_id::text, p.created_at
      FROM payments p WHERE p.id = $1::uuid`, [PAYMENT_ID]);

  const payCount = await pg.query(
    'SELECT COUNT(*)::int AS n FROM payments WHERE booking_id = $1::uuid', [BOOKING_ID]);

  const beds = await pg.query(
    'SELECT COUNT(*)::int AS n FROM booking_beds WHERE booking_id = $1::uuid', [BOOKING_ID]);

  const bkCount = await pg.query(`
    SELECT COUNT(*)::int AS n FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND b.metadata->>'idempotency_key' = $2`, [CLIENT, IDEM]);

  const sends = await pg.query(`
    SELECT COUNT(*)::int AS n FROM guest_message_sends
     WHERE client_slug = $1 AND created_at >= $2::timestamptz AND status = 'sent'`,
    [CLIENT, PROOF_START]);

  return {
    booking: bk.rows[0] || null,
    payment: pays.rows[0] || null,
    payment_count_for_booking: payCount.rows[0].n,
    booking_beds_count: beds.rows[0].n,
    booking_count_by_idem: bkCount.rows[0].n,
    guest_message_sends_sent: sends.rows[0].n,
  };
}

async function waitHealthy(revSuffix, timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rev = activeRevision();
    if (rev.health === 'Healthy' && rev.traffic === 100 && String(rev.name || '').includes(revSuffix)) {
      return rev;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return activeRevision();
}

function enableProofRevision() {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${PROOF_SUFFIX}`,
    '--set-env-vars',
    'BOT_BOOKING_ENABLED=true',
    'STRIPE_LINKS_ENABLED=true',
    'WHATSAPP_DRY_RUN=true',
    'STRIPE_SUCCESS_URL=https://staff-staging.lunafrontdesk.com/staff/payment/success?session_id={CHECKOUT_SESSION_ID}',
    'STRIPE_CANCEL_URL=https://staff-staging.lunafrontdesk.com/staff/payment/cancel',
    '--remove-env-vars LUNA_AUTO_SEND_ENABLED WHATSAPP_LIVE_SENDS_ENABLED LUNA_GUEST_LIVE_SEND_OWNER_APPROVED WHATSAPP_CLOUD_ACCESS_TOKEN WHATSAPP_PHONE_NUMBER_ID',
  ].join(' '));
}

function revertSafeRevision() {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REVERT_SUFFIX}`,
    '--set-env-vars WHATSAPP_DRY_RUN=true STRIPE_LINKS_ENABLED=false',
    '--remove-env-vars BOT_BOOKING_ENABLED LUNA_AUTO_SEND_ENABLED WHATSAPP_LIVE_SENDS_ENABLED LUNA_GUEST_LIVE_SEND_OWNER_APPROVED WHATSAPP_CLOUD_ACCESS_TOKEN WHATSAPP_PHONE_NUMBER_ID',
  ].join(' '));
}

function summarizeApi(body) {
  const sid = body.stripe_checkout_session_id || '';
  return {
    success: body.success,
    idempotent: body.idempotent,
    payment_id: body.payment_id,
    booking_id: body.booking_id,
    booking_code: body.booking_code,
    payment_status: body.payment_status,
    amount_due_cents: body.amount_due_cents,
    checkout_url_present: !!(body.checkout_url),
    checkout_url_host: body.checkout_url ? String(body.checkout_url).split('/')[2] : null,
    stripe_checkout_session_id_present: !!sid,
    stripe_session_id_prefix: sid ? sid.slice(0, 12) + '…' : null,
    sends_whatsapp: body.sends_whatsapp,
    whatsapp_dry_run: body.whatsapp_dry_run,
    no_payment_truth_recorded: body.no_payment_truth_recorded,
    next_action: body.next_action,
  };
}

function criticalIssues(db) {
  const issues = [];
  if (db.booking_count_by_idem !== 1) issues.push('duplicate_booking');
  if (db.payment_count_for_booking !== 1) issues.push('duplicate_payment');
  const p = db.payment;
  if (p && PAID.has(String(p.status || '').toLowerCase())) issues.push('payment_paid');
  if (p && p.paid_at) issues.push('paid_at_set');
  if (p && Number(p.amount_paid_cents) > 0) issues.push('amount_paid_cents_nonzero');
  if (db.guest_message_sends_sent > 0) issues.push('whatsapp_sent');
  if (db.booking && db.booking.confirmation_sent_at) issues.push('confirmation_sent');
  return issues;
}

(async () => {
  const token = getToken();
  const botHeaders = { 'X-Luna-Bot-Token': token };
  const out = {
    phase: '20c',
    proof_start: PROOF_START,
    payment_id: PAYMENT_ID,
    booking_id: BOOKING_ID,
    booking_code: BOOKING_CODE,
    route: ROUTE,
    revision_before: null,
    env_before: null,
    health_before: null,
    db_before: null,
    step_a_create_link: null,
    step_b_replay: null,
    db_after: null,
    revision_during: null,
    env_during: null,
    revision_after: null,
    env_after: null,
    health_after: null,
    result: 'PENDING',
    stopped_early: false,
    stop_reason: null,
  };

  try {
    out.revision_before = activeRevision();
    out.env_before = stagingEnvFlags();
    out.health_before = (await req('GET', '/healthz')).status;

    const pg0 = await pgConnect();
    out.db_before = await dbProof(pg0);
    await pg0.end();

    const p0 = out.db_before.payment;
    out.db_before.checks = {
      payment_exists: p0 && p0.payment_id === PAYMENT_ID,
      status_draft: p0 && p0.status === 'draft',
      amount_due_10000: p0 && Number(p0.amount_due_cents) === 10000,
      no_checkout_url: p0 && !p0.checkout_url,
      no_session_id: p0 && !p0.stripe_checkout_session_id,
      amount_paid_zero: p0 && Number(p0.amount_paid_cents) === 0,
      one_booking: out.db_before.booking_count_by_idem === 1,
      two_beds: out.db_before.booking_beds_count === 2,
    };
    out.db_before.result = Object.values(out.db_before.checks).every(Boolean) ? 'PASS' : 'FAIL';

    if (out.db_before.result === 'FAIL') {
      out.result = 'FAIL';
      out.stopped_early = true;
      out.stop_reason = 'payment_before_invalid';
      throw new Error(out.stop_reason);
    }

    enableProofRevision();
    out.revision_during = await waitHealthy(PROOF_SUFFIX);
    out.env_during = stagingEnvFlags();
    out.health_during = (await req('GET', '/healthz')).status;

    if (out.health_during !== 200) {
      out.result = 'FAIL';
      out.stopped_early = true;
      out.stop_reason = 'healthz_not_200';
      throw new Error(out.stop_reason);
    }

    const stepA = await req('POST', ROUTE, {}, botHeaders);
    const pg1 = await pgConnect();
    const dbAfterA = await dbProof(pg1);
    await pg1.end();

    const aSum = summarizeApi(stepA.body || {});
    const pA = dbAfterA.payment;
    out.step_a_create_link = {
      http_status: stepA.status,
      summary: aSum,
      error: stepA.body && stepA.body.error,
      checks: {
        http_ok: stepA.status === 200,
        success: aSum.success === true,
        checkout_url_present: aSum.checkout_url_present === true,
        stripe_session_present: aSum.stripe_checkout_session_id_present === true,
        payment_status_checkout: aSum.payment_status === 'checkout_created' || (pA && pA.status === 'checkout_created'),
        amount_due_unchanged: pA && Number(pA.amount_due_cents) === 10000,
        amount_paid_zero: pA && Number(pA.amount_paid_cents) === 0,
        paid_at_null: !pA || !pA.paid_at,
        not_paid: pA && !PAID.has(String(pA.status).toLowerCase()),
        no_whatsapp: aSum.sends_whatsapp === false,
        no_payment_truth: aSum.no_payment_truth_recorded === true,
        single_payment: dbAfterA.payment_count_for_booking === 1,
        single_booking: dbAfterA.booking_count_by_idem === 1,
        two_beds: dbAfterA.booking_beds_count === 2,
      },
      db: {
        payment_status: pA && pA.status,
        amount_due_cents: pA && pA.amount_due_cents,
        amount_paid_cents: pA && pA.amount_paid_cents,
        has_checkout_url: !!(pA && pA.checkout_url),
        has_session_id: !!(pA && pA.stripe_checkout_session_id),
      },
    };
    out.step_a_create_link.result = Object.values(out.step_a_create_link.checks).every(Boolean)
      && criticalIssues(dbAfterA).length === 0 ? 'PASS' : 'FAIL';

    if (out.step_a_create_link.result === 'FAIL') {
      out.result = 'FAIL';
      out.stopped_early = true;
      out.stop_reason = criticalIssues(dbAfterA).join(',') || 'step_a_failed';
      throw new Error(out.stop_reason);
    }

    const sessionIdA = stepA.body && stepA.body.stripe_checkout_session_id;
    const checkoutHostA = aSum.checkout_url_host;

    const stepB = await req('POST', ROUTE, {}, botHeaders);
    const pg2 = await pgConnect();
    const dbAfterB = await dbProof(pg2);
    await pg2.end();

    const bSum = summarizeApi(stepB.body || {});
    const pB = dbAfterB.payment;
    out.step_b_replay = {
      http_status: stepB.status,
      summary: bSum,
      checks: {
        http_200: stepB.status === 200,
        success: bSum.success === true,
        idempotent: bSum.idempotent === true || stepB.body && stepB.body.message && /idempotent/i.test(stepB.body.message),
        same_payment_id: bSum.payment_id === PAYMENT_ID,
        same_session: !!(sessionIdA && bSum.stripe_session_id_prefix && String(stepB.body.stripe_checkout_session_id) === sessionIdA),
        checkout_url_present: bSum.checkout_url_present === true,
        single_payment: dbAfterB.payment_count_for_booking === 1,
        not_paid: pB && !PAID.has(String(pB.status).toLowerCase()),
        amount_paid_zero: pB && Number(pB.amount_paid_cents) === 0,
        paid_at_null: !pB || !pB.paid_at,
      },
      db: {
        payment_count: dbAfterB.payment_count_for_booking,
        booking_count: dbAfterB.booking_count_by_idem,
      },
    };
    out.step_b_replay.result = Object.values(out.step_b_replay.checks).every(Boolean)
      && criticalIssues(dbAfterB).length === 0 ? 'PASS' : 'PARTIAL';

    out.db_after = dbAfterB;
    out.safety = {
      critical_issues: criticalIssues(dbAfterB),
      guest_message_sends_sent: dbAfterB.guest_message_sends_sent,
      no_webhook_simulation: true,
    };

    if (criticalIssues(dbAfterB).length > 0) {
      out.result = 'FAIL';
      out.stop_reason = criticalIssues(dbAfterB).join(',');
    } else if (out.step_a_create_link.result === 'PASS' && out.step_b_replay.result === 'PASS') {
      out.result = 'PASS';
    } else if (out.step_a_create_link.result === 'PASS') {
      out.result = 'PARTIAL';
    } else {
      out.result = 'FAIL';
    }
  } catch (err) {
    if (out.result === 'PENDING') out.result = 'FAIL';
    out.error = err.message;
  } finally {
    try {
      revertSafeRevision();
      out.revision_after = await waitHealthy(REVERT_SUFFIX);
      out.env_after = stagingEnvFlags();
      out.health_after = (await req('GET', '/healthz')).status;
    } catch (revertErr) {
      out.revert_error = revertErr.message;
    }
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.result === 'PASS' ? 0 : 1);
  }
})();

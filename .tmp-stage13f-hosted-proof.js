'use strict';
/**
 * Phase 13f — bot create-stripe-link hosted proof (staging)
 * Temp file — do not commit.
 */
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, 'infra', '.env') });

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const IDEM = 'phase13d-booking-write-proof-001';
const PAYMENT_ID = '1c09c7a9-860f-4056-8492-b9825397abe4';
const BOOKING_ID = '9073415f-1501-4bdf-b1c8-ce5879c93662';
const BOOKING_CODE = 'MB-WOLFHO-20260920-b6f9c7';
const ROUTE = `/staff/bot/payments/${PAYMENT_ID}/create-stripe-link`;

const PAID_STATUSES = new Set(['paid', 'succeeded', 'complete', 'completed']);
const UNPAID_LINK_STATUSES = new Set(['draft', 'pending', 'checkout_created', 'payment_link_created']);

function httpsJson(method, reqPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...(headers || {}) };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({ hostname: HOST, path: reqPath, method, headers: h }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* string */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function activeRevision() {
  const rows = JSON.parse(execSync(
    'az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' },
  ));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties.template?.containers?.[0]?.image || '',
  };
}

function stagingEnvFlags() {
  const app = JSON.parse(execSync(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' },
  ));
  const env = app.properties?.template?.containers?.[0]?.env || [];
  const map = {};
  for (const e of env) map[e.name] = e.value || (e.secretRef ? `(secret:${e.secretRef})` : '');
  return {
    BOT_BOOKING_ENABLED: map.BOT_BOOKING_ENABLED,
    STRIPE_LINKS_ENABLED: map.STRIPE_LINKS_ENABLED,
    WHATSAPP_DRY_RUN: map.WHATSAPP_DRY_RUN,
  };
}

function getToken() {
  let token = process.env.LUNA_BOT_INTERNAL_TOKEN || '';
  if (!token) {
    token = execSync(
      'az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv',
      { encoding: 'utf8' },
    ).trim();
  }
  if (!token) throw new Error('LUNA_BOT_INTERNAL_TOKEN unavailable');
  return token;
}

async function dbSnapshot() {
  const url = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const pg = new Client({ connectionString: url });
  await pg.connect();
  try {
    const bookings = await pg.query(`
      SELECT b.id::text AS booking_id, b.booking_code, b.payment_status::text,
             b.amount_paid_cents, b.metadata->>'idempotency_key' AS idempotency_key
      FROM bookings b
      INNER JOIN clients cl ON cl.id = b.client_id
      WHERE cl.slug = $1 AND b.metadata->>'idempotency_key' = $2
    `, [CLIENT, IDEM]);

    const pays = await pg.query(`
      SELECT p.id::text AS payment_id, p.status::text, p.payment_kind::text,
             p.amount_due_cents, p.checkout_url, p.stripe_checkout_session_id,
             p.paid_at, p.booking_id::text
      FROM payments p
      WHERE p.id = $1::uuid
    `, [PAYMENT_ID]);

    const payByBooking = await pg.query(`
      SELECT COUNT(*)::int AS c FROM payments p
      WHERE p.booking_id = $1::uuid
    `, [BOOKING_ID]);

    return {
      booking_count: bookings.rows.length,
      payment_count_for_booking: payByBooking.rows[0]?.c || 0,
      booking: bookings.rows[0] || null,
      payment: pays.rows[0] || null,
    };
  } finally {
    await pg.end();
  }
}

function paymentSummary(p) {
  if (!p) return null;
  return {
    payment_id: p.payment_id,
    status: p.status,
    payment_kind: p.payment_kind,
    amount_due_cents: p.amount_due_cents,
    has_checkout_url: !!(p.checkout_url),
    has_stripe_session: !!(p.stripe_checkout_session_id),
    paid_at: p.paid_at,
  };
}

function summarizeApi(body) {
  return {
    success: body.success,
    idempotent: body.idempotent,
    checkout_url: body.checkout_url ? '(present)' : null,
    stripe_checkout_session_id: body.stripe_checkout_session_id || null,
    payment_status: body.payment_status,
    sends_whatsapp: body.sends_whatsapp,
    no_n8n: body.no_n8n,
    no_payment_truth_recorded: body.no_payment_truth_recorded,
    booking_id: body.booking_id,
    payment_id: body.payment_id,
  };
}

function criticalStop(snap) {
  const issues = [];
  if (snap.booking_count !== 1) issues.push('booking_count_not_1');
  if (snap.payment_count_for_booking !== 1) issues.push('duplicate_payment');
  const p = snap.payment;
  if (p && PAID_STATUSES.has(String(p.status || '').toLowerCase())) issues.push('payment_paid');
  if (p && p.paid_at) issues.push('paid_at_set');
  return issues;
}

(async () => {
  const token = getToken();
  const out = {
    phase: '13f',
    revision: activeRevision(),
    env: stagingEnvFlags(),
    healthz: null,
    local_verifiers: {},
    db_before: null,
    stripe_link: null,
    db_after_link: null,
    retry: null,
    db_after_retry: null,
    result: 'PENDING',
    stopped_early: false,
    stop_reason: null,
  };

  out.healthz = await httpsJson('GET', '/healthz');
  out.revision = activeRevision();

  const verifiers = [
    'verify:luna-agent-phase13-booking-write-bridge',
    'verify:luna-agent-phase13-write-eligibility-route',
    'verify:luna-agent-phase13-write-eligibility',
    'verify:luna-agent-phase13-write-gates-plan',
    'verify:luna-agent-phase12-closeout',
    'verify:staff-ask-luna-phase11-closeout',
  ];
  for (const v of verifiers) {
    try {
      const txt = execSync(`npm run ${v}`, { cwd: path.join(__dirname), encoding: 'utf8', stdio: 'pipe' });
      const m = txt.match(/(\d+) passed,\s*(\d+) failed/);
      out.local_verifiers[v] = m ? { passed: Number(m[1]), failed: Number(m[2]), ok: Number(m[2]) === 0 } : { ok: true };
    } catch (e) {
      out.local_verifiers[v] = { ok: false, error: (e.stderr || e.stdout || '').slice(-200) };
    }
  }

  out.db_before = await dbSnapshot();
  out.db_before.payment_summary = paymentSummary(out.db_before.payment);
  out.db_before.booking_summary = out.db_before.booking;

  const pBefore = out.db_before.payment;
  const beforeOk = out.db_before.booking_count === 1
    && out.db_before.payment_count_for_booking === 1
    && pBefore
    && pBefore.payment_id === PAYMENT_ID
    && (pBefore.status === 'draft' || (pBefore.status === 'checkout_created' && pBefore.checkout_url))
    && pBefore.payment_kind === 'deposit_only'
    && Number(pBefore.amount_due_cents) === 10000;

  if (!beforeOk || out.env.STRIPE_LINKS_ENABLED !== 'true') {
    out.result = 'FAIL';
    out.stopped_early = true;
    out.stop_reason = !beforeOk ? 'payment_before_invalid' : 'stripe_links_disabled';
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  const linkRes = await httpsJson('POST', ROUTE, {}, { 'X-Luna-Bot-Token': token });
  out.db_after_link = await dbSnapshot();
  out.db_after_link.payment_summary = paymentSummary(out.db_after_link.payment);

  const apiSum = summarizeApi(linkRes.body || {});
  const pAfter = out.db_after_link.payment;
  const linkCrit = criticalStop(out.db_after_link);

  out.stripe_link = {
    http_status: linkRes.status,
    summary: apiSum,
    checks: {
      http_ok: linkRes.status === 200 || linkRes.status === 201,
      success_true: apiSum.success === true,
      checkout_url: !!(linkRes.body && linkRes.body.checkout_url),
      stripe_session: !!(linkRes.body && linkRes.body.stripe_checkout_session_id),
      payment_not_paid: pAfter && !PAID_STATUSES.has(String(pAfter.status).toLowerCase()),
      payment_unpaid_link_state: pAfter && UNPAID_LINK_STATUSES.has(String(pAfter.status).toLowerCase()),
      paid_at_null: !pAfter || !pAfter.paid_at,
      db_checkout_url: pAfter && !!pAfter.checkout_url,
      db_stripe_session: pAfter && !!pAfter.stripe_checkout_session_id,
      no_whatsapp: apiSum.sends_whatsapp === false,
      no_n8n: apiSum.no_n8n === true,
      single_payment: out.db_after_link.payment_count_for_booking === 1,
      single_booking: out.db_after_link.booking_count === 1,
    },
  };
  out.stripe_link.result = Object.values(out.stripe_link.checks).every((x) => x === true) && linkCrit.length === 0
    ? 'PASS' : 'FAIL';

  if (out.stripe_link.result === 'FAIL' || linkCrit.length > 0) {
    out.result = 'FAIL';
    out.stopped_early = true;
    out.stop_reason = linkCrit.join(',') || 'stripe_link_failed';
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  const retryRes = await httpsJson('POST', ROUTE, {}, { 'X-Luna-Bot-Token': token });
  out.db_after_retry = await dbSnapshot();
  out.db_after_retry.payment_summary = paymentSummary(out.db_after_retry.payment);
  const retryCrit = criticalStop(out.db_after_retry);

  out.retry = {
    http_status: retryRes.status,
    summary: summarizeApi(retryRes.body || {}),
    checks: {
      success_true: retryRes.body && retryRes.body.success === true,
      idempotent_or_same_url: !!(retryRes.body && (retryRes.body.idempotent === true || retryRes.body.checkout_url)),
      payment_not_paid: out.db_after_retry.payment && !PAID_STATUSES.has(String(out.db_after_retry.payment.status).toLowerCase()),
      single_payment: out.db_after_retry.payment_count_for_booking === 1,
      paid_at_null: !out.db_after_retry.payment || !out.db_after_retry.payment.paid_at,
    },
  };
  out.retry.result = Object.values(out.retry.checks).every((x) => x === true) && retryCrit.length === 0
    ? 'PASS' : 'PARTIAL';

  const verOk = Object.values(out.local_verifiers).every((v) => v.ok !== false);
  const revOk = out.revision.health === 'Healthy' && out.revision.traffic === 100;

  if (out.stripe_link.result === 'PASS' && out.retry.result === 'PASS' && verOk && revOk) {
    out.result = 'PASS';
  } else if (out.stripe_link.result === 'PASS') {
    out.result = 'PARTIAL';
  } else {
    out.result = 'FAIL';
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'FAIL' ? 1 : 0);
})().catch((e) => {
  console.error('PROOF_ERROR:', e.message);
  process.exit(1);
});

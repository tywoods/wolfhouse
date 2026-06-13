'use strict';
/**
 * Phase 13d — booking-create-from-plan controlled write proof (staging)
 * Temp file — do not commit.
 */
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, 'infra', '.env') });

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const ELIG_ROUTE = '/staff/bot/booking-write-eligibility';
const WRITE_ROUTE = '/staff/bot/booking-create-from-plan';
const EXPECTED_BEDS = ['DEMO-R1-B2', 'DEMO-R2-B1'];

const PAYLOAD = {
  client_slug: 'wolfhouse-somo',
  channel: 'whatsapp',
  from: '+15555550142',
  guest_name: 'Phase Thirteen Write Proof',
  language: 'en',
  message_text: 'Hi, I want to stay September 20 to September 23 for 2 people. I want to pay the deposit.',
  check_in: '2026-09-20',
  check_out: '2026-09-23',
  guests: 2,
  package_code: 'malibu',
  payment_choice: 'deposit',
  confirm: true,
  idempotency_key: 'phase13d-booking-write-proof-001',
};

const META = {
  guest_name: PAYLOAD.guest_name,
  from: PAYLOAD.from,
  idempotency_key: PAYLOAD.idempotency_key,
};

const PAID_STATUSES = new Set(['paid', 'succeeded', 'complete', 'completed']);

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
    const idem = META.idempotency_key;
    const bookings = await pg.query(`
      SELECT b.id::text AS booking_id, b.booking_code, b.guest_name, b.phone,
             b.check_in::text, b.check_out::text, b.guest_count,
             b.total_amount_cents, b.deposit_required_cents,
             b.metadata->>'idempotency_key' AS idempotency_key,
             (b.metadata ? 'quote_snapshot') AS has_quote_snapshot,
             b.created_at
      FROM bookings b
      INNER JOIN clients cl ON cl.id = b.client_id
      WHERE cl.slug = $1
        AND (b.guest_name = $2 OR b.metadata->>'idempotency_key' = $3 OR b.phone = $4)
      ORDER BY b.created_at DESC
    `, [CLIENT, META.guest_name, idem, META.from]);

    const bookingIds = bookings.rows.map((r) => r.booking_id);
    let beds = { rows: [] };
    let pays = { rows: [] };
    if (bookingIds.length > 0) {
      beds = await pg.query(`
        SELECT bb.bed_code, bb.assignment_start_date::text AS check_in,
               bb.assignment_end_date::text AS check_out
        FROM booking_beds bb
        WHERE bb.booking_id = ANY($1::uuid[])
        ORDER BY bb.bed_code
      `, [bookingIds]);
      pays = await pg.query(`
        SELECT p.id::text AS payment_id, p.status::text, p.payment_kind::text,
               p.amount_due_cents, p.checkout_url, p.stripe_checkout_session_id,
               p.created_at
        FROM payments p
        WHERE p.booking_id = ANY($1::uuid[])
        ORDER BY p.created_at
      `, [bookingIds]);
    }

    return {
      booking_count: bookings.rows.length,
      payment_count: pays.rows.length,
      bookings: bookings.rows,
      beds: beds.rows,
      payments: pays.rows,
    };
  } finally {
    await pg.end();
  }
}

function summarizeBridge(body) {
  const cr = body.create_outcome && body.create_outcome.create_response;
  return {
    success: body.success,
    write_performed: body.write_performed,
    creates_stripe_link: body.creates_stripe_link,
    sends_whatsapp: body.sends_whatsapp,
    calls_n8n: body.calls_n8n,
    blocked_reasons: body.blocked_reasons,
    booking_id: cr && cr.booking_id,
    booking_code: cr && cr.booking_code,
    payment_id: cr && cr.payment_id,
    payment_status: cr && cr.payment_status,
    created: cr && cr.created,
    duplicate: cr && cr.duplicate,
    idempotent: cr && cr.idempotent,
    next_action: cr && cr.next_action,
    selected_bed_codes: cr && cr.selected_bed_codes,
  };
}

function criticalFromWrite(summary, snap) {
  const issues = [];
  if (snap.booking_count > 1) issues.push('more_than_one_booking');
  for (const p of snap.payments) {
    const st = String(p.status || '').toLowerCase();
    if (PAID_STATUSES.has(st)) issues.push('payment_marked_paid');
    if (p.checkout_url || p.stripe_checkout_session_id) issues.push('stripe_link_created');
  }
  if (summary.creates_stripe_link === true) issues.push('response_stripe_flag');
  if (summary.sends_whatsapp === true) issues.push('whatsapp_sent');
  if (summary.calls_n8n === true) issues.push('n8n_called');
  return issues;
}

(async () => {
  const token = getToken();
  const out = {
    phase: '13d',
    revision: activeRevision(),
    env: stagingEnvFlags(),
    healthz: null,
    local_verifiers: {},
    eligibility_precheck: null,
    db_before: null,
    write: null,
    db_after_write: null,
    idempotency_retry: null,
    db_after_retry: null,
    result: 'PENDING',
    stopped_early: false,
    stop_reason: null,
  };

  out.healthz = await httpsJson('GET', '/healthz');
  out.revision = activeRevision();

  const verifiers = [
    'verify:luna-agent-phase13-write-eligibility-route',
    'verify:luna-agent-phase13-booking-write-bridge',
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
      out.local_verifiers[v] = { ok: false, error: (e.stderr || e.stdout || '').slice(-300) };
    }
  }

  // Eligibility pre-check
  const eligRes = await httpsJson('POST', ELIG_ROUTE, PAYLOAD, { 'X-Luna-Bot-Token': token });
  const elig = eligRes.body || {};
  out.eligibility_precheck = {
    http_status: eligRes.status,
    write_ready: elig.write_ready,
    write_performed: elig.write_performed,
    would_call: elig.would_call,
    success: elig.success,
  };
  const eligDb = await dbSnapshot();
  if (eligRes.status !== 200 || elig.write_ready !== true
      || elig.write_performed !== false || eligDb.booking_count > 0) {
    out.result = 'FAIL';
    out.stopped_early = true;
    out.stop_reason = 'eligibility_precheck_failed';
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  out.db_before = await dbSnapshot();
  if (out.db_before.booking_count !== 0 || out.db_before.payment_count !== 0) {
    out.result = 'FAIL';
    out.stopped_early = true;
    out.stop_reason = 'db_before_not_zero';
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  // Write
  const writeRes = await httpsJson('POST', WRITE_ROUTE, PAYLOAD, { 'X-Luna-Bot-Token': token });
  const writeSum = summarizeBridge(writeRes.body || {});
  out.db_after_write = await dbSnapshot();
  out.write = {
    http_status: writeRes.status,
    summary: writeSum,
    db: {
      booking_count: out.db_after_write.booking_count,
      payment_count: out.db_after_write.payment_count,
    },
  };

  const crit = criticalFromWrite(writeSum, out.db_after_write);
  const writeOk = (writeRes.status === 200 || writeRes.status === 201)
    && writeSum.success === true
    && writeSum.write_performed === true
    && out.db_after_write.booking_count === 1
    && out.db_after_write.payment_count >= 1
    && crit.length === 0;

  if (!writeOk || crit.length > 0) {
    out.result = 'FAIL';
    out.stopped_early = true;
    out.stop_reason = crit.length ? crit.join(',') : 'write_checks_failed';
    out.write.critical = crit;
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  const bedCodes = out.db_after_write.beds.map((b) => b.bed_code).sort();
  const pay = out.db_after_write.payments[0] || {};
  out.write.booking_detail = out.db_after_write.bookings[0];
  out.write.payment_detail = {
    payment_id: pay.payment_id,
    status: pay.status,
    payment_kind: pay.payment_kind,
    amount_due_cents: pay.amount_due_cents,
    has_checkout_url: !!pay.checkout_url,
    has_stripe_session: !!pay.stripe_checkout_session_id,
  };
  out.write.beds = out.db_after_write.beds;
  out.write.beds_match_expected = EXPECTED_BEDS.every((b) => bedCodes.includes(b));
  out.write.has_quote_snapshot = out.db_after_write.bookings[0]?.has_quote_snapshot === true;

  // Idempotency retry
  const retryRes = await httpsJson('POST', WRITE_ROUTE, PAYLOAD, { 'X-Luna-Bot-Token': token });
  const retrySum = summarizeBridge(retryRes.body || {});
  out.db_after_retry = await dbSnapshot();
  out.idempotency_retry = {
    http_status: retryRes.status,
    summary: retrySum,
    db_booking_count: out.db_after_retry.booking_count,
    db_payment_count: out.db_after_retry.payment_count,
  };

  const idemOk = out.db_after_retry.booking_count === 1
    && out.db_after_retry.payment_count === out.db_after_write.payment_count
    && (retrySum.duplicate === true || retrySum.idempotent === true || retrySum.write_performed === true);

  if (!idemOk || out.db_after_retry.booking_count > 1) {
    out.result = 'FAIL';
    out.stopped_early = true;
    out.stop_reason = 'idempotency_duplicate_created';
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  const revOk = out.revision.health === 'Healthy' && out.revision.traffic === 100;
  const healthOk = out.healthz.status === 200;
  const verOk = Object.values(out.local_verifiers).every((v) => v.ok !== false);
  const bedsOk = out.write.beds_match_expected;
  const draftOk = pay.status && !PAID_STATUSES.has(String(pay.status).toLowerCase());

  if (writeOk && idemOk && revOk && healthOk && verOk && bedsOk && draftOk) {
    out.result = 'PASS';
  } else {
    out.result = 'PARTIAL';
  }

  out.cleanup = {
    booking_code: out.db_after_write.bookings[0]?.booking_code,
    booking_id: out.db_after_write.bookings[0]?.booking_id,
    note: 'Cancel or delete test booking via staff UI or bot cancel path if staging cleanup needed',
    guest_name: META.guest_name,
    idempotency_key: META.idempotency_key,
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'FAIL' ? 1 : 0);
})().catch((e) => {
  console.error('PROOF_ERROR:', e.message);
  process.exit(1);
});

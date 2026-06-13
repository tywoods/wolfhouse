'use strict';
/**
 * Phase 13e.1 — idempotent booking replay hosted proof (staging)
 * Temp file — do not commit.
 */
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, 'infra', '.env') });

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = 'd2d891e';
const IMAGE_TAG = 'd2d891e-stage13e-idempotent-replay';
const ROUTE = '/staff/bot/booking-create-from-plan';
const CLIENT = 'wolfhouse-somo';
const IDEM = 'phase13d-booking-write-proof-001';

const EXPECT = {
  booking_id: '9073415f-1501-4bdf-b1c8-ce5879c93662',
  booking_code: 'MB-WOLFHO-20260920-b6f9c7',
  payment_id: '1c09c7a9-860f-4056-8492-b9825397abe4',
  guest_name: 'Phase Thirteen Write Proof',
  phone: '+15555550142',
};

const REPLAY_PAYLOAD = {
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
  idempotency_key: IDEM,
};

const CONFLICT_PAYLOAD = {
  client_slug: 'wolfhouse-somo',
  channel: 'whatsapp',
  from: '+15555559999',
  guest_name: 'Phase Thirteen Write Proof',
  language: 'en',
  message_text: 'Retry with wrong phone',
  check_in: '2026-09-20',
  check_out: '2026-09-23',
  guests: 2,
  package_code: 'malibu',
  payment_choice: 'deposit',
  confirm: true,
  idempotency_key: IDEM,
};

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
      SELECT b.id::text AS booking_id, b.booking_code, b.guest_name, b.phone,
             b.check_in::text, b.check_out::text,
             b.metadata->>'idempotency_key' AS idempotency_key,
             b.created_at
      FROM bookings b
      INNER JOIN clients cl ON cl.id = b.client_id
      WHERE cl.slug = $1 AND b.metadata->>'idempotency_key' = $2
      ORDER BY b.created_at DESC
    `, [CLIENT, IDEM]);

    const bookingIds = bookings.rows.map((r) => r.booking_id);
    let pays = { rows: [] };
    if (bookingIds.length > 0) {
      pays = await pg.query(`
        SELECT p.id::text AS payment_id, p.status::text, p.payment_kind::text,
               p.amount_due_cents, p.checkout_url, p.stripe_checkout_session_id,
               p.booking_id::text, p.created_at
        FROM payments p
        WHERE p.booking_id = ANY($1::uuid[])
        ORDER BY p.created_at
      `, [bookingIds]);
    }
    return {
      booking_count: bookings.rows.length,
      payment_count: pays.rows.length,
      bookings: bookings.rows,
      payments: pays.rows,
    };
  } finally {
    await pg.end();
  }
}

function summarize(body) {
  const ps = body.payment_summary || {};
  return {
    success: body.success,
    write_performed: body.write_performed,
    idempotent_replay: body.idempotent_replay,
    duplicate: body.duplicate,
    idempotent: body.idempotent,
    booking_id: body.booking_id,
    booking_code: body.booking_code,
    payment_id: body.payment_id,
    payment_summary: ps.status ? {
      status: ps.status,
      has_checkout_url: ps.has_checkout_url,
      payment_kind: ps.payment_kind,
    } : null,
    blocked_reasons: body.blocked_reasons || [],
    existing_booking_id: body.existing_booking_id,
    existing_booking_code: body.existing_booking_code,
    creates_stripe_link: body.creates_stripe_link,
    sends_whatsapp: body.sends_whatsapp,
    calls_n8n: body.calls_n8n,
    creates_booking: body.creates_booking,
    creates_payment: body.creates_payment,
    would_call: body.would_call,
    safe_next_step: body.safe_next_step,
  };
}

const PAID = new Set(['paid', 'succeeded', 'complete', 'completed']);

function criticalFromDb(snap) {
  const issues = [];
  if (snap.booking_count > 1) issues.push('duplicate_booking');
  for (const p of snap.payments) {
    if (PAID.has(String(p.status || '').toLowerCase())) issues.push('payment_paid');
    if (p.checkout_url || p.stripe_checkout_session_id) issues.push('stripe_link');
  }
  return issues;
}

(async () => {
  const token = getToken();
  const out = {
    phase: '13e.1',
    commit: COMMIT,
    revision: activeRevision(),
    env: stagingEnvFlags(),
    healthz: null,
    deploy_needed: false,
    deploy_performed: false,
    local_verifiers: {},
    db_before: null,
    replay: null,
    conflict: null,
    db_after: null,
    result: 'PENDING',
    stopped_early: false,
    stop_reason: null,
  };

  out.healthz = await httpsJson('GET', '/healthz');
  out.revision = activeRevision();

  const imageOk = out.revision.image.includes(IMAGE_TAG) || out.revision.image.includes(COMMIT);
  const probe = await httpsJson('POST', ROUTE, REPLAY_PAYLOAD, { 'X-Luna-Bot-Token': token });
  const needsDeploy = !imageOk || !(probe.body && probe.body.idempotent_replay === true);

  if (needsDeploy) {
    out.deploy_needed = true;
    console.log('DEPLOY: staging needs d2d891e idempotent replay...');
    execSync(
      `az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`,
      { cwd: path.join(__dirname), encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 },
    );
    execSync(
      `az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --image whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG} --revision-suffix stage13e-idempotent-replay`,
      { encoding: 'utf8', maxBuffer: 15 * 1024 * 1024 },
    );
    out.deploy_performed = true;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 10000));
      out.revision = activeRevision();
      if (out.revision.health === 'Healthy' && out.revision.traffic === 100
          && (out.revision.image.includes(IMAGE_TAG) || out.revision.image.includes(COMMIT))) {
        break;
      }
    }
  }

  out.revision = activeRevision();
  out.env = stagingEnvFlags();
  out.healthz = await httpsJson('GET', '/healthz');

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
  const beforeIdsOk = out.db_before.booking_count === 1
    && out.db_before.bookings[0]?.booking_id === EXPECT.booking_id
    && out.db_before.bookings[0]?.booking_code === EXPECT.booking_code
    && out.db_before.payment_count === 1
    && out.db_before.payments[0]?.payment_id === EXPECT.payment_id;

  if (!beforeIdsOk) {
    out.result = 'FAIL';
    out.stopped_early = true;
    out.stop_reason = 'db_before_mismatch_phase13d';
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  const replayRes = await httpsJson('POST', ROUTE, REPLAY_PAYLOAD, { 'X-Luna-Bot-Token': token });
  const replaySum = summarize(replayRes.body || {});
  const dbAfterReplay = await dbSnapshot();
  const replayCrit = criticalFromDb(dbAfterReplay);

  out.replay = {
    http_status: replayRes.status,
    summary: replaySum,
    db_after: { bookings: dbAfterReplay.booking_count, payments: dbAfterReplay.payment_count },
    checks: {
      http_200: replayRes.status === 200,
      success_true: replaySum.success === true,
      idempotent_replay: replaySum.idempotent_replay === true,
      duplicate: replaySum.duplicate === true,
      write_performed_false: replaySum.write_performed === false,
      booking_id_match: replaySum.booking_id === EXPECT.booking_id,
      booking_code_match: replaySum.booking_code === EXPECT.booking_code,
      payment_draft: replaySum.payment_summary && replaySum.payment_summary.status === 'draft',
      no_checkout_url: replaySum.payment_summary && replaySum.payment_summary.has_checkout_url === false,
      safety_flags: replaySum.creates_stripe_link === false && replaySum.sends_whatsapp === false
        && replaySum.calls_n8n === false && replaySum.creates_booking === false,
      would_call_empty: !replaySum.would_call || replaySum.would_call.length === 0,
      safe_next_step: replaySum.safe_next_step === 'booking_already_created',
      db_unchanged: dbAfterReplay.booking_count === 1 && dbAfterReplay.payment_count === 1,
    },
  };
  out.replay.result = Object.values(out.replay.checks).every((x) => x === true) && replayCrit.length === 0
    ? 'PASS' : 'FAIL';

  if (out.replay.result === 'FAIL' || replayCrit.length > 0
      || dbAfterReplay.booking_count > out.db_before.booking_count) {
    out.result = 'FAIL';
    out.stopped_early = true;
    out.stop_reason = replayCrit.join(',') || 'replay_failed';
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  const conflictRes = await httpsJson('POST', ROUTE, CONFLICT_PAYLOAD, { 'X-Luna-Bot-Token': token });
  const conflictSum = summarize(conflictRes.body || {});
  out.db_after = await dbSnapshot();
  const afterCrit = criticalFromDb(out.db_after);

  out.conflict = {
    http_status: conflictRes.status,
    summary: conflictSum,
    checks: {
      success_false: conflictSum.success === false,
      write_performed_false: conflictSum.write_performed === false,
      phone_mismatch: (conflictSum.blocked_reasons || []).includes('idempotency_phone_mismatch'),
      existing_visible: conflictSum.existing_booking_id === EXPECT.booking_id
        || conflictSum.booking_id === EXPECT.booking_id,
      db_unchanged: out.db_after.booking_count === 1 && out.db_after.payment_count === 1,
      no_stripe: afterCrit.length === 0,
    },
  };
  out.conflict.result = Object.values(out.conflict.checks).every((x) => x === true) ? 'PASS' : 'PARTIAL';

  const verOk = Object.values(out.local_verifiers).every((v) => v.ok !== false);
  const revOk = out.revision.health === 'Healthy' && out.revision.traffic === 100;
  const healthOk = out.healthz.status === 200;

  if (out.replay.result === 'PASS' && out.conflict.result === 'PASS' && verOk && revOk && healthOk) {
    out.result = 'PASS';
  } else if (out.replay.result === 'PASS') {
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

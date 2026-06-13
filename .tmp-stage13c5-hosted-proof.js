'use strict';
/**
 * Phase 13c.5 — booking-write-eligibility hosted proof (staging only)
 * Temp file — do not commit.
 */
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, 'infra', '.env') });

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = 'e0c190e';
const IMAGE_TAG = 'e0c190e-stage13c5-write-eligibility';
const ROUTE = '/staff/bot/booking-write-eligibility';
const AVAIL_ROUTE = '/staff/bot/availability-check';
const CLIENT = 'wolfhouse-somo';

const BLOCKED_PAYLOAD = {
  client_slug: 'wolfhouse-somo',
  channel: 'whatsapp',
  from: '+15555550141',
  guest_name: 'Eligibility Blocked Proof',
  language: 'en',
  message_text: 'Hi, I want to stay June 15 to June 22 for 2 people. I want to pay the deposit.',
  check_in: '2026-06-15',
  check_out: '2026-06-22',
  guests: 2,
  package_code: 'malibu',
  payment_choice: 'deposit',
  confirm: true,
  idempotency_key: 'phase13c5-eligibility-blocked-001',
};

const DATE_CANDIDATES = [
  { check_in: '2026-09-20', check_out: '2026-09-23' },
  { check_in: '2026-09-24', check_out: '2026-09-27' },
  { check_in: '2026-09-25', check_out: '2026-09-28' },
  { check_in: '2026-10-01', check_out: '2026-10-08' },
  { check_in: '2026-10-15', check_out: '2026-10-22' },
  { check_in: '2026-11-01', check_out: '2026-11-08' },
];

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
        resolve({ status: res.statusCode, body: parsed, raw });
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

async function dbCount(meta) {
  const url = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const pg = new Client({ connectionString: url });
  await pg.connect();
  try {
    const idem = meta.idempotency_key || '__none__';
    const bookings = await pg.query(`
      SELECT b.id::text, b.booking_code, b.guest_name, b.created_at
      FROM bookings b
      INNER JOIN clients cl ON cl.id = b.client_id
      WHERE cl.slug = $1
        AND (b.guest_name = $2 OR b.metadata->>'idempotency_key' = $3 OR b.phone = $4)
      ORDER BY b.created_at DESC LIMIT 10
    `, [CLIENT, meta.guest_name, idem, meta.from]);
    const pays = await pg.query(`
      SELECT p.id::text, p.status::text, p.created_at
      FROM payments p
      INNER JOIN bookings b ON b.id = p.booking_id
      INNER JOIN clients cl ON cl.id = b.client_id
      WHERE cl.slug = $1
        AND (b.guest_name = $2 OR b.metadata->>'idempotency_key' = $3 OR b.phone = $4)
      ORDER BY p.created_at DESC LIMIT 10
    `, [CLIENT, meta.guest_name, idem, meta.from]);
    return { bookings: bookings.rows.length, payments: pays.rows.length };
  } finally {
    await pg.end();
  }
}

function pickList(body, key) {
  const elig = body.eligibility || {};
  return [...new Set([...(body[key] || []), ...(elig[key] || [])])];
}

function summarizeResponse(body) {
  return {
    success: body.success,
    write_performed: body.write_performed,
    no_write_performed: body.no_write_performed,
    write_ready: body.write_ready,
    blocked_reasons: pickList(body, 'blocked_reasons'),
    required_approvals: pickList(body, 'required_approvals'),
    would_call: body.would_call || (body.eligibility && body.eligibility.would_call) || [],
    safe_next_step: body.safe_next_step || (body.eligibility && body.eligibility.safe_next_step),
    creates_booking: body.creates_booking,
    creates_payment: body.creates_payment,
    creates_stripe_link: body.creates_stripe_link,
    sends_whatsapp: body.sends_whatsapp,
    calls_n8n: body.calls_n8n,
  };
}

async function findAvailableDates(token) {
  for (const d of DATE_CANDIDATES) {
    const res = await httpsJson('POST', AVAIL_ROUTE, {
      client_slug: CLIENT,
      check_in: d.check_in,
      check_out: d.check_out,
      guest_count: 2,
      room_type: 'shared',
    }, { 'X-Luna-Bot-Token': token });
    const b = res.body || {};
    if (res.status === 200 && b.has_enough_beds === true
        && Array.isArray(b.selected_bed_codes) && b.selected_bed_codes.length >= 2) {
      return { ...d, availability: b };
    }
  }
  return null;
}

(async () => {
  const token = getToken();
  const out = {
    phase: '13c.5',
    commit: COMMIT,
    revision: activeRevision(),
    env: stagingEnvFlags(),
    healthz: null,
    route: `POST https://${HOST}${ROUTE}`,
    deploy_needed: false,
    deploy_performed: false,
    local_verifiers: {},
    proof_a: null,
    proof_b: null,
    result: 'PENDING',
  };

  out.healthz = await httpsJson('GET', '/healthz');
  out.revision = activeRevision();

  const imageOk = out.revision.image.includes(IMAGE_TAG) || out.revision.image.includes(COMMIT);
  const routeProbe = await httpsJson('POST', ROUTE, BLOCKED_PAYLOAD, { 'X-Luna-Bot-Token': token });
  const routeMissing = routeProbe.status === 404 || routeProbe.status === 405;
  out.deploy_needed = routeMissing || !imageOk;

  if (out.deploy_needed) {
    console.log('DEPLOY: staging needs e0c190e write-eligibility route...');
    execSync(
      `az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`,
      { encoding: 'utf8', cwd: path.join(__dirname), maxBuffer: 30 * 1024 * 1024 },
    );
    execSync(
      `az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --image whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG} --revision-suffix stage13c5-write-eligibility`,
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
      out.local_verifiers[v] = { ok: false, error: (e.stderr || e.stdout || e.message).slice(-200) };
    }
  }

  // Proof A — blocked
  const metaA = {
    guest_name: BLOCKED_PAYLOAD.guest_name,
    from: BLOCKED_PAYLOAD.from,
    idempotency_key: BLOCKED_PAYLOAD.idempotency_key,
  };
  const dbBeforeA = await dbCount(metaA);
  const resA = await httpsJson('POST', ROUTE, BLOCKED_PAYLOAD, { 'X-Luna-Bot-Token': token });
  const dbAfterA = await dbCount(metaA);
  const sumA = summarizeResponse(resA.body || {});
  const blockedA = sumA.blocked_reasons || [];
  out.proof_a = {
    http_status: resA.status,
    summary: sumA,
    db_before: dbBeforeA,
    db_after: dbAfterA,
    checks: {
      http_200: resA.status === 200,
      success_true: sumA.success === true,
      write_performed_false: sumA.write_performed === false,
      no_write_performed_true: sumA.no_write_performed === true,
      write_ready_false: sumA.write_ready === false,
      availability_blocked: blockedA.includes('availability_insufficient_beds')
        || blockedA.includes('availability_selected_beds_missing'),
      would_call_empty: !sumA.would_call || sumA.would_call.length === 0,
      safety_flags_false: sumA.creates_stripe_link === false && sumA.sends_whatsapp === false
        && sumA.calls_n8n === false && sumA.creates_booking === false && sumA.creates_payment === false,
      db_unchanged: dbBeforeA.bookings === dbAfterA.bookings && dbBeforeA.payments === dbAfterA.payments,
    },
  };
  out.proof_a.result = Object.values(out.proof_a.checks).every((x) => x === true) ? 'PASS' : 'FAIL';
  if (out.proof_a.result === 'FAIL' || dbAfterA.bookings > dbBeforeA.bookings || dbAfterA.payments > dbBeforeA.payments) {
    out.result = 'FAIL';
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  // Proof B — near-eligible date probe
  const avail = await findAvailableDates(token);
  if (!avail) {
    out.proof_b = { skipped: true, reason: 'no staging date window with 2+ beds found via availability-check' };
    out.result = out.proof_a.result === 'PASS' ? 'PARTIAL' : 'FAIL';
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  const nearPayload = {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550142',
    guest_name: 'Eligibility Write Ready Proof',
    language: 'en',
    message_text: `Hi, I want to stay ${avail.check_in} to ${avail.check_out} for 2 people. I want to pay the deposit.`,
    check_in: avail.check_in,
    check_out: avail.check_out,
    guests: 2,
    package_code: 'malibu',
    payment_choice: 'deposit',
    confirm: true,
    idempotency_key: 'phase13c5-eligibility-ready-001',
  };
  const metaB = {
    guest_name: nearPayload.guest_name,
    from: nearPayload.from,
    idempotency_key: nearPayload.idempotency_key,
  };
  const dbBeforeB = await dbCount(metaB);
  const resB = await httpsJson('POST', ROUTE, nearPayload, { 'X-Luna-Bot-Token': token });
  const dbAfterB = await dbCount(metaB);
  const sumB = summarizeResponse(resB.body || {});
  out.proof_b = {
    dates_used: { check_in: avail.check_in, check_out: avail.check_out },
    availability_probe: {
      has_enough_beds: avail.availability.has_enough_beds,
      selected_bed_codes: avail.availability.selected_bed_codes,
    },
    http_status: resB.status,
    summary: sumB,
    db_before: dbBeforeB,
    db_after: dbAfterB,
    checks: {
      http_200: resB.status === 200,
      success_true: sumB.success === true,
      write_performed_false: sumB.write_performed === false,
      no_write_performed_true: sumB.no_write_performed === true,
      write_ready_true: sumB.write_ready === true,
      would_call_create: Array.isArray(sumB.would_call)
        && sumB.would_call.length === 1
        && sumB.would_call[0] === 'POST /staff/bot/bookings/create',
      safe_next_step: sumB.safe_next_step === 'booking_create_gated',
      safety_flags_false: sumB.creates_stripe_link === false && sumB.sends_whatsapp === false
        && sumB.calls_n8n === false && sumB.creates_booking === false && sumB.creates_payment === false,
      db_unchanged: dbBeforeB.bookings === dbAfterB.bookings && dbBeforeB.payments === dbAfterB.payments,
    },
  };
  out.proof_b.result = Object.values(out.proof_b.checks).every((x) => x === true) ? 'PASS' : 'FAIL';

  const verifiersOk = Object.values(out.local_verifiers).every((v) => v.ok !== false);
  const revOk = out.revision.health === 'Healthy' && out.revision.traffic === 100;
  const healthOk = out.healthz.status === 200;

  if (out.proof_b.result === 'FAIL' || dbAfterB.bookings > dbBeforeB.bookings) {
    out.result = 'FAIL';
  } else if (out.proof_a.result === 'PASS' && out.proof_b.result === 'PASS' && verifiersOk && revOk && healthOk) {
    out.result = 'PASS';
  } else {
    out.result = 'PARTIAL';
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'FAIL' ? 1 : 0);
})().catch((e) => {
  console.error('PROOF_ERROR:', e.message);
  process.exit(1);
});

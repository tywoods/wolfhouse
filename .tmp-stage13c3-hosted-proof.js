'use strict';
/**
 * Phase 13c.3 — booking-create-from-plan deny-matrix hosted proof (staging only)
 * Does not print secrets. Temp file — do not commit.
 */
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, 'infra', '.env') });

const HOST = 'staff-staging.lunafrontdesk.com';
const ROUTE = '/staff/bot/booking-create-from-plan';
const CLIENT = 'wolfhouse-somo';

const CASES = [
  {
    id: 'A',
    label: 'confirm false',
    guest_name: 'Deny Matrix Confirm False',
    from: '+15555550131',
    idempotency_key: 'phase13c-deny-confirm-false-001',
    payload: {
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      from: '+15555550131',
      guest_name: 'Deny Matrix Confirm False',
      language: 'en',
      message_text: 'Hi, I want to stay June 15 to June 22 for 2 people. I want to pay the deposit.',
      check_in: '2026-06-15',
      check_out: '2026-06-22',
      guests: 2,
      package_code: 'malibu',
      payment_choice: 'deposit',
      confirm: false,
      idempotency_key: 'phase13c-deny-confirm-false-001',
    },
    expect: {
      success: false,
      write_performed: false,
      required_approvals: ['confirm_true'],
    },
  },
  {
    id: 'B',
    label: 'missing idempotency key',
    guest_name: 'Deny Matrix Missing Idempotency',
    from: '+15555550132',
    idempotency_key: null,
    payload: {
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      from: '+15555550132',
      guest_name: 'Deny Matrix Missing Idempotency',
      language: 'en',
      message_text: 'Hi, I want to stay June 15 to June 22 for 2 people. I want to pay the deposit.',
      check_in: '2026-06-15',
      check_out: '2026-06-22',
      guests: 2,
      package_code: 'malibu',
      payment_choice: 'deposit',
      confirm: true,
    },
    expect: {
      success: false,
      write_performed: false,
      required_approvals: ['idempotency_key'],
    },
  },
  {
    id: 'C',
    label: 'missing payment choice',
    guest_name: 'Deny Matrix Missing Payment Choice',
    from: '+15555550133',
    idempotency_key: 'phase13c-deny-payment-choice-001',
    payload: {
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      from: '+15555550133',
      guest_name: 'Deny Matrix Missing Payment Choice',
      language: 'en',
      message_text: 'Hi, I want to stay June 15 to June 22 for 2 people.',
      check_in: '2026-06-15',
      check_out: '2026-06-22',
      guests: 2,
      package_code: 'malibu',
      confirm: true,
      idempotency_key: 'phase13c-deny-payment-choice-001',
    },
    expect: {
      success: false,
      write_performed: false,
      blocked_reasons: ['payment_choice_missing'],
      safe_next_step: 'ask_deposit_or_full_payment',
    },
  },
  {
    id: 'D',
    label: 'availability insufficient',
    guest_name: 'Deny Matrix Insufficient Beds',
    from: '+15555550134',
    idempotency_key: 'phase13c-deny-availability-001',
    payload: {
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      from: '+15555550134',
      guest_name: 'Deny Matrix Insufficient Beds',
      language: 'en',
      message_text: 'Hi, I want to stay June 15 to June 22 for 2 people. I want to pay the deposit.',
      check_in: '2026-06-15',
      check_out: '2026-06-22',
      guests: 2,
      package_code: 'malibu',
      payment_choice: 'deposit',
      confirm: true,
      idempotency_key: 'phase13c-deny-availability-001',
    },
    expect: {
      success: false,
      write_performed: false,
      blocked_reasons_any: ['availability_insufficient_beds', 'availability_selected_beds_missing'],
    },
  },
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

async function dbCountForCase(c) {
  const url = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const pg = new Client({ connectionString: url });
  await pg.connect();
  try {
    const idem = c.idempotency_key || '__none__';
    const bookings = await pg.query(`
      SELECT b.id::text, b.booking_code, b.guest_name, b.created_at
      FROM bookings b
      INNER JOIN clients cl ON cl.id = b.client_id
      WHERE cl.slug = $1
        AND (b.guest_name = $2 OR b.metadata->>'idempotency_key' = $3 OR b.phone = $4)
      ORDER BY b.created_at DESC
      LIMIT 10
    `, [CLIENT, c.guest_name, idem, c.from]);
    const pays = await pg.query(`
      SELECT p.id::text, p.status::text, p.created_at
      FROM payments p
      INNER JOIN bookings b ON b.id = p.booking_id
      INNER JOIN clients cl ON cl.id = b.client_id
      WHERE cl.slug = $1
        AND (b.guest_name = $2 OR b.metadata->>'idempotency_key' = $3 OR b.phone = $4)
      ORDER BY p.created_at DESC
      LIMIT 10
    `, [CLIENT, c.guest_name, idem, c.from]);
    return {
      booking_rows: bookings.rows.length,
      payment_rows: pays.rows.length,
      bookings: bookings.rows,
      payments: pays.rows,
    };
  } finally {
    await pg.end();
  }
}

function pickApprovals(body) {
  const elig = body.eligibility || {};
  return [...new Set([...(body.required_approvals || []), ...(elig.required_approvals || [])])];
}

function pickBlocked(body) {
  const elig = body.eligibility || {};
  return [...new Set([...(body.blocked_reasons || []), ...(elig.blocked_reasons || [])])];
}

function pickWouldCall(body) {
  const elig = body.eligibility || {};
  return body.would_call || elig.would_call || [];
}

function evaluateCase(c, http, dbBefore, dbAfter) {
  const b = http.body || {};
  const checks = {};
  const approvals = pickApprovals(b);
  const blocked = pickBlocked(b);
  const wouldCall = pickWouldCall(b);

  checks.http_ok = http.status === 200;
  checks.success_false = b.success === false;
  checks.write_performed_false = b.write_performed === false;
  checks.creates_stripe_link_false = b.creates_stripe_link === false;
  checks.sends_whatsapp_false = b.sends_whatsapp === false;
  checks.calls_n8n_false = b.calls_n8n === false;
  checks.would_call_empty = !Array.isArray(wouldCall) || wouldCall.length === 0;
  checks.no_booking_id = !b.booking_id
    && !(b.create_outcome && b.create_outcome.create_response && b.create_outcome.create_response.booking_id);
  checks.db_unchanged = dbBefore.booking_rows === dbAfter.booking_rows
    && dbBefore.payment_rows === dbAfter.payment_rows;

  if (c.expect.required_approvals) {
    for (const req of c.expect.required_approvals) {
      checks[`approval_${req}`] = approvals.includes(req);
    }
  }
  if (c.expect.blocked_reasons) {
    for (const req of c.expect.blocked_reasons) {
      checks[`blocked_${req}`] = blocked.includes(req);
    }
  }
  if (c.expect.blocked_reasons_any) {
    checks.blocked_availability = c.expect.blocked_reasons_any.some((r) => blocked.includes(r));
  }
  if (c.expect.safe_next_step) {
    checks.safe_next_step = (b.safe_next_step || (b.eligibility && b.eligibility.safe_next_step)) === c.expect.safe_next_step;
  }

  const critical = b.write_performed === true
    || !!b.booking_id
    || dbAfter.booking_rows > dbBefore.booking_rows
    || dbAfter.payment_rows > dbBefore.payment_rows;

  let result = 'PASS';
  if (critical) result = 'FAIL';
  else if (!Object.values(checks).every((v) => v === true)) result = 'PARTIAL';

  return {
    case_id: c.id,
    label: c.label,
    http_status: http.status,
    required_approvals: approvals,
    blocked_reasons: blocked,
    safe_next_step: b.safe_next_step || (b.eligibility && b.eligibility.safe_next_step) || null,
    would_call: wouldCall,
    creates_stripe_link: b.creates_stripe_link,
    sends_whatsapp: b.sends_whatsapp,
    calls_n8n: b.calls_n8n,
    write_performed: b.write_performed,
    success: b.success,
    db_before: { bookings: dbBefore.booking_rows, payments: dbBefore.payment_rows },
    db_after: { bookings: dbAfter.booking_rows, payments: dbAfter.payment_rows },
    checks,
    result,
    critical,
  };
}

(async () => {
  let token = process.env.LUNA_BOT_INTERNAL_TOKEN || '';
  if (!token) {
    try {
      token = execSync(
        'az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv',
        { encoding: 'utf8' },
      ).trim();
    } catch (_) { /* fall through */ }
  }
  if (!token) throw new Error('LUNA_BOT_INTERNAL_TOKEN unavailable');

  const out = {
    phase: '13c.3',
    revision: activeRevision(),
    env: stagingEnvFlags(),
    healthz: null,
    route: `POST https://${HOST}${ROUTE}`,
    cases: [],
    result: 'PENDING',
    stopped_early: false,
  };

  out.healthz = await httpsJson('GET', '/healthz');
  out.revision = activeRevision();

  for (const c of CASES) {
    const dbBefore = await dbCountForCase(c);
    const http = await httpsJson('POST', ROUTE, c.payload, { 'X-Luna-Bot-Token': token });
    const dbAfter = await dbCountForCase(c);
    const evaluated = evaluateCase(c, http, dbBefore, dbAfter);
    out.cases.push(evaluated);

    if (evaluated.critical) {
      out.stopped_early = true;
      out.result = 'FAIL';
      console.log(JSON.stringify(out, null, 2));
      process.exit(1);
    }
  }

  const revOk = out.revision.health === 'Healthy' && out.revision.traffic === 100;
  const healthOk = out.healthz.status === 200;
  const allPass = out.cases.every((x) => x.result === 'PASS');

  if (!healthOk || !revOk) out.result = 'PARTIAL';
  else if (allPass) out.result = 'PASS';
  else out.result = 'PARTIAL';

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'FAIL' ? 1 : 0);
})().catch((e) => {
  console.error('PROOF_ERROR:', e.message);
  process.exit(1);
});

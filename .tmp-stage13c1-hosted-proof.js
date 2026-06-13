'use strict';
/**
 * Phase 13c.1 — booking-create-from-plan default-deny hosted proof (staging only)
 * Does not print secrets. Temp file — do not commit.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, 'infra', '.env') });

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = 'b4c77b9';
const IMAGE_EXPECT = 'b4c77b9-stage13c-booking-write-bridge';
const ROUTE = '/staff/bot/booking-create-from-plan';
const CLIENT = 'wolfhouse-somo';
const GUEST = 'Default Deny Proof';
const IDEM = 'phase13c-default-deny-proof-001';

const PAYLOAD = {
  client_slug: 'wolfhouse-somo',
  channel: 'whatsapp',
  from: '+15555550123',
  guest_name: GUEST,
  language: 'en',
  message_text: 'Hi, I want to stay June 15 to June 22 for 2 people. I want to pay the deposit.',
  check_in: '2026-06-15',
  check_out: '2026-06-22',
  guests: 2,
  package_code: 'malibu',
  payment_choice: 'deposit',
  confirm: false,
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
    STAFF_ACTIONS_ENABLED: map.STAFF_ACTIONS_ENABLED,
  };
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
      SELECT b.id::text, b.booking_code, b.guest_name, b.created_at
      FROM bookings b
      INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND (b.guest_name = $2 OR b.metadata->>'idempotency_key' = $3)
      ORDER BY b.created_at DESC
      LIMIT 5
    `, [CLIENT, GUEST, IDEM]);
    const pays = await pg.query(`
      SELECT p.id::text, p.status::text, p.created_at
      FROM payments p
      INNER JOIN bookings b ON b.id = p.booking_id
      INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND (b.guest_name = $2 OR b.metadata->>'idempotency_key' = $3)
      ORDER BY p.created_at DESC
      LIMIT 5
    `, [CLIENT, GUEST, IDEM]);
    return { booking_rows: bookings.rows.length, payment_rows: pays.rows.length, bookings: bookings.rows, payments: pays.rows };
  } finally {
    await pg.end();
  }
}

function redactBody(body) {
  if (!body || typeof body !== 'object') return body;
  const copy = JSON.parse(JSON.stringify(body));
  return copy;
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
  if (!token) throw new Error('LUNA_BOT_INTERNAL_TOKEN unavailable (infra/.env or Key Vault)');

  const out = {
    phase: '13c.1',
    commit: COMMIT,
    revision: activeRevision(),
    env: stagingEnvFlags(),
    healthz: null,
    route: ROUTE,
    db_before: null,
    http_status: null,
    response: null,
    db_after: null,
    checks: {},
    result: 'PENDING',
    deploy_needed: false,
    deploy_performed: false,
  };

  out.healthz = await httpsJson('GET', '/healthz');
  out.checks.healthz_200 = out.healthz.status === 200;

  out.revision = activeRevision();
  const alreadyDeployed = out.revision.image.includes(IMAGE_EXPECT) || out.revision.image.includes(COMMIT);
  out.deploy_needed = !alreadyDeployed;

  if (out.deploy_needed) {
    const probe = await httpsJson('POST', ROUTE, PAYLOAD, { 'X-Luna-Bot-Token': token });
    if (probe.status !== 404 && probe.status !== 405) out.deploy_needed = false;
  }

  if (out.deploy_needed) {
    console.log('DEPLOY_NEEDED: staging missing route — building image...');
    const build = execSync(
      `az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_EXPECT} --file Dockerfile .`,
      { encoding: 'utf8', cwd: path.join(__dirname), maxBuffer: 20 * 1024 * 1024 },
    );
    out.acr_build_tail = build.split('\n').slice(-8).join('\n');
    const suffix = 'stage13c-booking-write-bridge';
    execSync(
      `az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --image whstagingacr.azurecr.io/wh-staff-api:${IMAGE_EXPECT} --revision-suffix ${suffix}`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    );
    out.deploy_performed = true;
    // wait for healthy
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 10000));
      const rev = activeRevision();
      out.revision = rev;
      if (rev.health === 'Healthy' && rev.traffic === 100 && rev.image.includes(IMAGE_EXPECT)) break;
    }
  }

  out.revision = activeRevision();
  out.env = stagingEnvFlags();

  out.db_before = await dbSnapshot();

  const res = await httpsJson('POST', ROUTE, PAYLOAD, { 'X-Luna-Bot-Token': token });
  out.http_status = res.status;
  out.response = redactBody(res.body);

  out.db_after = await dbSnapshot();

  const b = out.response || {};
  const elig = b.eligibility || {};
  out.checks.route_not_404 = res.status !== 404 && res.status !== 405;
  out.checks.success_false = b.success === false;
  out.checks.write_performed_false = b.write_performed === false;
  out.checks.write_ready_false = b.write_ready === false || elig.write_ready === false;
  out.checks.creates_stripe_link_false = b.creates_stripe_link === false;
  out.checks.sends_whatsapp_false = b.sends_whatsapp === false;
  out.checks.calls_n8n_false = b.calls_n8n === false;
  out.checks.no_booking_id = !b.booking_id && !(b.create_outcome && b.create_outcome.create_response && b.create_outcome.create_response.booking_id);
  out.checks.db_unchanged = out.db_before.booking_rows === out.db_after.booking_rows
    && out.db_before.payment_rows === out.db_after.payment_rows;
  out.checks.has_blocked_or_approvals = (
    (Array.isArray(b.blocked_reasons) && b.blocked_reasons.length > 0)
    || (Array.isArray(b.required_approvals) && b.required_approvals.length > 0)
    || (Array.isArray(elig.blocked_reasons) && elig.blocked_reasons.length > 0)
    || (Array.isArray(elig.required_approvals) && elig.required_approvals.length > 0)
  );
  out.checks.confirm_approval_missing = (
    (b.required_approvals || []).includes('confirm_true')
    || (elig.required_approvals || []).includes('confirm_true')
  );

  const revOk = out.revision.health === 'Healthy' && out.revision.traffic === 100;
  const imageOk = out.revision.image.includes(IMAGE_EXPECT) || out.revision.image.includes(COMMIT);

  out.checks.revision_healthy = revOk;
  out.checks.image_has_commit = imageOk;

  const criticalFail = !out.checks.route_not_404
    || b.write_performed === true
    || b.booking_id
    || !out.checks.db_unchanged
    || (out.db_after.booking_rows > out.db_before.booking_rows);

  if (criticalFail) out.result = 'FAIL';
  else if (Object.values(out.checks).every((v) => v === true)) out.result = 'PASS';
  else out.result = 'PARTIAL';

  out.rollback = {
    previous_revision: 'wh-staging-staff-api--0000120',
    previous_image: 'whstagingacr.azurecr.io/wh-staff-api:e7f8ead-stage12e-booking-dry-run',
    command: 'az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --image whstagingacr.azurecr.io/wh-staff-api:e7f8ead-stage12e-booking-dry-run --revision-suffix rollback-stage12e',
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'FAIL' ? 1 : 0);
})().catch((e) => {
  console.error('PROOF_ERROR:', e.message);
  process.exit(1);
});

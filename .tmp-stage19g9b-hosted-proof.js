'use strict';
/** Phase 19g.9b — deploy + hosted inbox API proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = '834d7c1';
const IMAGE_TAG = `${COMMIT}-stage19g9-message-events-read`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const TEST_FROM = '491726422307';
const PROOF_START = new Date().toISOString();

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path,
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
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
    return row.value != null ? row.value : `(secret:${row.secretRef})`;
  };
  return {
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
  };
}

async function dbSafety() {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const sent = await pg.query(
    `SELECT idempotency_key, status, created_at FROM guest_message_sends
     WHERE status = 'sent' AND created_at >= $1::timestamptz`,
    [PROOF_START],
  );
  const bookings = await pg.query(`SELECT id FROM bookings WHERE created_at >= $1::timestamptz LIMIT 3`, [PROOF_START]);
  const payments = await pg.query(`SELECT id FROM payments WHERE created_at >= $1::timestamptz LIMIT 3`, [PROOF_START]);
  await pg.end();
  return { sent: sent.rows, bookings: bookings.rows, payments: payments.rows };
}

function summarizeEvents(events) {
  return (events || []).map((e) => ({
    wa_message_id: String(e.wa_message_id || '').slice(-24),
    next_action: e.next_action,
    handoff_required: e.handoff_required,
    send_attempted: e.send_attempted,
    send_status: e.send_status,
    has_raw: 'raw_payload' in (e || {}),
    has_norm: 'normalized' in (e || {}),
  }));
}

function hasPartialIT(events) {
  return (events || []).some((e) => e.next_action === 'ask_missing_field'
    && e.send_attempted === true
    && (e.send_status === 'blocked' || e.send_blocked_reasons?.includes('luna_auto_send_not_enabled')));
}

function hasRefund(events) {
  return (events || []).some((e) => e.next_action === 'handoff_to_staff' && e.handoff_required === true);
}

function hasHello(events) {
  return (events || []).some((e) => e.next_action === 'unsupported');
}

function newestFirst(events) {
  if (!events || events.length < 2) return true;
  for (let i = 1; i < events.length; i++) {
    const a = new Date(events[i - 1].created_at).getTime();
    const b = new Date(events[i].created_at).getTime();
    if (a < b) return false;
  }
  return true;
}

async function deployIfNeeded() {
  const rev = activeRevision();
  if (String(rev.image || '').includes('834d7c1')) {
    return { skipped: true, revision: rev };
  }
  console.error('Building image...');
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  console.error('Updating container app...');
  az(`az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --image ${IMAGE} --revision-suffix stage19g9-message-events-read`);
  for (let i = 0; i < 36; i++) {
    const r = activeRevision();
    if (r.health === 'Healthy' && r.traffic === 100 && String(r.image || '').includes('834d7c1')) {
      return { skipped: false, revision: r };
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  return { skipped: false, revision: activeRevision(), warn: 'health_wait_timeout' };
}

(async () => {
  const deploy = await deployIfNeeded();
  const rev = deploy.revision;
  const env = stagingEnvFlags();
  const health = await req('GET', '/healthz');
  const verify = await req(
    'GET',
    '/staff/meta/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wolfhouse_verify_token&hub.challenge=19g9b',
  );

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');

  const proofA = await req('GET', `/staff/inbox/message-events?client_slug=${CLIENT}&from_phone=${TEST_FROM}&limit=10`, null, cookie);
  const proofB = await req('GET', `/staff/inbox/message-events?client_slug=${CLIENT}&from_phone=${TEST_FROM}&handoff_required=true&limit=20`, null, cookie);
  const proofC = await req('GET', `/staff/inbox/message-events?client_slug=${CLIENT}&from_phone=${TEST_FROM}&send_attempted=true&limit=20`, null, cookie);
  const proofD = await req('GET', `/staff/inbox/message-events?client_slug=${CLIENT}&from_phone=${TEST_FROM}&next_action=handoff_to_staff&limit=20`, null, cookie);
  const proofE_limit = await req('GET', `/staff/inbox/message-events?client_slug=${CLIENT}&from_phone=${TEST_FROM}&limit=500`, null, cookie);
  const proofE_bad = await req('GET', `/staff/inbox/message-events?client_slug=${CLIENT}&since=not-a-date`, null, cookie);

  const safety = await dbSafety();

  const a = proofA.body || {};
  const b = proofB.body || {};
  const c = proofC.body || {};
  const d = proofD.body || {};
  const eLim = proofE_limit.body || {};

  const checks = {
    A: proofA.status === 200 && a.success === true && Array.isArray(a.events)
      && a.total_returned >= 3 && hasPartialIT(a.events) && hasRefund(a.events) && hasHello(a.events)
      && newestFirst(a.events)
      && !(a.events[0] && ('raw_payload' in a.events[0] || 'normalized' in a.events[0])),
    B: proofB.status === 200 && b.success === true
      && (b.events || []).every((e) => e.handoff_required === true)
      && hasRefund(b.events) && !hasPartialIT(b.events),
    C: proofC.status === 200 && c.success === true
      && hasPartialIT(c.events)
      && !(c.events || []).some((e) => e.next_action === 'handoff_to_staff' || e.next_action === 'unsupported'),
    D: proofD.status === 200 && d.success === true
      && (d.events || []).every((e) => e.next_action === 'handoff_to_staff')
      && hasRefund(d.events) && !hasHello(d.events),
    E: (proofE_limit.status === 200 && (eLim.events || []).length <= 200) || proofE_bad.status === 400,
  };

  let result = 'PASS';
  if (Object.values(checks).some((v) => !v)) result = 'PARTIAL';
  if (safety.sent.length > 0) result = 'FAIL';
  if (login.status !== 200 || !cookie) result = 'FAIL';

  console.log(JSON.stringify({
    phase: '19g.9b',
    result,
    proof_start: PROOF_START,
    checked_at: new Date().toISOString(),
    commit: COMMIT,
    image: IMAGE,
    deploy,
    revision: rev,
    health: { status: health.status, body: health.body },
    webhook_verify: { status: verify.status, body: typeof verify.body === 'string' ? verify.body.slice(0, 40) : verify.body },
    env,
    login: { status: login.status, ok: login.status === 200 && !!cookie },
    proofs: {
      A: { status: proofA.status, total_returned: a.total_returned, pass: checks.A, sample: summarizeEvents(a.events) },
      B: { status: proofB.status, total_returned: b.total_returned, pass: checks.B, sample: summarizeEvents(b.events) },
      C: { status: proofC.status, total_returned: c.total_returned, pass: checks.C, sample: summarizeEvents(c.events) },
      D: { status: proofD.status, total_returned: d.total_returned, pass: checks.D, sample: summarizeEvents(d.events) },
      E: {
        limit500_status: proofE_limit.status,
        limit500_count: (eLim.events || []).length,
        bad_since_status: proofE_bad.status,
        pass: checks.E,
      },
    },
    checks,
    safety: {
      sent_after_proof: safety.sent,
      bookings: safety.bookings,
      payments: safety.payments,
      no_send: safety.sent.length === 0,
    },
  }, null, 2));
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});

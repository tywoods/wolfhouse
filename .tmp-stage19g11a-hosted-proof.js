'use strict';
/** Phase 19g.11a-hosted — temp proof script. Do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const PHONE = '491726422307';
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

async function phoneCounts(pg, label) {
  const ev = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_events
     WHERE client_slug = $1 AND REPLACE(COALESCE(from_phone, ''), '+', '') LIKE $2`,
    [CLIENT, `%${PHONE}%`],
  );
  const se = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends
     WHERE client_slug = $1 AND REPLACE(COALESCE(to_phone, ''), '+', '') LIKE $2`,
    [CLIENT, `%${PHONE}%`],
  );
  const bk = await pg.query('SELECT COUNT(*)::int AS n FROM bookings');
  const pay = await pg.query('SELECT COUNT(*)::int AS n FROM payments');
  const sent = await pg.query(
    `SELECT id, status, created_at FROM guest_message_sends
     WHERE status = 'sent' AND created_at >= $1::timestamptz LIMIT 5`,
    [PROOF_START],
  );
  return {
    label,
    guest_message_events: ev.rows[0].n,
    guest_message_sends: se.rows[0].n,
    bookings: bk.rows[0].n,
    payments: pay.rows[0].n,
    sent_since_proof_start: sent.rows,
  };
}

(async () => {
  const rev = activeRevision();
  const env = stagingEnvFlags();
  const health = await req('GET', '/healthz');
  const meta = await req(
    'GET',
    '/staff/meta/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wolfhouse_verify_token&hub.challenge=19g11a',
  );

  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const dbBefore = await phoneCounts(pg, 'before');

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');

  const eventsBefore = await req(
    'GET',
    `/staff/inbox/message-events?client_slug=${CLIENT}&from_phone=${PHONE}&limit=20`,
    null,
    cookie,
  );

  const reset1 = await req('POST', '/staff/test/reset-luna-phone', {
    client_slug: CLIENT,
    phone: PHONE,
  }, cookie);

  const dbAfter1 = await phoneCounts(pg, 'after_reset1');
  const eventsAfter1 = await req(
    'GET',
    `/staff/inbox/message-events?client_slug=${CLIENT}&from_phone=${PHONE}&limit=20`,
    null,
    cookie,
  );

  const reset2 = await req('POST', '/staff/test/reset-luna-phone', {
    client_slug: CLIENT,
    phone: PHONE,
  }, cookie);

  const dbAfter2 = await phoneCounts(pg, 'after_reset2');
  await pg.end();

  const r1 = reset1.body || {};
  const r2 = reset2.body || {};
  const eb = eventsBefore.body || {};
  const ea = eventsAfter1.body || {};

  const checks = {
    deploy_7fd94d9: String(rev.image || '').includes('7fd94d9'),
    revision_healthy: rev.health === 'Healthy' && rev.traffic === 100,
    healthz_200: health.status === 200,
    env_dry_run: env.WHATSAPP_DRY_RUN === 'true',
    env_auto_send_unset: env.LUNA_AUTO_SEND_ENABLED === '(unset)',
    meta_webhook_staff: meta.status === 200 && meta.body === '19g11a',
    login_ok: login.status === 200 && !!cookie,
    events_before_visible: eventsBefore.status === 200 && eb.success === true,
    reset1_200: reset1.status === 200 && r1.success === true,
    reset1_deleted_match: (r1.deleted?.guest_message_events || 0) === dbBefore.guest_message_events
      && (r1.deleted?.guest_message_sends || 0) === dbBefore.guest_message_sends,
    db_events_zero: dbAfter1.guest_message_events === 0 && dbAfter1.guest_message_sends === 0,
    bookings_unchanged: dbAfter1.bookings === dbBefore.bookings && dbAfter2.bookings === dbBefore.bookings,
    payments_unchanged: dbAfter1.payments === dbBefore.payments && dbAfter2.payments === dbBefore.payments,
    events_after_empty: eventsAfter1.status === 200 && (ea.events || []).length === 0,
    reset2_zero_deletes: reset2.status === 200 && r2.success === true
      && r2.deleted?.guest_message_events === 0 && r2.deleted?.guest_message_sends === 0,
    no_sent_since_start: dbAfter2.sent_since_proof_start.length === 0,
  };

  let result = 'PASS';
  if (Object.values(checks).some((v) => !v)) result = 'PARTIAL';
  if (!checks.reset1_200 || !checks.bookings_unchanged || !checks.payments_unchanged) result = 'FAIL';
  if (dbAfter2.sent_since_proof_start.length > 0) result = 'FAIL';

  console.log(JSON.stringify({
    phase: '19g.11a-hosted',
    result,
    proof_start: PROOF_START,
    deploy: { commit: '7fd94d9', revision: rev, image: rev.image },
    health: { status: health.status, body: health.body },
    env,
    meta_webhook: { status: meta.status, body: meta.body },
    db: { before: dbBefore, after_reset1: dbAfter1, after_reset2: dbAfter2 },
    api: {
      events_before: { status: eventsBefore.status, total: eb.total_returned, count: (eb.events || []).length },
      reset1: { status: reset1.status, body: r1 },
      events_after: { status: eventsAfter1.status, total: ea.total_returned, count: (ea.events || []).length },
      reset2: { status: reset2.status, body: r2 },
    },
    checks,
  }, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });

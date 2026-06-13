'use strict';
/** Phase 19g.12 — phone-origin auto-reply proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const FROM = '491726422307';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:d2f4dae-stage19g11a-ui-fix';
const PROOF_SUFFIX = 'stage19g12-retry-proof';
const REVERT_SUFFIX = 'stage19g12-retry-safe';
const CASE_A_SNIPPET = 'siamo due persone';
const CASE_B_SNIPPET = 'refund';
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
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
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
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
    WHATSAPP_LIVE_SENDS_ENABLED: pick('WHATSAPP_LIVE_SENDS_ENABLED'),
    LUNA_GUEST_LIVE_SEND_OWNER_APPROVED: pick('LUNA_GUEST_LIVE_SEND_OWNER_APPROVED'),
    WHATSAPP_CLOUD_ACCESS_TOKEN: pick('WHATSAPP_CLOUD_ACCESS_TOKEN'),
    WHATSAPP_PHONE_NUMBER_ID: pick('WHATSAPP_PHONE_NUMBER_ID'),
  };
}

async function staffCookie() {
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  return (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
}

async function pgConnect() {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

async function resetPhone(cookie) {
  return req('POST', '/staff/test/reset-luna-phone', { client_slug: CLIENT, phone: FROM }, cookie);
}

async function phoneRowCounts(pg) {
  const ev = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_events
      WHERE client_slug = $1 AND REPLACE(COALESCE(from_phone, ''), '+', '') LIKE $2`,
    [CLIENT, `%${FROM}%`],
  );
  const se = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends
      WHERE client_slug = $1 AND REPLACE(COALESCE(to_phone, ''), '+', '') LIKE $2`,
    [CLIENT, `%${FROM}%`],
  );
  const bk = await pg.query('SELECT COUNT(*)::int AS n FROM bookings WHERE created_at >= $1::timestamptz', [PROOF_START]);
  const pay = await pg.query('SELECT COUNT(*)::int AS n FROM payments WHERE created_at >= $1::timestamptz', [PROOF_START]);
  return {
    guest_message_events: ev.rows[0].n,
    guest_message_sends: se.rows[0].n,
    bookings_new: bk.rows[0].n,
    payments_new: pay.rows[0].n,
  };
}

async function findCaseA(pg) {
  const r = await pg.query(
    `SELECT wa_message_id, message_text, draft_called, next_action, suggested_reply,
            handoff_required, send_attempted, send_status, send_blocked_reasons,
            send_idempotency_key, raw_payload, created_at
       FROM guest_message_events
      WHERE client_slug = $1
        AND REPLACE(COALESCE(from_phone, ''), '+', '') LIKE $2
        AND created_at >= $3::timestamptz
        AND message_text ILIKE $4
      ORDER BY created_at DESC LIMIT 1`,
    [CLIENT, `%${FROM}%`, PROOF_START, `%${CASE_A_SNIPPET}%`],
  );
  return r.rows[0] || null;
}

async function findCaseB(pg, afterTs) {
  const r = await pg.query(
    `SELECT wa_message_id, message_text, draft_called, next_action, suggested_reply,
            handoff_required, send_attempted, send_status, send_blocked_reasons,
            send_idempotency_key, created_at
       FROM guest_message_events
      WHERE client_slug = $1
        AND REPLACE(COALESCE(from_phone, ''), '+', '') LIKE $2
        AND created_at >= $3::timestamptz
        AND message_text ILIKE $4
      ORDER BY created_at DESC LIMIT 1`,
    [CLIENT, `%${FROM}%`, afterTs, `%${CASE_B_SNIPPET}%`],
  );
  return r.rows[0] || null;
}

async function querySends(pg, idempotencyKey) {
  const s = await pg.query(
    `SELECT idempotency_key, status, provider_message_id, message_text, created_at
       FROM guest_message_sends WHERE idempotency_key = $1 ORDER BY created_at ASC`,
    [idempotencyKey],
  );
  return s.rows;
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
    'LUNA_AUTO_SEND_ENABLED=true',
    'WHATSAPP_DRY_RUN=false',
    'WHATSAPP_LIVE_SENDS_ENABLED=true',
    'LUNA_GUEST_LIVE_SEND_OWNER_APPROVED=true',
    'WHATSAPP_CLOUD_ACCESS_TOKEN=secretref:meta-whatsapp-token',
    'WHATSAPP_PHONE_NUMBER_ID=secretref:meta-whatsapp-phone-id',
  ].join(' '));
}

function revertSafeRevision() {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REVERT_SUFFIX}`,
    '--set-env-vars WHATSAPP_DRY_RUN=true',
    '--remove-env-vars LUNA_AUTO_SEND_ENABLED WHATSAPP_LIVE_SENDS_ENABLED LUNA_GUEST_LIVE_SEND_OWNER_APPROVED WHATSAPP_CLOUD_ACCESS_TOKEN WHATSAPP_PHONE_NUMBER_ID',
  ].join(' '));
}

async function pollCaseA(pg, timeoutMs = 600000, intervalMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const row = await findCaseA(pg);
    if (row && String(row.wa_message_id || '').startsWith('wamid.')) return row;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

async function pollCaseB(pg, afterTs, timeoutMs = 600000, intervalMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const row = await findCaseB(pg, afterTs);
    if (row && String(row.wa_message_id || '').startsWith('wamid.')) return row;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

(async () => {
  const step = process.argv[2] || 'status';
  const out = { phase: '19g.12', proof_start: PROOF_START, checked_at: new Date().toISOString() };

  if (step === 'reset') {
    const cookie = await staffCookie();
    out.reset = await resetPhone(cookie);
    const pg = await pgConnect();
    out.counts = await phoneRowCounts(pg);
    await pg.end();
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (step === 'precheck') {
    out.env_before = stagingEnvFlags();
    out.revision_before = activeRevision();
    out.health = (await req('GET', '/healthz')).status;
    out.webhook_verify = (await req('GET', '/staff/meta/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wolfhouse_verify_token&hub.challenge=phoneproof123')).raw;
    const cookie = await staffCookie();
    out.reset = (await resetPhone(cookie)).body;
    const pg = await pgConnect();
    out.counts_after_reset = await phoneRowCounts(pg);
    const ev = await req('GET', `/staff/inbox/message-events?client_slug=${CLIENT}&from_phone=${FROM}&limit=5`, null, cookie);
    out.message_events = { status: ev.status, total: ev.body?.total_returned };
    await pg.end();
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (step === 'enable') {
    enableProofRevision();
    out.proof_revision = await waitHealthy(PROOF_SUFFIX);
    out.env_during = stagingEnvFlags();
    out.health = (await req('GET', '/healthz')).status;
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (step === 'poll-a') {
    const pg = await pgConnect();
    out.case_a = await pollCaseA(pg, Number(process.argv[3] || 600000));
    if (out.case_a) {
      const idem = out.case_a.send_idempotency_key;
      out.case_a_sends = idem ? await querySends(pg, idem) : [];
      out.case_a_sent_count = (out.case_a_sends || []).filter((r) => r.status === 'sent').length;
    }
    await pg.end();
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (step === 'replay-a') {
    const wamid = process.argv[3];
    if (!wamid) throw new Error('usage: replay-a <wa_message_id>');
    const pg = await pgConnect();
    const ev = await pg.query(
      'SELECT raw_payload, send_idempotency_key FROM guest_message_events WHERE client_slug=$1 AND wa_message_id=$2',
      [CLIENT, wamid],
    );
    const row = ev.rows[0];
    if (!row?.raw_payload) throw new Error('raw_payload missing for ' + wamid);
    const payload = typeof row.raw_payload === 'string' ? JSON.parse(row.raw_payload) : row.raw_payload;
    const before = row.send_idempotency_key ? await querySends(pg, row.send_idempotency_key) : [];
    const replay = await req('POST', '/staff/meta/whatsapp/webhook', payload);
    await new Promise((r) => setTimeout(r, 2000));
    const after = row.send_idempotency_key ? await querySends(pg, row.send_idempotency_key) : [];
    out.replay = { http: replay.status, body: replay.body };
    out.sends_before = before;
    out.sends_after = after;
    out.sent_before = before.filter((r) => r.status === 'sent').length;
    out.sent_after = after.filter((r) => r.status === 'sent').length;
    await pg.end();
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (step === 'poll-b') {
    const afterTs = process.argv[3] || PROOF_START;
    const pg = await pgConnect();
    out.case_b = await pollCaseB(pg, afterTs, Number(process.argv[4] || 600000));
    if (out.case_b) {
      const idem = out.case_b.send_idempotency_key;
      out.case_b_sends = idem ? await querySends(pg, idem) : [];
      out.case_b_sent_for_wamid = (await pg.query(
        `SELECT idempotency_key, status FROM guest_message_sends
          WHERE created_at >= $1::timestamptz AND to_phone LIKE $2 AND status = 'sent'
            AND idempotency_key LIKE $3`,
        [PROOF_START, `%${FROM}%`, `%${out.case_b.wa_message_id}%`],
      )).rows;
    }
    await pg.end();
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (step === 'revert') {
    revertSafeRevision();
    out.restored_revision = await waitHealthy(REVERT_SUFFIX);
    out.env_after = stagingEnvFlags();
    out.health = (await req('GET', '/healthz')).status;
    out.webhook = (await req('GET', '/staff/meta/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wolfhouse_verify_token&hub.challenge=phoneproof123')).raw;
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (step === 'status') {
    out.revision = activeRevision();
    out.env = stagingEnvFlags();
    const pg = await pgConnect();
    out.counts = await phoneRowCounts(pg);
    out.recent_events = (await pg.query(
      `SELECT wa_message_id, message_text, next_action, send_attempted, send_status, created_at
         FROM guest_message_events
        WHERE client_slug=$1 AND REPLACE(COALESCE(from_phone,''),'+','') LIKE $2
        ORDER BY created_at DESC LIMIT 5`,
      [CLIENT, `%${FROM}%`],
    )).rows;
    await pg.end();
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (step === 'score') {
    const pg = await pgConnect();
    const safety = await phoneRowCounts(pg);
    const sent = await pg.query(
      `SELECT idempotency_key, status, provider_message_id, whatsapp_message_id, created_at
         FROM guest_message_sends WHERE status='sent' AND created_at >= $1::timestamptz`,
      [PROOF_START],
    );
    out.safety = { ...safety, sent_rows: sent.rows };
    await pg.end();
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  throw new Error('unknown step: ' + step);
})().catch((e) => { console.error(e.message); process.exit(1); });

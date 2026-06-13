'use strict';
/** Phase 19g.7 — Meta callback cutover helper. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const STAFF_WEBHOOK = 'https://staff-staging.lunafrontdesk.com/staff/meta/whatsapp/webhook';
const N8N_WEBHOOK = 'https://tywoods.app.n8n.cloud/webhook/booking-assistant';
const VERIFY_TOKEN = 'wolfhouse_verify_token';
const WABA_ID = '842343435599477';
const TEST_FROM = '491726422307';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function graphGet(path, token) {
  return new Promise((resolve, reject) => {
    const url = `https://graph.facebook.com/v21.0${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
    https.get(url, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    }).on('error', reject);
  });
}

function graphPost(path, token, form) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ ...form, access_token: token });
    const data = params.toString();
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v21.0${path}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(urlPath, host = 'staff-staging.lunafrontdesk.com') {
  return new Promise((resolve, reject) => {
    https.get({ hostname: host, path: urlPath }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

async function dbProof() {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const sends = await pg.query(
    `SELECT idempotency_key, status, blocked_reasons, to_phone, message_text, created_at
     FROM guest_message_sends
     WHERE created_at > NOW() - INTERVAL '2 hours'
       AND (to_phone LIKE '%491726422307%' OR idempotency_key LIKE '%491726422307%'
            OR message_text ILIKE '%settembre%' OR message_text ILIKE '%refund%'
            OR idempotency_key LIKE '%phase19g7%' OR idempotency_key LIKE '%wamid.%')
     ORDER BY created_at DESC LIMIT 20`,
  );
  const bookings = await pg.query(
    `SELECT id, booking_code, created_at FROM bookings WHERE created_at > NOW() - INTERVAL '2 hours' LIMIT 5`,
  );
  const payments = await pg.query(
    `SELECT id, status, created_at FROM payments WHERE created_at > NOW() - INTERVAL '2 hours' LIMIT 5`,
  );
  await pg.end();
  return { guest_message_sends: sends.rows, recent_bookings: bookings.rows, recent_payments: payments.rows };
}

(async () => {
  const token = az('az keyvault secret show --vault-name wh-staging-kv --name meta-whatsapp-token --query value -o tsv');
  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const pick = (name) => {
    const row = env.find((e) => e.name === name);
    if (!row) return '(unset)';
    return row.value != null ? row.value : `(secret:${row.secretRef})`;
  };

  const health = await httpsGet('/healthz');
  const verify = await httpsGet(`/staff/meta/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=cutover123`);
  const n8nProbe = await httpsGet('/webhook/booking-assistant', 'tywoods.app.n8n.cloud');

  const debug = await graphGet(`/debug_token?input_token=${encodeURIComponent(token)}`, token);
  const appId = debug.body && debug.body.data && debug.body.data.app_id;

  let subsBefore = null;
  let subsAfter = null;
  let cutoverAttempt = null;
  let revertAttempt = null;

  if (appId) {
    subsBefore = await graphGet(`/${appId}/subscriptions`, token);
    cutoverAttempt = await graphPost(`/${appId}/subscriptions`, token, {
      object: 'whatsapp_business_account',
      callback_url: STAFF_WEBHOOK,
      verify_token: VERIFY_TOKEN,
      fields: 'messages',
    });
    subsAfter = await graphGet(`/${appId}/subscriptions`, token);
  }

  const wabaApps = await graphGet(`/${WABA_ID}/subscribed_apps`, token);

  const db = await dbProof();

  const sentRows = db.guest_message_sends.filter((r) => r.status === 'sent');
  const realInbound = db.guest_message_sends.filter((r) =>
    !r.idempotency_key.includes('phase19g6') && !r.idempotency_key.includes('phase19g4')
    && (String(r.to_phone || '').includes('491726422307') || /wamid\./.test(r.idempotency_key)));

  const callbackAfter = subsAfter && subsAfter.body && subsAfter.body.data && subsAfter.body.data[0]
    ? subsAfter.body.data[0].callback_url : null;

  const cutoverOk = cutoverAttempt && cutoverAttempt.status === 200 && cutoverAttempt.body && cutoverAttempt.body.success === true;
  const callbackOnStaff = callbackAfter && callbackAfter.includes('staff-staging.lunafrontdesk.com/staff/meta/whatsapp/webhook');

  let result = 'PARTIAL';
  const blockers = [];

  if (health.status !== 200 || verify.status !== 200 || verify.body !== 'cutover123') blockers.push('precheck_failed');
  if (!cutoverOk && !callbackOnStaff) blockers.push('meta_cutover_not_confirmed');
  if (sentRows.length > 0) blockers.push('sent_rows_detected');
  if (db.recent_bookings.length > 0 || db.recent_payments.length > 0) blockers.push('booking_payment_rows');

  const hasRealInboundProof = realInbound.length > 0;
  if (cutoverOk || callbackOnStaff) {
    if (hasRealInboundProof && sentRows.length === 0) result = 'PASS';
    else if (!hasRealInboundProof) {
      blockers.push('awaiting_real_inbound_whatsapp_from_test_phone');
      result = 'PARTIAL';
    } else result = 'FAIL';
  } else {
    result = 'FAIL';
  }

  const out = {
    phase: '19g.7',
    result,
    blockers,
    original_callback_url: N8N_WEBHOOK,
    target_callback_url: STAFF_WEBHOOK,
    verify_token: VERIFY_TOKEN,
    meta_verification: {
      staff_get_verify: { status: verify.status, body: verify.body, ok: verify.status === 200 && verify.body === 'cutover123' },
      graph_cutover: cutoverAttempt ? { status: cutoverAttempt.status, success: cutoverAttempt.body && cutoverAttempt.body.success, error: cutoverAttempt.body && cutoverAttempt.body.error } : null,
      subscriptions_before: subsBefore && subsBefore.body && subsBefore.body.data ? subsBefore.body.data.map((s) => ({ object: s.object, callback_url: s.callback_url, active: s.active })) : subsBefore,
      subscriptions_after: subsAfter && subsAfter.body && subsAfter.body.data ? subsAfter.body.data.map((s) => ({ object: s.object, callback_url: s.callback_url, active: s.active })) : subsAfter,
      callback_on_staff_api: callbackOnStaff,
      app_id: appId || null,
    },
    env_flags: {
      WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
      LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
    },
    healthz: health.status,
    n8n_probe: { status: n8nProbe.status },
    waba_subscribed_apps: wabaApps.body,
    guest_message_sends_recent: db.guest_message_sends,
    real_inbound_candidates: realInbound,
    no_sent_rows: sentRows.length === 0,
    callback_kept_or_reverted: callbackOnStaff ? 'kept_on_staff_pending_ty_decision' : 'not_cut_over',
    note: hasRealInboundProof
      ? 'Real inbound rows found in guest_message_sends'
      : 'Meta callback may be updated — send Case A/B/C from +491726422307 to +34663439419 then re-run dbProof',
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(result === 'FAIL' ? 1 : 0);
})().catch((e) => {
  console.error('CUTOVER_ERROR:', e.message);
  process.exit(1);
});

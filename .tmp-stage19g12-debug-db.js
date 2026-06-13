'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const https = require('https');

const CLIENT = 'wolfhouse-somo';
const PHONE = '491726422307';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: 'staff-staging.lunafrontdesk.com',
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

(async () => {
  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const pick = (name) => {
    const row = env.find((e) => e.name === name);
    if (!row) return '(unset)';
    if (row.secretRef) return `(secret:${row.secretRef})`;
    return row.value != null ? row.value : '(unset)';
  };

  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const events = await pg.query(
    `SELECT id, created_at, wa_message_id, from_phone, message_text, draft_called, next_action,
            handoff_required, send_attempted, send_status, send_idempotency_key, send_blocked_reasons
       FROM guest_message_events
      WHERE client_slug = $1 AND REPLACE(COALESCE(from_phone, ''), '+', '') LIKE $2
      ORDER BY created_at DESC LIMIT 10`,
    [CLIENT, `%${PHONE}%`],
  );

  const idemKeys = [...new Set(events.rows.map((r) => r.send_idempotency_key).filter(Boolean))];
  let sends = { rows: [] };
  if (idemKeys.length) {
    sends = await pg.query(
      `SELECT id, created_at, idempotency_key, status, blocked_reasons, provider_message_id, sent_at, to_phone, message_text
         FROM guest_message_sends
        WHERE client_slug = $1
          AND (idempotency_key = ANY($2::text[]) OR REPLACE(COALESCE(to_phone, ''), '+', '') LIKE $3)
        ORDER BY created_at DESC LIMIT 10`,
      [CLIENT, idemKeys, `%${PHONE}%`],
    );
  } else {
    sends = await pg.query(
      `SELECT id, created_at, idempotency_key, status, blocked_reasons, provider_message_id, sent_at, to_phone, message_text
         FROM guest_message_sends
        WHERE client_slug = $1 AND REPLACE(COALESCE(to_phone, ''), '+', '') LIKE $2
        ORDER BY created_at DESC LIMIT 10`,
      [CLIENT, `%${PHONE}%`],
    );
  }

  const sentSince = await pg.query(
    `SELECT idempotency_key, status, provider_message_id, created_at
       FROM guest_message_sends WHERE status = 'sent' AND created_at >= NOW() - INTERVAL '24 hours'
       AND REPLACE(COALESCE(to_phone, ''), '+', '') LIKE $1`,
    [`%${PHONE}%`],
  );

  await pg.end();

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookieStr = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const me = await req('GET', `/staff/inbox/message-events?client_slug=${CLIENT}&from_phone=${PHONE}&limit=10`, null, cookieStr);

  console.log(JSON.stringify({
    env: {
      WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
      LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
      WHATSAPP_LIVE_SENDS_ENABLED: pick('WHATSAPP_LIVE_SENDS_ENABLED'),
      LUNA_GUEST_LIVE_SEND_OWNER_APPROVED: pick('LUNA_GUEST_LIVE_SEND_OWNER_APPROVED'),
      WHATSAPP_CLOUD_ACCESS_TOKEN: pick('WHATSAPP_CLOUD_ACCESS_TOKEN'),
      WHATSAPP_PHONE_NUMBER_ID: pick('WHATSAPP_PHONE_NUMBER_ID'),
    },
    guest_message_events: events.rows,
    guest_message_sends: sends.rows,
    sent_last_24h: sentSince.rows,
    message_events_api: {
      status: me.status,
      total: me.body?.total_returned,
      events: (me.body?.events || []).map((e) => ({
        wa_message_id: e.wa_message_id,
        created_at: e.created_at,
        message_text: (e.message_text || '').slice(0, 120),
        next_action: e.next_action,
        send_attempted: e.send_attempted,
        send_status: e.send_status,
        send_blocked_reasons: e.send_blocked_reasons,
        handoff_required: e.handoff_required,
      })),
    },
  }, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });

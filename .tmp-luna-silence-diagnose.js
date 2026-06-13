'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const https = require('https');

const PHONE = '+491726422307';
const HOST = 'staff-staging.lunafrontdesk.com';

function az(c) { return execSync(c, { encoding: 'utf8' }).trim(); }

(async () => {
  const url = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const conv = await pg.query(
    `SELECT c.id::text, c.phone, c.needs_human, c.pending_action, c.bot_mode,
            c.metadata, c.updated_at::text, c.created_at::text
       FROM conversations c
       JOIN clients cl ON cl.id = c.client_id
      WHERE cl.slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(c.phone, ''), '+', '') = REPLACE($1, '+', '')`,
    [PHONE],
  );

  const convId = conv.rows[0] && conv.rows[0].id;

  let pause = { rows: [] };
  let staffHandoffs = { rows: [] };
  if (convId) {
    pause = await pg.query(
      `SELECT * FROM guest_bot_pause WHERE conversation_id = $1::uuid ORDER BY updated_at DESC LIMIT 3`,
      [convId],
    ).catch(() => ({ rows: [] }));

    staffHandoffs = await pg.query(
      `SELECT id::text, status, reason_code, opened_at::text
         FROM staff_handoffs WHERE conversation_id = $1::uuid ORDER BY opened_at DESC LIMIT 3`,
      [convId],
    ).catch(() => ({ rows: [] }));
  }

  const events = await pg.query(
    `SELECT created_at::text, message_text, send_attempted, send_status,
            suggested_reply, normalized->'open_demo_result'->>'whatsapp_sent' AS whatsapp_sent,
            normalized->'open_demo_result'->>'live_send_blocked' AS live_send_blocked,
            normalized->'open_demo_result'->>'review_ok' AS review_ok,
            normalized->'open_demo_result'->>'live_reply_gate_code' AS gate_code,
            normalized->'open_demo_result'->'effective_flags' AS flags
       FROM guest_message_events
      WHERE client_slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(from_phone, ''), '+', '') = REPLACE($1, '+', '')
      ORDER BY created_at DESC LIMIT 10`,
    [PHONE],
  );

  const sends = await pg.query(
    `SELECT created_at::text, status, LEFT(message_text, 120) AS preview
       FROM guest_message_sends
      WHERE client_slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(to_phone, ''), '+', '') = REPLACE($1, '+', '')
      ORDER BY created_at DESC LIMIT 5`,
    [PHONE],
  );

  const msgCount = convId
    ? (await pg.query(`SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1::uuid`, [convId])).rows[0].n
    : 0;

  const bookings = await pg.query(
    `SELECT booking_code, status::text, payment_status::text, updated_at::text
       FROM bookings WHERE phone IN ($1, REPLACE($1, '+', ''))
       ORDER BY updated_at DESC LIMIT 5`,
    [PHONE],
  );

  await pg.end();

  const token = az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
  const probeBody = JSON.stringify({
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    guest_phone: PHONE,
    message_text: 'Hi Luna',
    inbound_message_id: `probe-silence-${Date.now()}`,
  });

  const probe = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST,
      path: '/staff/bot/guest-inbound-review-dry-run',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(probeBody),
        Authorization: `Bearer ${token}`,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, raw }); }
      });
    });
    req.on('error', reject);
    req.write(probeBody);
    req.end();
  });

  console.log(JSON.stringify({
    healthz: az('curl.exe -s -o NUL -w "%{http_code}" https://' + HOST + '/healthz'),
    active_revision: JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'))
      .find((r) => r.properties.trafficWeight === 100)?.name,
    conversation: conv.rows[0] || null,
    message_count: msgCount,
    guest_bot_pause: pause.rows,
    staff_handoffs: staffHandoffs.rows,
    recent_events: events.rows,
    recent_sends: sends.rows,
    bookings: bookings.rows,
    probe_review: {
      status: probe.status,
      reply: probe.json && probe.json.review && probe.json.review.proposed_luna_reply,
      next_action: probe.json && probe.json.review && probe.json.review.proposed_next_action,
      handoff: probe.json && probe.json.review && probe.json.review.result && probe.json.review.result.safe_handoff_required,
    },
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

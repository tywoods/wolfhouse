'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
const https = require('https');

const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const CODE = 'WH-G27-48B58841E6';

function httpsJson(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: STAFF_HOST, path, method,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const url = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const b = await pg.query(
    `SELECT id::text, booking_code, status::text, check_in::text, check_out::text, guest_count,
            total_amount_cents, deposit_required_cents, amount_paid_cents, created_at::text, updated_at::text
       FROM bookings WHERE booking_code = $1`, [CODE]);
  const p = await pg.query(
    `SELECT id::text, status::text, stripe_checkout_session_id, amount_paid_cents
       FROM payments WHERE booking_id = $1::uuid ORDER BY created_at DESC LIMIT 1`, [b.rows[0] && b.rows[0].id]);
  const beds = b.rows[0]
    ? (await pg.query('SELECT bed_code, room_code FROM booking_beds WHERE booking_id = $1::uuid', [b.rows[0].id])).rows
    : [];
  const c = await pg.query(
    `SELECT conv.metadata->'luna_guest_context'->'result'->'cami_reply_author' AS cami,
            conv.metadata->'luna_guest_context'->'result'->'guest_agent_brain' AS agent
       FROM conversations conv
      INNER JOIN clients cl ON cl.id = conv.client_id
      WHERE cl.slug = $1 AND (conv.phone = $2 OR conv.phone = $3)
      ORDER BY conv.updated_at DESC LIMIT 1`, [CLIENT, '+34600995581', '34600995581']);
  await pg.end();

  console.log(JSON.stringify({ booking: b.rows[0], payment: p.rows[0], beds, conversation_obs: c.rows[0] }, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });

'use strict';
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const PROOF_START = new Date(Date.now() - 30 * 60 * 1000).toISOString();
const CLIENT = 'wolfhouse-somo';
const PHONE = '491726422307';

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
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const reset2 = await req('POST', '/staff/test/reset-luna-phone', { client_slug: CLIENT, phone: PHONE }, cookie);
  const whUrl = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const ev = await pg.query(
    'SELECT COUNT(*)::int AS n FROM guest_message_events WHERE client_slug = $1 AND REPLACE(COALESCE(from_phone, \'\'), \'+\', \'\') LIKE $2',
    [CLIENT, `%${PHONE}%`],
  );
  const se = await pg.query(
    'SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE client_slug = $1 AND REPLACE(COALESCE(to_phone, \'\'), \'+\', \'\') LIKE $2',
    [CLIENT, `%${PHONE}%`],
  );
  const sent = await pg.query(
    'SELECT id, status, created_at FROM guest_message_sends WHERE status = $1 AND created_at >= $2::timestamptz LIMIT 5',
    ['sent', PROOF_START],
  );
  await pg.end();
  console.log(JSON.stringify({
    repeat_reset: { status: reset2.status, body: reset2.body },
    db_after_repeat: { guest_message_events: ev.rows[0].n, guest_message_sends: se.rows[0].n },
    sent_since_proof_start: sent.rows,
  }, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });

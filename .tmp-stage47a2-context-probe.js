'use strict';
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const url = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: 'staff-staging.lunafrontdesk.com', path, method,
      headers: {
        Accept: 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, raw: buf, headers: res.headers }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const fixtures = await pg.query(`
    SELECT c.id::text AS conversation_id, c.phone,
           COUNT(*) FILTER (WHERE LOWER(b.status::text) IN ('cancelled','expired')) AS cancelled_n,
           COUNT(*) FILTER (WHERE LOWER(b.status::text) NOT IN ('cancelled','expired')) AS active_n
      FROM conversations c
      JOIN clients cl ON cl.id = c.client_id
      JOIN bookings b ON b.client_id = cl.id AND b.phone = c.phone
     WHERE cl.slug = 'wolfhouse-somo'
     GROUP BY c.id, c.phone
    HAVING COUNT(*) > 0
     ORDER BY active_n DESC, cancelled_n DESC
     LIMIT 10`);
  const anyHandoff = await pg.query(`
    SELECT conversation_id::text, status::text, reason_code, opened_at::text
      FROM staff_handoffs ORDER BY opened_at DESC LIMIT 5`);
  await pg.end();

  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo', email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');

  const results = [];
  for (const f of fixtures.rows.slice(0, 5)) {
    const ctx = await req('GET', `/staff/conversations/${f.conversation_id}/context?client=wolfhouse-somo`, null, cookie);
    let body = {};
    try { body = JSON.parse(ctx.raw); } catch { /* */ }
    results.push({
      conversation_id: f.conversation_id,
      phone: f.phone,
      cancelled_n: f.cancelled_n,
      active_n: f.active_n,
      status: ctx.status,
      bookings: (body.bookings || []).map((b) => ({ code: b.booking_code, status: b.status || b.booking_status })),
      error: body.error,
    });
  }

  console.log(JSON.stringify({ fixtures: fixtures.rows, any_handoffs: anyHandoff.rows, context_results: results }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

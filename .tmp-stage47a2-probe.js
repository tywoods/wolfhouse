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
  const handoffs = await pg.query(`
    SELECT sh.conversation_id::text, sh.status::text, sh.reason_code, c.phone, c.display_name
      FROM staff_handoffs sh
      JOIN conversations c ON c.id = sh.conversation_id
      JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = 'wolfhouse-somo'
       AND sh.status IN ('open','assigned','waiting_guest')
     ORDER BY sh.opened_at DESC LIMIT 5`);
  const needsHuman = await pg.query(`
    SELECT c.id::text, c.phone, c.needs_human
      FROM conversations c JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = 'wolfhouse-somo' AND c.needs_human = true LIMIT 5`);
  await pg.end();

  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo', email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');

  const mixedId = '8385725e-2681-481d-a5ef-4df01cac4af6';
  const ctx = await req('GET', `/staff/conversations/${mixedId}/context?client=wolfhouse-somo`, null, cookie);

  let handoffInbox = null;
  if (handoffs.rows[0]) {
    const id = handoffs.rows[0].conversation_id;
    const inbox = await req('GET', '/staff/conversations?client=wolfhouse-somo', null, cookie);
    const rows = JSON.parse(inbox.raw).conversations || [];
    handoffInbox = rows.find((r) => (r.conversation_id || r.id) === id) || null;
  }

  console.log(JSON.stringify({
    handoffs: handoffs.rows,
    needs_human: needsHuman.rows,
    context_mixed: { status: ctx.status, body: ctx.raw.slice(0, 800) },
    handoff_inbox_row: handoffInbox,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

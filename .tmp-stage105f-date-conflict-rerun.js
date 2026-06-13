'use strict';
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const MB = 'MB-WOLFHO-20260920-4f62e2';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
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
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const login = await new Promise((resolve, reject) => {
    const body = JSON.stringify({
      client: CLIENT,
      email: 'operator.stage72c@example.test',
      password: 'OperatorPass123!',
    });
    const r = https.request({
      hostname: HOST, path: '/staff/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        const ck = res.headers['set-cookie'];
        resolve({ cookie: ck ? ck.map((c) => c.split(';')[0]).join('; ') : '' });
      });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });

  const dbUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' }
  ).trim();
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const before = await pg.query(`
    SELECT b.check_in::text AS ci, b.check_out::text AS co
    FROM bookings b JOIN clients c ON c.id=b.client_id
    WHERE c.slug=$1 AND b.booking_code=$2
  `, [CLIENT, MB]);

  const conflictTarget = { check_in: '2026-09-05', check_out: '2026-09-10' };
  const dc = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: MB,
    edit_type: 'dates',
    ...conflictTarget,
    idempotency_key: 'stage105f-date-conflict-rerun-' + Date.now(),
  }, login.cookie);

  const after = await pg.query(`
    SELECT b.check_in::text AS ci, b.check_out::text AS co
    FROM bookings b JOIN clients c ON c.id=b.client_id
    WHERE c.slug=$1 AND b.booking_code=$2
  `, [CLIENT, MB]);
  await pg.end();

  const out = {
    before: before.rows[0],
    conflictTarget,
    status: dc.status,
    can_apply: dc.body && dc.body.can_apply,
    updated: dc.body && dc.body.updated,
    conflict_count: dc.body && dc.body.conflicts ? dc.body.conflicts.length : 0,
    conflicts: dc.body && dc.body.conflicts,
    after: after.rows[0],
    dates_unchanged: after.rows[0].ci === before.rows[0].ci && after.rows[0].co === before.rows[0].co,
    pass: dc.body && dc.body.can_apply === false && dc.body.updated === false &&
      (dc.body.conflicts || []).length > 0 && after.rows[0].ci === before.rows[0].ci,
  };
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

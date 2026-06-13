'use strict';
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const C = 'wolfhouse-somo';
const HOST = 'staff-staging.lunafrontdesk.com';

function login() {
  return new Promise((ok, no) => {
    const d = JSON.stringify({
      client: C, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
    });
    const r = https.request({
      hostname: HOST, path: '/staff/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': d.length },
    }, (res) => {
      const ck = res.headers['set-cookie'];
      res.on('data', () => {});
      res.on('end', () => ok(ck.map((x) => x.split(';')[0]).join('; ')));
    });
    r.write(d);
    r.end();
  });
}

function post(path, body, ck) {
  return new Promise((ok, no) => {
    const d = JSON.stringify(body);
    const r = https.request({
      hostname: HOST, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ck, 'Content-Length': d.length },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let p;
        try { p = JSON.parse(raw); } catch { p = raw; }
        ok({ status: res.statusCode, body: p });
      });
    });
    r.write(d);
    r.end();
  });
}

(async () => {
  const ck = await login();
  const url = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' }
  ).trim();
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const before = (await pg.query(`
    SELECT booking_code, package_code, check_in::text AS ci, check_out::text AS co, total_amount_cents
    FROM bookings b JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND booking_code = 'DEMO-2601'
  `, [C])).rows[0];
  const w = await post('/staff/bookings/edit?client=' + C, {
    client_slug: C,
    booking_code: 'DEMO-2601',
    edit_type: 'dates',
    check_in: '2026-06-10',
    check_out: '2026-06-14',
    idempotency_key: 'probe-short-' + Date.now(),
  }, ck);
  const after = (await pg.query(`
    SELECT package_code, check_in::text AS ci, check_out::text AS co, total_amount_cents
    FROM bookings b JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND booking_code = 'DEMO-2601'
  `, [C])).rows[0];
  console.log(JSON.stringify({ before, write: w, after }, null, 2));
  await pg.end();
})();

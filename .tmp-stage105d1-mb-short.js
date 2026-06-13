'use strict';
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const C = 'wolfhouse-somo';
const MB = 'MB-WOLFHO-20260920-4f62e2';
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

  await pg.query(`
    UPDATE bookings b SET package_code = NULL
    FROM clients c WHERE b.client_id = c.id AND c.slug = $1 AND b.booking_code = $2
  `, [C, MB]);

  const before = (await pg.query(`
    SELECT package_code, check_in::text ci, check_out::text co, total_amount_cents
    FROM bookings b JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND booking_code = $2
  `, [C, MB])).rows[0];

  const w = await post('/staff/bookings/edit?client=' + C, {
    client_slug: C,
    booking_code: MB,
    edit_type: 'dates',
    check_in: '2026-09-25',
    check_out: '2026-09-28',
    idempotency_key: 'mb-short-null-pkg-' + Date.now(),
  }, ck);

  const after = (await pg.query(`
    SELECT package_code, check_in::text ci, check_out::text co, total_amount_cents
    FROM bookings b JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND booking_code = $2
  `, [C, MB])).rows[0];

  const beds = (await pg.query(`
    SELECT bed_code, assignment_start_date::text ci, assignment_end_date::text co
    FROM booking_beds bb
    JOIN bookings b ON b.id = bb.booking_id
    JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
  `, [C, MB])).rows;

  console.log(JSON.stringify({
    before,
    write: { status: w.status, success: w.body.success, updated: w.body.updated, error: w.body.error,
      warnings: w.body.invoice_preview && w.body.invoice_preview.calculation_warnings,
      message: w.body.message },
    after,
    beds,
    pass: w.status === 200 && w.body.success && w.body.updated &&
      after.package_code == null && after.ci === '2026-09-25' && after.co === '2026-09-28' &&
      beds[0] && beds[0].ci === '2026-09-25',
  }, null, 2));

  await pg.end();
})();

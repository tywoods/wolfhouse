'use strict';
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const HOST = 'staff-staging.lunafrontdesk.com';
const C = 'wolfhouse-somo';
const DEMO = 'DEMO-2603';

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
        try { parsed = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const login = await new Promise((ok, no) => {
    const d = JSON.stringify({
      client: C, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
    });
    const r = https.request({
      hostname: HOST, path: '/staff/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': d.length },
    }, (res) => {
      const ck = res.headers['set-cookie'];
      res.on('data', () => {});
      res.on('end', () => ok((ck || []).map((x) => x.split(';')[0]).join('; ')));
    });
    r.on('error', no);
    r.write(d);
    r.end();
  });

  const url = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' }
  ).trim();
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const before = await pg.query(`
    SELECT guest_count, package_code, total_amount_cents, amount_paid_cents, balance_due_cents
    FROM bookings b JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND booking_code = $2
  `, [C, DEMO]);
  const bedsBefore = (await pg.query(`
    SELECT bb.id::text AS booking_bed_id, bb.bed_code
    FROM booking_beds bb
    JOIN bookings b ON b.id = bb.booking_id
    JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND booking_code = $2
    ORDER BY bb.assignment_start_date ASC, bb.id ASC
  `, [C, DEMO])).rows;

  const pkg = await req('POST', '/staff/bookings/edit?client=' + C, {
    client_slug: C, booking_code: DEMO, edit_type: 'package', package_code: 'malibu',
    idempotency_key: 'stage105e-demo-pkg-' + Date.now(),
  }, login);

  const gw = await req('POST', '/staff/bookings/edit?client=' + C, {
    client_slug: C, booking_code: DEMO, edit_type: 'guests', guest_count: 1,
    idempotency_key: 'stage105e-demo-guest-' + Date.now(),
  }, login);

  const after = await pg.query(`
    SELECT guest_count, package_code, total_amount_cents, amount_paid_cents, balance_due_cents
    FROM bookings b JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND booking_code = $2
  `, [C, DEMO]);
  const bedsAfter = (await pg.query(`
    SELECT bb.bed_code FROM booking_beds bb
    JOIN bookings b ON b.id = bb.booking_id
    JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND booking_code = $2
    ORDER BY bb.assignment_start_date ASC, bb.id ASC
  `, [C, DEMO])).rows;

  const pays = await pg.query(`
    SELECT p.id::text, p.status::text, p.amount_paid_cents
    FROM payments p
    JOIN bookings b ON b.id = p.booking_id
    JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND booking_code = $2
  `, [C, DEMO]);

  await pg.end();
  console.log(JSON.stringify({
    before: { booking: before.rows[0], beds: bedsBefore },
    package_write: { status: pkg.status, body: pkg.body },
    guest_write: { status: gw.status, body: gw.body },
    after: { booking: after.rows[0], beds: bedsAfter, payments: pays.rows },
    released: bedsBefore.filter((b) => !bedsAfter.some((a) => a.bed_code === b.bed_code)).map((b) => b.bed_code),
  }, null, 2));
})();

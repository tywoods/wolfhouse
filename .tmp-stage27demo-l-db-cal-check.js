'use strict';
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const CODE = 'WH-G27-0ECC1D9B57';
const PROOF_START = '2026-06-09T22:30:12.482Z';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const r = https.request({
      hostname: 'staff-staging.lunafrontdesk.com',
      path,
      method,
      headers,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(buf); } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const dbUrl = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const b = (await pg.query(`
    SELECT b.id::text, b.booking_code, b.status::text, b.payment_status::text,
           b.assignment_status::text, b.check_in::text, b.check_out::text, b.phone, b.confirmation_sent_at
      FROM bookings b
     INNER JOIN clients cl ON cl.id = b.client_id
     WHERE b.booking_code = $1`, [CODE])).rows[0];
  const beds = (await pg.query('SELECT bed_code, room_code, assignment_start_date::text, assignment_end_date::text FROM booking_beds WHERE booking_id = $1::uuid', [b.id])).rows;
  const pays = (await pg.query('SELECT id::text, status::text, checkout_url, stripe_checkout_session_id, payment_kind::text FROM payments WHERE booking_id = $1::uuid', [b.id])).rows;
  const sends = (await pg.query('SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE to_phone = $1 AND created_at >= $2::timestamptz', [b.phone, PROOF_START])).rows[0];
  await pg.end();

  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const cal = await req('GET', '/staff/bed-calendar?client=wolfhouse-somo&start=2026-09-01&end=2026-09-30', null, cookie);
  const blob = JSON.stringify(cal.body);
  console.log(JSON.stringify({
    booking: b,
    beds,
    payments: pays,
    guest_message_sends: sends.n,
    calendar_http: cal.status,
    calendar_has_booking: blob.includes(CODE) || blob.includes(b.id),
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

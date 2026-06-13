'use strict';
/** Send booking confirmation on staging for a paid booking. Temp — do not commit. */

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_CODE = process.argv[2] || 'WH-G27-4B909CD53A';
const EMAIL = 'operator.stage72c@example.test';
const PASS = 'OperatorPass123!';

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path,
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(headers || {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function login() {
  const res = await req('POST', '/staff/auth/login', { client: CLIENT, email: EMAIL, password: PASS });
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${res.raw}`);
  const cookie = (res.headers && res.headers['set-cookie'])
    ? [].concat(res.headers['set-cookie']).map((x) => x.split(';')[0]).join('; ')
    : '';
  if (!cookie) {
    const setCookie = res.body && res.body.set_cookie;
    if (setCookie) return setCookie;
  }
  return cookie;
}

function pgConn() {
  const url = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  return new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
}

async function backfillBooking(pg) {
  await pg.query(
    `UPDATE bookings b
        SET primary_room_code = COALESCE(NULLIF(TRIM(b.primary_room_code), ''), sub.room_code),
            metadata = COALESCE(b.metadata, '{}'::jsonb) || jsonb_build_object(
              'guest', COALESCE(b.metadata->'guest', '{}'::jsonb) || jsonb_build_object(
                'name', COALESCE(b.metadata->'guest'->>'name', b.guest_name),
                'phone', COALESCE(NULLIF(TRIM(b.metadata->'guest'->>'phone'), ''), NULLIF(TRIM(b.phone), '')),
                'email', COALESCE(b.metadata->'guest'->>'email', b.email)
              )
            )
      FROM (
        SELECT booking_id, room_code
          FROM booking_beds
         WHERE booking_id = (SELECT id FROM bookings WHERE booking_code = $1 LIMIT 1)
         ORDER BY created_at ASC
         LIMIT 1
      ) sub
     WHERE b.booking_code = $1
       AND b.id = sub.booking_id`,
    [BOOKING_CODE],
  );
  const row = (await pg.query(
    `SELECT booking_code, payment_status::text, confirmation_sent_at, primary_room_code,
            phone, metadata->'guest' AS guest
       FROM bookings WHERE booking_code = $1`,
    [BOOKING_CODE],
  )).rows[0];
  console.log('[backfill]', JSON.stringify(row, null, 2));
  return row;
}

async function main() {
  const pg = pgConn();
  await pg.connect();
  const row = await backfillBooking(pg);
  await pg.end();

  const toPhone = trimStr(row && row.phone)
    || trimStr(row && row.guest && row.guest.phone);
  if (!toPhone) throw new Error('no guest phone on booking');

  const cookie = await login();
  const res = await req('POST', '/staff/bot/bookings/send-confirmation', {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    to: toPhone,
    confirm_send: true,
    idempotency_key: `confirmation:manual:${BOOKING_CODE}:${Date.now()}`,
  }, { Cookie: cookie });

  console.log(JSON.stringify({ status: res.status, result: res.body }, null, 2));
  if (res.status !== 200 || !res.body || res.body.send_performed !== true) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

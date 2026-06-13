'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_CODE = 'MB-WOLFHO-20260920-4f62e2';
const TARGET_BED_B1 = '40477f5f-168c-4c58-9549-9ae7e4f067d6';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(raw) }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  const cookieStr = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  if (login.status !== 200 || !cookieStr) throw new Error('login failed');

  const pg = new Client({
    connectionString: execSync(
      'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
      { encoding: 'utf8' }
    ).trim(),
    ssl: { rejectUnauthorized: false },
  });
  await pg.connect();

  const countsBefore = (await pg.query(`
    SELECT
      (SELECT COUNT(*)::int FROM bookings b INNER JOIN clients c ON c.id = b.client_id WHERE c.slug = $1) AS bookings,
      (SELECT COUNT(*)::int FROM booking_beds bb INNER JOIN clients c ON c.id = bb.client_id WHERE c.slug = $1) AS booking_beds,
      (SELECT COUNT(*)::int FROM payments p INNER JOIN clients c ON c.id = p.client_id WHERE c.slug = $1) AS payments,
      (SELECT COUNT(*)::int FROM booking_service_records s WHERE s.client_slug = $1) AS service_records
  `, [CLIENT])).rows[0];

  const stateBefore = (await pg.query(`
    SELECT bb.bed_code FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
  `, [CLIENT, BOOKING_CODE])).rows;

  const move = await req('POST', '/staff/bookings/move', {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    target_bed_id: TARGET_BED_B1,
    check_in: '2026-09-20',
    check_out: '2026-09-23',
    idempotency_key: 'phase-10-3c-gate-off-after-proof',
    reason: 'Confirm gate disabled after Phase 10.3c proof',
  }, cookieStr);

  const countsAfter = (await pg.query(`
    SELECT
      (SELECT COUNT(*)::int FROM bookings b INNER JOIN clients c ON c.id = b.client_id WHERE c.slug = $1) AS bookings,
      (SELECT COUNT(*)::int FROM booking_beds bb INNER JOIN clients c ON c.id = bb.client_id WHERE c.slug = $1) AS booking_beds,
      (SELECT COUNT(*)::int FROM payments p INNER JOIN clients c ON c.id = p.client_id WHERE c.slug = $1) AS payments,
      (SELECT COUNT(*)::int FROM booking_service_records s WHERE s.client_slug = $1) AS service_records
  `, [CLIENT])).rows[0];

  const stateAfter = (await pg.query(`
    SELECT bb.bed_code FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
  `, [CLIENT, BOOKING_CODE])).rows;

  await pg.end();

  const b = move.body;
  const ok =
    move.status === 403 &&
    b.success === false &&
    b.enabled === false &&
    b.error === 'booking_move_write_disabled' &&
    b.moved === false &&
    b.would_mutate === false &&
    stateAfter[0]?.bed_code === 'DEMO-R1-B2' &&
    JSON.stringify(countsBefore) === JSON.stringify(countsAfter);

  console.log(JSON.stringify({
    revision: 'wh-staging-staff-api--0000057',
    image: 'whstagingacr.azurecr.io/wh-staff-api:0a1acbf-stage103c-move-write-gated',
    gate: 'BOOKING_MOVE_WRITE_ENABLED=false',
    blockedWrite: { status: move.status, body: b },
    bedCode: stateAfter[0]?.bed_code,
    countsBefore,
    countsAfter,
    ok,
    result: ok ? 'PASS' : 'FAIL',
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

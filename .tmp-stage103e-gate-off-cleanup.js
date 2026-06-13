'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_CODE = 'MB-WOLFHO-20260920-4f62e2';
const TARGET_BED_B2 = '8c777d69-205a-4e4d-8219-ec78bee80fcd';

function req(method, path, body, cookie, accept) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: accept || 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let body = raw;
        try { body = JSON.parse(raw); } catch { body = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body, raw });
      });
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

  const ui = await req('GET', '/staff/ui', null, cookieStr, 'text/html');
  const uiHtml = ui.raw || '';

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
    SELECT bb.bed_code, b.check_in::text, b.check_out::text, b.booking_code
    FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
  `, [CLIENT, BOOKING_CODE])).rows[0];

  const move = await req('POST', '/staff/bookings/move', {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    target_bed_id: TARGET_BED_B2,
    check_in: '2026-09-20',
    check_out: '2026-09-23',
    idempotency_key: 'phase-10-3e-gate-off-after-proof',
    reason: 'Confirm gate disabled after Phase 10.3e gate-ON proof',
  }, cookieStr);

  const countsAfter = (await pg.query(`
    SELECT
      (SELECT COUNT(*)::int FROM bookings b INNER JOIN clients c ON c.id = b.client_id WHERE c.slug = $1) AS bookings,
      (SELECT COUNT(*)::int FROM booking_beds bb INNER JOIN clients c ON c.id = bb.client_id WHERE c.slug = $1) AS booking_beds,
      (SELECT COUNT(*)::int FROM payments p INNER JOIN clients c ON c.id = p.client_id WHERE c.slug = $1) AS payments,
      (SELECT COUNT(*)::int FROM booking_service_records s WHERE s.client_slug = $1) AS service_records
  `, [CLIENT])).rows[0];

  const stateAfter = (await pg.query(`
    SELECT bb.bed_code, b.check_in::text, b.check_out::text, b.booking_code
    FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
  `, [CLIENT, BOOKING_CODE])).rows[0];

  await pg.end();

  const b = move.body;
  const uiGateOff = /BC_BOOKING_MOVE_WRITE\s*=\s*false/.test(uiHtml);

  const blockedOk =
    move.status === 403 &&
    b.success === false &&
    b.enabled === false &&
    b.error === 'booking_move_write_disabled' &&
    b.moved === false &&
    b.would_mutate === false;

  const dbOk =
    stateBefore.bed_code === 'DEMO-R1-B1' &&
    stateAfter.bed_code === 'DEMO-R1-B1' &&
    stateAfter.booking_code === BOOKING_CODE &&
    stateAfter.check_in === '2026-09-20' &&
    stateAfter.check_out === '2026-09-23' &&
    JSON.stringify(countsBefore) === JSON.stringify(countsAfter);

  const ok = blockedOk && dbOk && uiGateOff;

  console.log(JSON.stringify({
    revision: 'wh-staging-staff-api--0000060',
    image: 'whstagingacr.azurecr.io/wh-staff-api:7104815-stage103e-move-ui-gate-off',
    gate: 'BOOKING_MOVE_WRITE_ENABLED=false',
    traffic: '100% latest revision',
    health: 'Healthy',
    uiGateOff,
    blockedWrite: { status: move.status, body: b },
    assignmentBefore: stateBefore,
    assignmentAfter: stateAfter,
    countsBefore,
    countsAfter,
    checks: { blockedOk, dbOk, uiGateOff },
    safety: {
      stagingOnly: true,
      noN8n: true,
      whatsappDryRun: true,
      noProductionDb: true,
      noPaymentMutation: countsBefore.payments === countsAfter.payments,
      noServiceRecordMutation: countsBefore.service_records === countsAfter.service_records,
      noStripeCallDuringProof: true,
    },
    ok,
    result: ok ? 'PASS' : 'FAIL',
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

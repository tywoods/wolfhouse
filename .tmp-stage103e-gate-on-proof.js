'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_CODE = 'MB-WOLFHO-20260920-4f62e2';
const TARGET_B1 = '40477f5f-168c-4c58-9549-9ae7e4f067d6';
const TARGET_B2 = '8c777d69-205a-4e4d-8219-ec78bee80fcd';
const CHECK_IN = '2026-09-20';
const CHECK_OUT = '2026-09-23';
const IDEM_KEY = 'phase-10-3e-ui-gate-on-move-b2-to-b1';

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
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function getStagingDbUrl() {
  return execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  ).trim();
}

async function counts(pg) {
  const r = await pg.query(`
    SELECT
      (SELECT COUNT(*)::int FROM bookings b INNER JOIN clients c ON c.id = b.client_id WHERE c.slug = $1) AS bookings,
      (SELECT COUNT(*)::int FROM booking_beds bb INNER JOIN clients c ON c.id = bb.client_id WHERE c.slug = $1) AS booking_beds,
      (SELECT COUNT(*)::int FROM payments p INNER JOIN clients c ON c.id = p.client_id WHERE c.slug = $1) AS payments,
      (SELECT COUNT(*)::int FROM booking_service_records s WHERE s.client_slug = $1) AS service_records
  `, [CLIENT]);
  return r.rows[0];
}

async function assignment(pg) {
  const r = await pg.query(`
    SELECT b.booking_code, b.check_in::text, b.check_out::text, bb.bed_code, bb.bed_id::text AS bed_id
    FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
  `, [CLIENT, BOOKING_CODE]);
  return r.rows[0] || null;
}

(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  if (login.status !== 200) throw new Error('login failed');

  const ui = await req('GET', '/staff/ui', null, cookie, 'text/html');
  const uiHtml = ui.raw || '';

  const pg = new Client({ connectionString: getStagingDbUrl(), ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const countsBefore = await counts(pg);
  const assignBefore = await assignment(pg);

  const moveBody = {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    target_bed_id: TARGET_B1,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
    idempotency_key: IDEM_KEY,
    reason: 'Moved from Staff Portal booking drawer',
  };

  const preview = await req('POST', '/staff/bookings/move-preview', {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    target_bed_id: TARGET_B1,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
  }, cookie);

  const move = await req('POST', '/staff/bookings/move', moveBody, cookie);
  const idem = await req('POST', '/staff/bookings/move', moveBody, cookie);

  const countsAfterMove = await counts(pg);
  const assignAfterMove = await assignment(pg);
  await pg.end();

  const pb = preview.body;
  const mb = move.body;
  const ib = idem.body;

  const uiGateOn = {
    bcBookingMoveWriteTrue: /BC_BOOKING_MOVE_WRITE\s*=\s*true/.test(uiHtml),
    moveBtnGating: /moveBtn\.disabled = busy \|\| !bcMoveCtx\.previewCanMove \|\| !BC_BOOKING_MOVE_WRITE/.test(uiHtml),
    moveInFlight: /bcMoveCtx\.moveInFlight/.test(uiHtml),
    noGateOffBannerWhenTrue: !(/BC_BOOKING_MOVE_WRITE\s*=\s*true/.test(uiHtml) && /Move controls are disabled/.test(uiHtml.slice(uiHtml.indexOf('BC_BOOKING_MOVE_WRITE'), uiHtml.indexOf('BC_BOOKING_MOVE_WRITE') + 200))),
  };

  const previewOk =
    preview.status === 200 &&
    pb.success === true &&
    pb.can_move === true &&
    /Move preview passed\. No changes were made\./.test(pb.message || '');

  const moveOk =
    move.status === 200 &&
    mb.success === true &&
    mb.moved === true &&
    mb.previous_assignment && mb.previous_assignment.bed_code === 'DEMO-R1-B2' &&
    mb.new_assignment && mb.new_assignment.bed_code === 'DEMO-R1-B1' &&
    /No payment, service, or message changes were made/.test(mb.message || '');

  const idemOk =
    idem.status === 200 &&
    ib.success === true &&
    ib.moved === false &&
    ib.idempotent === true;

  const dbOk =
    assignBefore && assignBefore.bed_code === 'DEMO-R1-B2' &&
    assignAfterMove && assignAfterMove.bed_code === 'DEMO-R1-B1' &&
    assignAfterMove.booking_code === BOOKING_CODE &&
    assignAfterMove.check_in === CHECK_IN &&
    assignAfterMove.check_out === CHECK_OUT &&
    countsBefore.bookings === countsAfterMove.bookings &&
    countsBefore.booking_beds === countsAfterMove.booking_beds &&
    countsBefore.payments === countsAfterMove.payments &&
    countsBefore.service_records === countsAfterMove.service_records;

  const ok = Object.values(uiGateOn).every(Boolean) && previewOk && moveOk && idemOk && dbOk;

  console.log(JSON.stringify({
    deploy: {
      commit: '7104815',
      image: 'whstagingacr.azurecr.io/wh-staff-api:7104815-stage103e-move-ui-gate-off',
      revision: 'wh-staging-staff-api--0000059',
      gate: 'BOOKING_MOVE_WRITE_ENABLED=true',
    },
    uiGateOn,
    assignmentBefore: assignBefore,
    assignmentAfterMove: assignAfterMove,
    countsBefore,
    countsAfterMove,
    preview: { status: preview.status, body: pb },
    move: { status: move.status, body: mb },
    idempotency: { status: idem.status, body: ib },
    checks: { previewOk, moveOk, idemOk, dbOk },
    result: ok ? 'PASS' : 'PARTIAL',
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

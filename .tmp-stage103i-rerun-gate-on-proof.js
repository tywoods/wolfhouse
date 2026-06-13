'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_CODE = 'DEMO-2603';
const CHECK_IN = '2026-07-16';
const CHECK_OUT = '2026-07-22';
const SOURCE_BOOKING_BED_ID = 'b24abf1e-e628-48c3-aa31-384d8ed1c7c7';
const SIBLING_BOOKING_BED_ID = 'aabd40a8-a8aa-4da4-9ea6-3d010931745d';
const TARGET_BED_ID = 'b13b5924-d58c-4bd2-92fc-624f7c354c16';
const IDEM_KEY = 'phase-10-3i-rerun-b1-to-r2b1';

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

async function assignments(pg) {
  const r = await pg.query(`
    SELECT bb.id::text AS booking_bed_id, bb.bed_id::text AS bed_id, bb.bed_code, bb.room_code,
           b.booking_code, b.guest_name, b.check_in::text AS check_in, b.check_out::text AS check_out
    FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = bb.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    ORDER BY bb.bed_code ASC
  `, [CLIENT, BOOKING_CODE]);
  return r.rows;
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
  const assignBefore = await assignments(pg);

  const moveBody = {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    booking_bed_id: SOURCE_BOOKING_BED_ID,
    target_bed_id: TARGET_BED_ID,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
    idempotency_key: IDEM_KEY,
    reason: 'Moved from Staff Portal booking drawer',
  };

  const move = await req('POST', '/staff/bookings/move', moveBody, cookie);
  const idem = await req('POST', '/staff/bookings/move', moveBody, cookie);

  const countsAfterMove = await counts(pg);
  const assignAfterMove = await assignments(pg);
  await pg.end();

  const mb = move.body || {};
  const ib = idem.body || {};

  const sourceBefore = assignBefore.find((a) => a.booking_bed_id === SOURCE_BOOKING_BED_ID);
  const siblingBefore = assignBefore.find((a) => a.booking_bed_id === SIBLING_BOOKING_BED_ID);
  const sourceAfter = assignAfterMove.find((a) => a.booking_bed_id === SOURCE_BOOKING_BED_ID);
  const siblingAfter = assignAfterMove.find((a) => a.booking_bed_id === SIBLING_BOOKING_BED_ID);

  const uiGateOn = {
    bcBookingMoveWriteTrue: /BC_BOOKING_MOVE_WRITE\s*=\s*true/.test(uiHtml),
    noPreviewButton: !/id="bc-move-preview-btn"/.test(uiHtml),
    hasAvailableOnlyHelper: /Only available target beds are shown/.test(uiHtml),
    hasWriteReadyGate: /bcMoveInputsReadyForWrite/.test(uiHtml),
  };

  const moveOk =
    move.status === 200 &&
    mb.success === true &&
    mb.moved === true &&
    mb.previous_assignment?.bed_code === 'DEMO-R1-B1' &&
    mb.new_assignment?.bed_code === 'DEMO-R2-B1' &&
    /No payment, service, or message changes were made/.test(mb.message || '');

  const idemOk =
    idem.status === 200 &&
    ib.success === true &&
    ib.moved === false &&
    ib.idempotent === true;

  const siblingOk =
    siblingBefore?.bed_code === 'DEMO-R1-B2' &&
    siblingAfter?.bed_code === 'DEMO-R1-B2' &&
    siblingAfter?.bed_id === siblingBefore?.bed_id;

  const sourceMovedOk =
    sourceBefore?.bed_code === 'DEMO-R1-B1' &&
    sourceAfter?.bed_code === 'DEMO-R2-B1' &&
    sourceAfter?.bed_id === TARGET_BED_ID &&
    sourceAfter?.booking_bed_id === SOURCE_BOOKING_BED_ID;

  const dbCountsOk =
    countsBefore.bookings === countsAfterMove.bookings &&
    countsBefore.booking_beds === countsAfterMove.booking_beds &&
    countsBefore.payments === countsAfterMove.payments &&
    countsBefore.service_records === countsAfterMove.service_records &&
    sourceAfter?.check_in === CHECK_IN &&
    sourceAfter?.check_out === CHECK_OUT &&
    sourceAfter?.booking_code === BOOKING_CODE;

  const ok = Object.values(uiGateOn).every(Boolean) && moveOk && idemOk && siblingOk && sourceMovedOk && dbCountsOk;

  console.log(JSON.stringify({
    deploy: {
      commit: '636aac2ba74cc12e7e57217684fee907f076e9da',
      image: 'whstagingacr.azurecr.io/wh-staff-api:636aac2-stage103i-assignment-move-fix',
      acrRun: 'cb1s',
      fixRevisionGateOff: 'wh-staging-staff-api--0000069',
      gateOnRevision: 'wh-staging-staff-api--0000070',
    },
    uiGateOn,
    assignmentsBefore: assignBefore,
    assignmentsAfterMove: assignAfterMove,
    countsBefore,
    countsAfterMove,
    move: { status: move.status, body: mb },
    idempotency: { status: idem.status, body: ib },
    checks: { moveOk, idemOk, siblingOk, sourceMovedOk, dbCountsOk },
    result: ok ? 'PASS' : 'PARTIAL',
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

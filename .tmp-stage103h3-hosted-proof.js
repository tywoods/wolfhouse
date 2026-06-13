'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_CODE = 'DEMO-2603';
const CHECK_IN = '2026-07-16';
const CHECK_OUT = '2026-07-22';

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

async function bookingAssignments(pg) {
  const r = await pg.query(`
    SELECT bb.id::text AS booking_bed_id, bb.bed_id::text AS bed_id, bb.bed_code, bb.room_code
    FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    ORDER BY bb.bed_code ASC
  `, [CLIENT, BOOKING_CODE]);
  return r.rows;
}

(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  if (login.status !== 200) throw new Error('login failed: ' + login.status);

  const uiRes = await req('GET', '/staff/ui', null, cookie);
  const uiHtml = uiRes.raw;

  const pg = new Client({ connectionString: getStagingDbUrl(), ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const countsBefore = await counts(pg);
  const assignmentsBefore = await bookingAssignments(pg);
  const selected = assignmentsBefore.find((a) => a.bed_code === 'DEMO-R1-B1');
  const targetFree = (await pg.query(`
    SELECT bd.id::text AS bed_id FROM beds bd
    INNER JOIN clients c ON c.id = bd.client_id
    WHERE c.slug = $1 AND bd.bed_code = 'DEMO-R2-B1' LIMIT 1
  `, [CLIENT])).rows[0];
  const targetOccupied = selected.bed_id;

  const previewOk = await req('POST', '/staff/bookings/move-preview', {
    client_slug: CLIENT, booking_code: BOOKING_CODE,
    booking_bed_id: selected.booking_bed_id, target_bed_id: targetFree.bed_id,
    check_in: CHECK_IN, check_out: CHECK_OUT,
  }, cookie);

  const previewConflict = await req('POST', '/staff/bookings/move-preview', {
    client_slug: CLIENT, booking_code: BOOKING_CODE,
    booking_bed_id: selected.booking_bed_id, target_bed_id: targetOccupied,
    check_in: CHECK_IN, check_out: CHECK_OUT,
  }, cookie);

  const moveGateOff = await req('POST', '/staff/bookings/move', {
    client_slug: CLIENT, booking_code: BOOKING_CODE,
    booking_bed_id: selected.booking_bed_id, target_bed_id: targetFree.bed_id,
    check_in: CHECK_IN, check_out: CHECK_OUT,
    idempotency_key: 'phase-10-3h3-gate-off-clean-ui-proof',
    reason: 'Phase 10.3h.3 hosted proof',
  }, cookie);

  const assignmentsAfter = await bookingAssignments(pg);
  const countsAfter = await counts(pg);
  await pg.end();

  const uiChecks = {
    noPreviewHelperCopy: !/Preview does not change anything/.test(uiHtml),
    noCurrentBedLabel: !/Current bed/.test(uiHtml.match(/function bcRenderMoveSourcePillsHtml[\s\S]*?\n\}/)?.[0] || ''),
    hasChooseCopy: /Choose which current bed to move/.test(uiHtml),
    hasBcClearMoveResult: /function bcClearMoveResult/.test(uiHtml),
    noSuccessRenderOnCanMove: /if \(b\.can_move\)\{\s*bcClearMoveResult\(\)/.test(uiHtml),
    gateOffEmbedded: /BC_BOOKING_MOVE_WRITE\s*=\s*false/.test(uiHtml),
  };

  const pOk = previewOk.body;
  const pBad = previewConflict.body;
  const m = moveGateOff.body;

  const ok =
    Object.values(uiChecks).every(Boolean) &&
    previewOk.status === 200 && pOk.success && pOk.can_move === true &&
    previewConflict.status === 200 && pOk.success && (pBad.can_move === false || (pBad.conflicts && pBad.conflicts.length > 0)) &&
    moveGateOff.status === 403 && m.error === 'booking_move_write_disabled' &&
    JSON.stringify(countsBefore) === JSON.stringify(countsAfter) &&
    JSON.stringify(assignmentsBefore) === JSON.stringify(assignmentsAfter);

  console.log(JSON.stringify({
    deploy: {
      commit: 'e5926b02d6fd56829590e6c271ccc2489a53986e',
      image: 'whstagingacr.azurecr.io/wh-staff-api:e5926b0-stage103h3-clean-move-ui',
      acrRun: 'cb1q',
      revision: 'wh-staging-staff-api--0000065',
      gate: 'BOOKING_MOVE_WRITE_ENABLED=false',
    },
    uiChecks,
    previewOk: { status: previewOk.status, booking_bed_id: selected.booking_bed_id, body: pOk },
    previewConflict: { status: previewConflict.status, target_bed_id: targetOccupied, body: pBad },
    moveGateOff: { status: moveGateOff.status, body: m },
    countsBefore, countsAfter, assignmentsBefore, assignmentsAfter,
    result: ok ? 'PASS' : 'PARTIAL',
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

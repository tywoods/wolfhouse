'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_CODE = 'MB-WOLFHO-20260920-4f62e2';
const TARGET_B1 = '40477f5f-168c-4c58-9549-9ae7e4f067d6';
const CHECK_IN = '2026-09-20';
const CHECK_OUT = '2026-09-23';
const EXPECTED_BED = 'DEMO-R1-B2';

function req(method, path, body, cookie, accept) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path,
      method,
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
        if ((accept || '').includes('json') || path.includes('/staff/bookings/') || path.includes('/staff/auth/')) {
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        }
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
    SELECT bb.bed_code, bb.bed_id::text AS bed_id
    FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
  `, [CLIENT, BOOKING_CODE]);
  return r.rows[0] || null;
}

(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  if (login.status !== 200) throw new Error('login failed');

  const ui = await req('GET', '/staff/ui', null, cookie, 'text/html');
  const uiHtml = ui.raw || '';

  const pg = new Client({ connectionString: getStagingDbUrl(), ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const countsBefore = await counts(pg);
  const assignBefore = await assignment(pg);

  const preview = await req('POST', '/staff/bookings/move-preview', {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    target_bed_id: TARGET_B1,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
  }, cookie);

  const moveAttempt = await req('POST', '/staff/bookings/move', {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    target_bed_id: TARGET_B1,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
    idempotency_key: 'phase-10-3e-ui-gate-off-proof',
    reason: 'Phase 10.3e UI gate-off proof',
  }, cookie);

  const countsAfter = await counts(pg);
  const assignAfter = await assignment(pg);
  await pg.end();

  const pb = preview.body;
  const mb = moveAttempt.body;

  const uiPanel = {
    moveBedSection: /Move bed/.test(uiHtml),
    bcMoveBed: /id="bc-move-bed"/.test(uiHtml),
    previewBtn: /id="bc-move-preview-btn"/.test(uiHtml) && /Preview move/.test(uiHtml),
    moveBtn: /id="bc-move-booking-btn"/.test(uiHtml) && /Move booking/.test(uiHtml),
    moveBtnDisabledHtml: /bc-move-booking-btn" disabled/.test(uiHtml),
    safetyPreviewCopy: /Preview does not change anything/.test(uiHtml),
    safetySameDate: /same-date bed move only/.test(uiHtml),
    safetyNoDates: /Date changes are not supported here/.test(uiHtml),
    gateOffBanner: /Move controls are disabled/.test(uiHtml),
    bcBookingMoveWriteFalse: /BC_BOOKING_MOVE_WRITE\s*=\s*false/.test(uiHtml),
    noConfirmMove: !/Confirm Move/.test(uiHtml),
    noDragDrop: !/drag.?drop.*move|bcDragMove/i.test(uiHtml),
    noStripeInMoveUi: !/api\.stripe\.com/.test(uiHtml.slice(uiHtml.indexOf('bc-move-preview-btn') - 500, uiHtml.indexOf('bcRunMoveWrite') + 2000)),
    noWhatsAppInMoveUi: !/graph\.facebook\.com/.test(uiHtml.slice(uiHtml.indexOf('bc-move-preview-btn') - 500, uiHtml.indexOf('bcRunMoveWrite') + 2000)),
  };

  const previewOk =
    preview.status === 200 &&
    pb.success === true &&
    pb.can_move === true &&
    pb.preview_only === true &&
    /No changes were made/.test(pb.message || '');

  const gateOffOk =
    moveAttempt.status === 403 &&
    mb.error === 'booking_move_write_disabled' &&
    mb.enabled === false;

  const unchangedOk =
    assignBefore && assignAfter &&
    assignBefore.bed_code === EXPECTED_BED &&
    assignAfter.bed_code === EXPECTED_BED &&
    JSON.stringify(countsBefore) === JSON.stringify(countsAfter);

  const uiGateLogicOk =
    /moveBtn\.disabled = busy \|\| !bcMoveCtx\.previewCanMove \|\| !BC_BOOKING_MOVE_WRITE/.test(uiHtml);

  const ok = Object.values(uiPanel).every(Boolean) && previewOk && gateOffOk && unchangedOk && uiGateLogicOk;

  console.log(JSON.stringify({
    deploy: {
      commit: '7104815',
      image: 'whstagingacr.azurecr.io/wh-staff-api:7104815-stage103e-move-ui-gate-off',
      acrRun: 'cb1j',
      revision: 'wh-staging-staff-api--0000058',
      gate: 'BOOKING_MOVE_WRITE_ENABLED=false',
    },
    uiPanel,
    uiGateLogicOk,
    assignmentBefore: assignBefore,
    assignmentAfter: assignAfter,
    countsBefore,
    countsAfter,
    preview: { status: preview.status, body: pb },
    moveAttempt: { status: moveAttempt.status, body: mb },
    checks: { previewOk, gateOffOk, unchangedOk },
    result: ok ? 'PASS' : 'PARTIAL',
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

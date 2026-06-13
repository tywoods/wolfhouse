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
    SELECT bb.id::text AS booking_bed_id, bb.bed_id::text AS bed_id, bb.bed_code, bb.room_code,
           b.guest_name, b.check_in::text AS check_in, b.check_out::text AS check_out
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
  const sourceB1 = assignmentsBefore.find((a) => a.bed_code === 'DEMO-R1-B1');
  const sourceB2 = assignmentsBefore.find((a) => a.bed_code === 'DEMO-R1-B2');
  const targetR2B1 = (await pg.query(`
    SELECT bd.id::text AS bed_id, bd.bed_code, r.room_code
    FROM beds bd
    INNER JOIN clients c ON c.id = bd.client_id
    INNER JOIN rooms r ON r.id = bd.room_id AND r.client_id = bd.client_id
    WHERE c.slug = $1 AND bd.bed_code = 'DEMO-R2-B1' LIMIT 1
  `, [CLIENT])).rows[0];

  const moveTargets = await req('POST', '/staff/bookings/move-targets', {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    booking_bed_id: sourceB1.booking_bed_id,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
  }, cookie);

  const moveGateOff = await req('POST', '/staff/bookings/move', {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    booking_bed_id: sourceB1.booking_bed_id,
    target_bed_id: targetR2B1.bed_id,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
    idempotency_key: 'phase-10-3h5-gate-off-available-targets-proof',
    reason: 'Phase 10.3h.5 hosted proof',
  }, cookie);

  const assignmentsAfter = await bookingAssignments(pg);
  const countsAfter = await counts(pg);
  await pg.end();

  const mt = moveTargets.body || {};
  const availableTargets = (mt.targets || []).filter((t) => t.available);
  const unavailableShown = (mt.targets || []).filter((t) => !t.available);
  const sourceInTargets = (mt.targets || []).some((t) => t.bed_id === sourceB1.bed_id && t.is_current_source);
  const sourceSelectable = availableTargets.some((t) => t.bed_id === sourceB1.bed_id);
  const targetR2Available = availableTargets.some((t) => t.bed_code === 'DEMO-R2-B1');

  const uiChecks = {
    hasChooseCopy: /Choose which current bed to move/.test(uiHtml),
    hasSourcePillClass: /\.bc-move-source-pill/.test(uiHtml),
    noPreviewButton: !/id="bc-move-preview-btn"/.test(uiHtml) && !/>Preview move</.test(uiHtml),
    hasMoveBookingBtn: /id="bc-move-booking-btn"/.test(uiHtml),
    hasMoveTargetsCall: /\/staff\/bookings\/move-targets/.test(uiHtml),
    hasAvailableOnlyHelper: /Only available target beds are shown/.test(uiHtml),
    noPreviewCanMoveGate: !/previewCanMove/.test(uiHtml.match(/function bcUpdateMoveButtons[\s\S]*?\n\}/)?.[0] || ''),
    hasWriteReadyGate: /bcMoveInputsReadyForWrite/.test(uiHtml),
    gateOffEmbedded: /BC_BOOKING_MOVE_WRITE\s*=\s*false/.test(uiHtml),
    gateOffBanner: /Move controls are disabled/.test(uiHtml),
    noMovePreviewUiCall: !/\/staff\/bookings\/move-preview/.test(uiHtml.match(/\/\* ── Phase 10\.3e — booking drawer move bed[\s\S]*?function bcInitMovePanel[\s\S]*?\n\}/)?.[0] || ''),
    noStripe: !/api\.stripe\.com/.test(uiHtml),
    noWhatsApp: !/graph\.facebook\.com/.test(uiHtml),
  };

  const m = moveGateOff.body || {};
  const bookingOk = assignmentsBefore.length === 2 &&
    sourceB1 && sourceB2 &&
    sourceB1.check_in === CHECK_IN && sourceB1.check_out === CHECK_OUT;

  const ok =
    bookingOk &&
    Object.values(uiChecks).every(Boolean) &&
    moveTargets.status === 200 && mt.success === true && mt.preview_only === true && mt.would_mutate === false &&
    Array.isArray(mt.targets) && mt.targets.length > 0 &&
    sourceInTargets && !sourceSelectable && targetR2Available &&
    unavailableShown.every((t) => !t.available) &&
    moveGateOff.status === 403 && m.error === 'booking_move_write_disabled' && m.moved === false && m.would_mutate === false &&
    JSON.stringify(countsBefore) === JSON.stringify(countsAfter) &&
    JSON.stringify(assignmentsBefore) === JSON.stringify(assignmentsAfter);

  console.log(JSON.stringify({
    deploy: {
      commit: '7a5f423243c8de163f4530f80eaf3557b113a4a0',
      image: 'whstagingacr.azurecr.io/wh-staff-api:7a5f423-stage103h5-available-move-targets',
      acrRun: 'cb1r',
      revision: 'wh-staging-staff-api--0000066',
      gate: 'BOOKING_MOVE_WRITE_ENABLED=false',
    },
    booking: {
      code: BOOKING_CODE,
      guest: sourceB1?.guest_name,
      check_in: CHECK_IN,
      check_out: CHECK_OUT,
      assignmentsBefore,
    },
    uiChecks,
    moveTargets: {
      status: moveTargets.status,
      booking_bed_id_sent: sourceB1.booking_bed_id,
      preview_only: mt.preview_only,
      would_mutate: mt.would_mutate,
      target_count: (mt.targets || []).length,
      available_count: availableTargets.length,
      available_bed_codes: availableTargets.map((t) => t.bed_code),
      source_is_current_source: sourceInTargets,
      source_not_in_available_list: !sourceSelectable,
      demo_r2_b1_available: targetR2Available,
      sample_unavailable: unavailableShown.slice(0, 3).map((t) => ({
        bed_code: t.bed_code, disabled_reason: t.disabled_reason, available: t.available,
      })),
    },
    moveGateOff: { status: moveGateOff.status, body: m },
    countsBefore, countsAfter,
    assignmentsUnchanged: JSON.stringify(assignmentsBefore) === JSON.stringify(assignmentsAfter),
    result: ok ? 'PASS' : 'PARTIAL',
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

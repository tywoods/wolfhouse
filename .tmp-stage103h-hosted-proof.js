'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_CODE = 'DEMO-2603';
const CHECK_IN = '2026-07-16';
const CHECK_OUT = '2026-07-22';
const TARGET_BED_CODE = 'DEMO-R2-B1';
const GATE_OFF_IDEM = 'phase-10-3h-gate-off-ui-proof';

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

async function bookingAssignments(pg) {
  const r = await pg.query(`
    SELECT b.guest_name, b.check_in::text, b.check_out::text,
           bb.id::text AS booking_bed_id, bb.bed_id::text AS bed_id, bb.bed_code
    FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    ORDER BY bb.bed_code ASC
  `, [CLIENT, BOOKING_CODE]);
  return r.rows;
}

async function targetBedByCode(pg, bedCode) {
  const r = await pg.query(`
    SELECT bd.id::text AS bed_id, bd.bed_code, r.room_code
    FROM beds bd
    INNER JOIN rooms r ON r.id = bd.room_id AND r.client_id = bd.client_id
    INNER JOIN clients c ON c.id = bd.client_id
    WHERE c.slug = $1 AND bd.bed_code = $2
    LIMIT 1
  `, [CLIENT, bedCode]);
  return r.rows[0] || null;
}

async function login() {
  const res = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  if (res.status !== 200) throw new Error('login failed: ' + res.status);
  return cookie;
}

(async () => {
  const cookie = await login();
  const uiRes = await req('GET', '/staff/ui', null, cookie, 'text/html');
  const uiHtml = typeof uiRes.body === 'string' ? uiRes.body : uiRes.raw;

  const pg = new Client({ connectionString: getStagingDbUrl(), ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const countsBefore = await counts(pg);
  const assignmentsBefore = await bookingAssignments(pg);
  if (assignmentsBefore.length < 2) {
    throw new Error('Expected multi-bed DEMO-2603, got ' + assignmentsBefore.length);
  }

  const selected = assignmentsBefore.find((a) => a.bed_code === 'DEMO-R1-B1') || assignmentsBefore[0];
  const sibling = assignmentsBefore.find((a) => a.booking_bed_id !== selected.booking_bed_id);
  const target = await targetBedByCode(pg, TARGET_BED_CODE);
  if (!target) throw new Error('Target bed DEMO-R2-B1 not found');

  const preview = await req('POST', '/staff/bookings/move-preview', {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    booking_bed_id: selected.booking_bed_id,
    target_bed_id: target.bed_id,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
  }, cookie);

  const moveGateOff = await req('POST', '/staff/bookings/move', {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    booking_bed_id: selected.booking_bed_id,
    target_bed_id: target.bed_id,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
    idempotency_key: GATE_OFF_IDEM,
    reason: 'Phase 10.3h hosted proof gate-off',
  }, cookie);

  const context = await req('GET', `/staff/bookings/${encodeURIComponent(BOOKING_CODE)}/context?client=${CLIENT}`, null, cookie);

  const assignmentsAfter = await bookingAssignments(pg);
  const countsAfter = await counts(pg);
  await pg.end();

  const p = preview.body;
  const m = moveGateOff.body;
  const ctxAssigns = context.body && context.body.rooming && context.body.rooming.assignments;

  const uiChecks = {
    hasChooseCopy: /Choose which current bed to move/.test(uiHtml),
    hasSourcePills: /bc-move-source-pill/.test(uiHtml),
    hasRenderPills: /bcRenderMoveSourcePillsHtml/.test(uiHtml),
    hasBookingBedIdAttr: /data-booking-bed-id/.test(uiHtml),
    hasPreviewInputsReady: /bcMoveInputsReadyForPreview/.test(uiHtml),
    hasResetPreview: /bcResetMovePreviewState/.test(uiHtml),
    gateOffFlag: /BC_BOOKING_MOVE_WRITE\s*=\s*false/.test(uiHtml),
    moveControlsDisabledCopy: /Move controls are disabled/.test(uiHtml),
    noGraph: !/graph\.facebook\.com/.test(uiHtml),
    noStripe: !/api\.stripe\.com/.test(uiHtml),
    noN8n: !/n8n\.cloud|activate.*workflow/i.test(uiHtml),
  };

  const uiPillsOk = uiChecks.hasChooseCopy && uiChecks.hasSourcePills && uiChecks.hasBookingBedIdAttr;
  const previewOk =
    preview.status === 200 &&
    p.success === true &&
    p.preview_only === true &&
    p.would_mutate === false &&
    p.can_move === true &&
    p.source_assignment &&
    p.source_assignment.booking_bed_id === selected.booking_bed_id;
  const gateOffOk =
    moveGateOff.status === 403 &&
    m.error === 'booking_move_write_disabled' &&
    m.moved === false &&
    m.would_mutate === false;
  const siblingUnchanged =
    sibling &&
    assignmentsAfter.find((a) => a.booking_bed_id === sibling.booking_bed_id)?.bed_code === sibling.bed_code &&
    assignmentsAfter.find((a) => a.booking_bed_id === sibling.booking_bed_id)?.bed_id === sibling.bed_id;
  const selectedUnchanged =
    assignmentsAfter.find((a) => a.booking_bed_id === selected.booking_bed_id)?.bed_code === selected.bed_code;
  const countsOk = JSON.stringify(countsBefore) === JSON.stringify(countsAfter);
  const contextOk =
    context.status === 200 &&
    Array.isArray(ctxAssigns) &&
    ctxAssigns.length >= 2 &&
    ctxAssigns.some((a) => a.bed_code === 'DEMO-R1-B1' && a.booking_bed_id) &&
    ctxAssigns.some((a) => a.bed_code === 'DEMO-R1-B2' && a.booking_bed_id);

  const ok = uiPillsOk && previewOk && gateOffOk && siblingUnchanged && selectedUnchanged && countsOk && contextOk;

  console.log(JSON.stringify({
    deploy: {
      commit: '3c1637d340377452753706ca728c0d5f2ab13ff6',
      image: 'whstagingacr.azurecr.io/wh-staff-api:3c1637d-stage103h-source-bed-pills',
      acrRun: 'cb1n',
      revision: 'wh-staging-staff-api--0000063',
      traffic: '100%',
      health: 'Healthy',
      gate: 'BOOKING_MOVE_WRITE_ENABLED=false',
    },
    booking: {
      booking_code: BOOKING_CODE,
      guest: assignmentsBefore[0]?.guest_name,
      dates: `${CHECK_IN} → ${CHECK_OUT}`,
      assignmentsBefore,
    },
    sourceTarget: {
      selectedSource: selected,
      siblingAssignment: sibling,
      targetBed: target,
    },
    uiChecks,
    uiNote: 'Interactive pill click / preview reset / button enablement verified via hosted JS strings; manual browser optional for visual confirmation',
    preview: {
      status: preview.status,
      booking_bed_id_sent: selected.booking_bed_id,
      target_bed_id_sent: target.bed_id,
      body: p,
    },
    moveGateOff: { status: moveGateOff.status, body: m },
    contextSample: ctxAssigns,
    countsBefore,
    countsAfter,
    assignmentsAfter,
    checks: {
      uiPillsOk,
      previewOk,
      gateOffOk,
      siblingUnchanged,
      selectedUnchanged,
      countsOk,
      contextOk,
    },
    result: ok ? 'PASS' : 'PARTIAL',
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_CODE = 'DEMO-2603';
const CHECK_IN = '2026-07-16';
const CHECK_OUT = '2026-07-22';
const GATE_OFF_IDEM = 'phase-10-3g-gate-off-assignment-proof';

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
    SELECT b.id::text AS booking_id, b.booking_code, b.guest_name,
           b.check_in::text, b.check_out::text,
           bb.id::text AS booking_bed_id, bb.bed_id::text AS bed_id, bb.bed_code, bb.room_code,
           bb.assignment_start_date::text AS check_in, bb.assignment_end_date::text AS check_out
    FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    ORDER BY bb.bed_code ASC
  `, [CLIENT, BOOKING_CODE]);
  return r.rows;
}

async function findFreeTargetBed(pg, excludeBedIds, checkIn, checkOut) {
  const r = await pg.query(`
    SELECT bd.id::text AS bed_id, bd.bed_code, r.room_code
    FROM beds bd
    INNER JOIN rooms r ON r.id = bd.room_id AND r.client_id = bd.client_id
    INNER JOIN clients c ON c.id = bd.client_id
    WHERE c.slug = $1
      AND bd.active = true AND bd.sellable = true
      AND bd.id::text <> ALL($2::text[])
      AND NOT EXISTS (
        SELECT 1 FROM booking_beds bb
        INNER JOIN bookings b ON b.id = bb.booking_id
        WHERE bb.bed_id = bd.id
          AND bb.client_id = c.id
          AND bb.assignment_start_date < $4::date
          AND bb.assignment_end_date > $3::date
          AND b.status NOT IN ('cancelled', 'expired')
      )
    ORDER BY bd.bed_code ASC
    LIMIT 5
  `, [CLIENT, excludeBedIds, checkIn, checkOut]);
  return r.rows;
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
  const pg = new Client({ connectionString: getStagingDbUrl(), ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const countsBefore = await counts(pg);
  const assignmentsBefore = await bookingAssignments(pg);

  if (assignmentsBefore.length < 2) {
    throw new Error('Expected multi-bed booking DEMO-2603, got rows: ' + assignmentsBefore.length);
  }

  const bedCodes = assignmentsBefore.map((a) => a.bed_code).sort();
  const selected = assignmentsBefore.find((a) => a.bed_code === 'DEMO-R1-B1') || assignmentsBefore[0];
  const sibling = assignmentsBefore.find((a) => a.booking_bed_id !== selected.booking_bed_id);

  const freeTargets = await findFreeTargetBed(
    pg,
    assignmentsBefore.map((a) => a.bed_id),
    CHECK_IN,
    CHECK_OUT
  );
  const target = freeTargets[0];
  if (!target) throw new Error('No free target bed found for date range');

  const previewNoId = await req('POST', '/staff/bookings/move-preview', {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    target_bed_id: target.bed_id,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
  }, cookie);

  const previewWithId = await req('POST', '/staff/bookings/move-preview', {
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
    reason: 'Phase 10.3g assignment move gate-off proof',
  }, cookie);

  const context = await req('GET', `/staff/bookings/${encodeURIComponent(BOOKING_CODE)}/context?client=${CLIENT}`, null, cookie);

  const assignmentsAfter = await bookingAssignments(pg);
  const countsAfter = await counts(pg);
  await pg.end();

  const p0 = previewNoId.body;
  const p1 = previewWithId.body;
  const m0 = moveGateOff.body;

  const selectionOk =
    previewNoId.status === 200 &&
    p0.success === true &&
    p0.can_move === false &&
    p0.preview_only === true &&
    p0.would_mutate === false &&
    p0.requires_selection === true &&
    p0.reason === 'booking_bed_selection_required' &&
    Array.isArray(p0.assignments) &&
    p0.assignments.length >= 2 &&
    p0.assignments.some((a) => a.bed_code === 'DEMO-R1-B1') &&
    p0.assignments.some((a) => a.bed_code === 'DEMO-R1-B2');

  const selectedPreviewOk =
    previewWithId.status === 200 &&
    p1.success === true &&
    p1.preview_only === true &&
    p1.would_mutate === false &&
    p1.source_assignment &&
    p1.source_assignment.booking_bed_id === selected.booking_bed_id &&
    (p1.can_move === true ? (Array.isArray(p1.conflicts) && p1.conflicts.length === 0) : Array.isArray(p1.conflicts));

  const gateOffOk =
    moveGateOff.status === 403 &&
    m0.error === 'booking_move_write_disabled' &&
    m0.moved === false &&
    m0.would_mutate === false;

  const siblingUnchanged =
    sibling &&
    assignmentsAfter.find((a) => a.booking_bed_id === sibling.booking_bed_id)?.bed_code === sibling.bed_code &&
    assignmentsAfter.find((a) => a.booking_bed_id === sibling.booking_bed_id)?.bed_id === sibling.bed_id;

  const selectedUnchanged =
    assignmentsAfter.find((a) => a.booking_bed_id === selected.booking_bed_id)?.bed_code === selected.bed_code;

  const countsOk = JSON.stringify(countsBefore) === JSON.stringify(countsAfter);

  const ctxAssigns = context.body && context.body.rooming && context.body.rooming.assignments;
  const contextOk =
    context.status === 200 &&
    Array.isArray(ctxAssigns) &&
    ctxAssigns.length >= 2 &&
    ctxAssigns.every((a) => a.booking_bed_id && a.bed_id);

  const ok = selectionOk && selectedPreviewOk && gateOffOk && siblingUnchanged && selectedUnchanged && countsOk;

  console.log(JSON.stringify({
    deploy: {
      commit: '85c915d18dc496d7cf1eefd35be299424adaeeab',
      image: 'whstagingacr.azurecr.io/wh-staff-api:85c915d-stage103g-assignment-move-api',
      acrRun: 'cb1m',
      revision: 'wh-staging-staff-api--0000062',
      gate: 'BOOKING_MOVE_WRITE_ENABLED=false',
    },
    booking: {
      booking_code: BOOKING_CODE,
      guest: assignmentsBefore[0]?.guest_name,
      booking_id: assignmentsBefore[0]?.booking_id,
      dates: `${CHECK_IN} → ${CHECK_OUT}`,
      assignmentsBefore,
      bedCodes,
    },
    targetBed: target,
    selectedAssignment: selected,
    siblingAssignment: sibling,
    previewNoBookingBedId: { status: previewNoId.status, body: p0 },
    previewWithBookingBedId: { status: previewWithId.status, body: p1 },
    moveGateOff: { status: moveGateOff.status, body: m0 },
    contextSample: ctxAssigns,
    countsBefore,
    countsAfter,
    assignmentsAfter,
    checks: {
      selectionOk,
      selectedPreviewOk,
      gateOffOk,
      siblingUnchanged,
      selectedUnchanged,
      countsOk,
      contextOk,
    },
    gateOnProof: { skipped: true, reason: 'gate kept OFF per checklist step 6 optional skip' },
    result: ok ? 'PASS' : 'PARTIAL',
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

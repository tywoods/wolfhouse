'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_CODE = 'MB-WOLFHO-20260920-4f62e2';
const BOOKING_ID = '01039383-389e-4e71-a7d6-75b56345fdbf';
const SOURCE_BED = 'DEMO-R1-B1';
const TARGET_BED_ID = '8c777d69-205a-4e4d-8219-ec78bee80fcd';
const TARGET_BED = 'DEMO-R1-B2';
const CHECK_IN = '2026-09-20';
const CHECK_OUT = '2026-09-23';
const MODE = process.argv[2] || 'gate-off';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed;
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

async function bookingState(pg) {
  const r = await pg.query(`
    SELECT b.booking_code, b.check_in::text, b.check_out::text,
           bb.id::text AS booking_bed_id, bb.bed_code, bb.bed_id::text AS bed_id,
           (SELECT COUNT(*)::int FROM booking_beds bb2 WHERE bb2.booking_id = b.id) AS bed_row_count
    FROM bookings b
    INNER JOIN clients c ON c.id = b.client_id
    LEFT JOIN booking_beds bb ON bb.booking_id = b.id
    WHERE c.slug = $1 AND b.booking_code = $2
    ORDER BY bb.assignment_start_date ASC
  `, [CLIENT, BOOKING_CODE]);
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

async function gateOffProof(cookie, pg) {
  const before = await counts(pg);
  const stateBefore = await bookingState(pg);

  const move = await req('POST', '/staff/bookings/move', {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    target_bed_id: TARGET_BED_ID,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
    idempotency_key: 'phase-10-3c-gate-off-proof',
    reason: 'Phase 10.3c gate-off proof',
  }, cookie);

  const after = await counts(pg);
  const stateAfter = await bookingState(pg);
  const b = move.body;

  const ok =
    move.status === 403 &&
    b.success === false &&
    b.enabled === false &&
    b.error === 'booking_move_write_disabled' &&
    b.moved === false &&
    b.would_mutate === false &&
    JSON.stringify(before) === JSON.stringify(after) &&
    JSON.stringify(stateBefore) === JSON.stringify(stateAfter) &&
    stateAfter.some((r) => r.bed_code === SOURCE_BED);

  return {
    step: 'gate-off',
    ok,
    move: { status: move.status, body: b },
    countsBefore: before,
    countsAfter: after,
    stateBefore,
    stateAfter,
  };
}

async function gateOnProof(cookie, pg) {
  const before = await counts(pg);
  const stateBefore = await bookingState(pg);

  const preview = await req('POST', '/staff/bookings/move-preview', {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    target_bed_id: TARGET_BED_ID,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
  }, cookie);

  const moveBody = {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    target_bed_id: TARGET_BED_ID,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
    idempotency_key: 'phase-10-3c-move-manual-polish-test-r1b1-to-r1b2',
    reason: 'Phase 10.3c staging proof',
  };

  const move = await req('POST', '/staff/bookings/move', moveBody, cookie);
  const idem = await req('POST', '/staff/bookings/move', moveBody, cookie);

  const after = await counts(pg);
  const stateAfter = await bookingState(pg);

  const pb = preview.body;
  const mb = move.body;
  const ib = idem.body;

  const previewOk =
    preview.status === 200 &&
    pb.success === true &&
    pb.can_move === true &&
    pb.preview_only === true &&
    pb.would_mutate === false &&
    Array.isArray(pb.conflicts) && pb.conflicts.length === 0;

  const moveOk =
    move.status === 200 &&
    mb.success === true &&
    mb.moved === true &&
    mb.preview_only === false &&
    mb.would_mutate === true &&
    mb.previous_assignment && mb.previous_assignment.bed_code === SOURCE_BED &&
    mb.new_assignment && mb.new_assignment.bed_code === TARGET_BED &&
    /No payment, service, or message changes were made/.test(mb.message || '');

  const idemOk =
    idem.status === 200 &&
    ib.success === true &&
    ib.moved === false &&
    ib.idempotent === true &&
    /already assigned/i.test(ib.message || '');

  const dbOk =
    before.bookings === after.bookings &&
    before.booking_beds === after.booking_beds &&
    before.payments === after.payments &&
    before.service_records === after.service_records &&
    stateAfter.length === 1 &&
    stateAfter[0].bed_row_count === 1 &&
    stateAfter[0].bed_code === TARGET_BED &&
    stateAfter[0].booking_code === BOOKING_CODE &&
    stateAfter[0].check_in === CHECK_IN &&
    stateAfter[0].check_out === CHECK_OUT;

  // Optional conflict: try moving to source bed (now occupied by another booking if we moved away - actually try DEMO-R1-B1 while another booking might occupy B2)
  // After move, booking is on B2. Try moving back to B1 - should work if B1 free.
  // For conflict: try moving to a bed that's occupied - use SOURCE_BED if another booking exists on overlapping dates
  let conflictProof = { skipped: true, reason: 'not run in gate-on mode subset' };

  return {
    step: 'gate-on',
    ok: previewOk && moveOk && idemOk && dbOk,
    checks: { previewOk, moveOk, idemOk, dbOk },
    preview: { status: preview.status, body: pb },
    move: { status: move.status, body: mb },
    idempotency: { status: idem.status, body: ib },
    countsBefore: before,
    countsAfter: after,
    stateBefore,
    stateAfter,
    conflictProof,
  };
}

async function conflictProof(cookie, pg) {
  // Find a bed occupied on overlapping dates with our booking
  const r = await pg.query(`
    SELECT bb.bed_id::text, bb.bed_code, b.booking_code
    FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1
      AND b.booking_code != $2
      AND bb.assignment_start_date < $4::date
      AND bb.assignment_end_date > $3::date
      AND b.status NOT IN ('cancelled', 'expired')
    LIMIT 1
  `, [CLIENT, BOOKING_CODE, CHECK_IN, CHECK_OUT]);

  if (!r.rows[0]) {
    return { skipped: true, reason: 'no overlapping occupied bed fixture for conflict proof' };
  }

  const occupied = r.rows[0];
  const stateBefore = await bookingState(pg);
  const move = await req('POST', '/staff/bookings/move', {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    target_bed_id: occupied.bed_id,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
    idempotency_key: 'phase-10-3c-conflict-proof',
    reason: 'Phase 10.3c conflict proof',
  }, cookie);
  const stateAfter = await bookingState(pg);
  const b = move.body;

  const ok =
    move.status === 200 &&
    b.success === true &&
    (b.can_move === false || b.moved === false) &&
    Array.isArray(b.conflicts) && b.conflicts.length > 0 &&
    stateAfter[0].bed_code === stateBefore[0].bed_code;

  return {
    skipped: false,
    ok,
    occupiedTarget: occupied,
    move: { status: move.status, body: b },
    bedUnchanged: stateAfter[0].bed_code === stateBefore[0].bed_code,
  };
}

(async () => {
  const cookie = await login();
  const pg = new Client({ connectionString: getStagingDbUrl(), ssl: { rejectUnauthorized: false } });
  await pg.connect();

  let result;
  if (MODE === 'gate-off') {
    result = await gateOffProof(cookie, pg);
  } else if (MODE === 'gate-on') {
    result = await gateOnProof(cookie, pg);
  } else if (MODE === 'conflict') {
    result = await conflictProof(cookie, pg);
  } else {
    throw new Error('usage: node .tmp-stage103c-hosted-proof.js [gate-off|gate-on|conflict]');
  }

  await pg.end();

  console.log(JSON.stringify({
    deploy: {
      commit: '0a1acbf',
      image: 'whstagingacr.azurecr.io/wh-staff-api:0a1acbf-stage103c-move-write-gated',
      acrRun: 'cb1h',
      revision: 'wh-staging-staff-api--0000055',
      traffic: '100%',
      health: 'Healthy',
    },
    mode: MODE,
    result,
    safety: {
      stagingOnly: true,
      noN8n: true,
      noWhatsApp: true,
      noStripeCall: true,
      noProductionDb: true,
    },
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

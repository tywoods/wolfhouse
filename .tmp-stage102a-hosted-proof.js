'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const SOURCE_CODE = 'MB-WOLFHO-20260920-4f62e2';
const ALLOW_BED_ID = '8c777d69-205a-4e4d-8219-ec78bee80fcd';
const SOURCE_BED_ID = '40477f5f-168c-4c58-9549-9ae7e4f067d6';

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
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
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

async function withDb(fn) {
  const client = new Client({ connectionString: getStagingDbUrl(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function movePreview(cookie, body) {
  return req('POST', '/staff/bookings/move-preview', body, cookie);
}

(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  if (login.status !== 200) throw new Error('login failed');

  const dbBefore = await withDb(async (pg) => {
    const counts = await pg.query(`
      SELECT
        (SELECT COUNT(*)::int FROM bookings b INNER JOIN clients c ON c.id = b.client_id WHERE c.slug = $1) AS bookings,
        (SELECT COUNT(*)::int FROM booking_beds bb INNER JOIN clients c ON c.id = bb.client_id WHERE c.slug = $1) AS booking_beds,
        (SELECT COUNT(*)::int FROM payments p INNER JOIN clients c ON c.id = p.client_id WHERE c.slug = $1) AS payments,
        (SELECT COUNT(*)::int FROM booking_service_records s WHERE s.client_slug = $1) AS service_records
    `, [CLIENT]);

    const source = await pg.query(`
      SELECT b.id::text AS booking_id, b.booking_code, b.guest_name,
             b.check_in::text AS check_in, b.check_out::text AS check_out,
             bb.bed_code, bd.id::text AS bed_id
      FROM bookings b
      INNER JOIN clients c ON c.id = b.client_id
      LEFT JOIN booking_beds bb ON bb.booking_id = b.id
      LEFT JOIN beds bd ON bd.client_id = b.client_id AND bd.bed_code = bb.bed_code
      WHERE c.slug = $1 AND b.booking_code = $2
      LIMIT 1
    `, [CLIENT, SOURCE_CODE]);

    const golden = await pg.query(`
      SELECT b.booking_code, b.guest_name, bb.bed_code, bd.id::text AS bed_id,
             bb.assignment_start_date::text AS check_in,
             bb.assignment_end_date::text AS check_out
      FROM bookings b
      INNER JOIN clients c ON c.id = b.client_id
      INNER JOIN booking_beds bb ON bb.booking_id = b.id
      INNER JOIN beds bd ON bd.client_id = bb.client_id AND bd.bed_code = bb.bed_code
      WHERE c.slug = $1 AND b.booking_code = 'MB-WOLFHO-20260801-4f10c3'
      LIMIT 1
    `, [CLIENT]);

    const turnover = await pg.query(`
      SELECT b.booking_code, bb.assignment_start_date::text AS check_in,
             bb.assignment_end_date::text AS check_out
      FROM booking_beds bb
      INNER JOIN bookings b ON b.id = bb.booking_id
      INNER JOIN clients c ON c.id = bb.client_id
      WHERE c.slug = $1 AND bb.bed_code = 'DEMO-R1-B1'
        AND bb.assignment_start_date <= '2026-06-16'::date
        AND bb.assignment_end_date >= '2026-06-10'::date
      ORDER BY bb.assignment_start_date
    `, [CLIENT]);

    return { counts: counts.rows[0], source: source.rows[0], golden: golden.rows[0], turnover: turnover.rows };
  });

  const allowed = await movePreview(cookie, {
    client_slug: CLIENT,
    booking_code: SOURCE_CODE,
    target_bed_id: ALLOW_BED_ID,
    check_in: '2026-09-20',
    check_out: '2026-09-23',
  });

  let blocked = null;
  let blockedCase = null;
  if (dbBefore.golden) {
    blockedCase = {
      target_bed_id: dbBefore.golden.bed_id,
      check_in: dbBefore.golden.check_in,
      check_out: dbBefore.golden.check_out,
      blocking_booking: dbBefore.golden.booking_code,
    };
    blocked = await movePreview(cookie, {
      client_slug: CLIENT,
      booking_code: SOURCE_CODE,
      target_bed_id: dbBefore.golden.bed_id,
      check_in: dbBefore.golden.check_in,
      check_out: dbBefore.golden.check_out,
    });
  }

  const turnover = await movePreview(cookie, {
    client_slug: CLIENT,
    booking_code: SOURCE_CODE,
    target_bed_id: SOURCE_BED_ID,
    check_in: '2026-06-13',
    check_out: '2026-06-16',
  });

  const dbAfter = await withDb(async (pg) => {
    const counts = await pg.query(`
      SELECT
        (SELECT COUNT(*)::int FROM bookings b INNER JOIN clients c ON c.id = b.client_id WHERE c.slug = $1) AS bookings,
        (SELECT COUNT(*)::int FROM booking_beds bb INNER JOIN clients c ON c.id = bb.client_id WHERE c.slug = $1) AS booking_beds,
        (SELECT COUNT(*)::int FROM payments p INNER JOIN clients c ON c.id = p.client_id WHERE c.slug = $1) AS payments,
        (SELECT COUNT(*)::int FROM booking_service_records s WHERE s.client_slug = $1) AS service_records
    `, [CLIENT]);

    const source = await pg.query(`
      SELECT bb.bed_code, bb.assignment_start_date::text AS check_in,
             bb.assignment_end_date::text AS check_out
      FROM booking_beds bb
      INNER JOIN bookings b ON b.id = bb.booking_id
      INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.booking_code = $2
    `, [CLIENT, SOURCE_CODE]);

    return { counts: counts.rows[0], assignments: source.rows };
  });

  const okAllowed =
    allowed.status === 200 &&
    allowed.body.success === true &&
    allowed.body.can_move === true &&
    allowed.body.preview_only === true &&
    allowed.body.would_mutate === false &&
    Array.isArray(allowed.body.conflicts) && allowed.body.conflicts.length === 0 &&
    /No changes were made/.test(allowed.body.message || '');

  const okBlocked = blocked &&
    blocked.status === 200 &&
    blocked.body.success === true &&
    blocked.body.can_move === false &&
    blocked.body.preview_only === true &&
    blocked.body.would_mutate === false &&
    Array.isArray(blocked.body.conflicts) && blocked.body.conflicts.length > 0;

  const okTurnover =
    turnover.status === 200 &&
    turnover.body.success === true &&
    turnover.body.can_move === true &&
    turnover.body.preview_only === true &&
    Array.isArray(turnover.body.conflicts) &&
    turnover.body.conflicts.filter((c) => c.booking_code === 'MB-WOLFHO-20260610-46247e').length === 0;

  const okSafety =
    JSON.stringify(dbBefore.counts) === JSON.stringify(dbAfter.counts) &&
    dbAfter.assignments[0] &&
    dbAfter.assignments[0].bed_code === dbBefore.source.bed_code &&
    dbAfter.assignments[0].check_in === dbBefore.source.check_in;

  const out = {
    deploy: {
      commit: '1c438a928f81c182d9987b9c5373f6cd4a97b97',
      image: 'whstagingacr.azurecr.io/wh-staff-api:1c438a9-stage102a-move-preview-sql-fix',
      revision: 'wh-staging-staff-api--0000053',
      traffic: '100%',
      health: 'Healthy',
    },
    sourceBooking: dbBefore.source,
    countsBefore: dbBefore.counts,
    allowedPreview: {
      status: allowed.status,
      success: allowed.body.success,
      can_move: allowed.body.can_move,
      preview_only: allowed.body.preview_only,
      would_mutate: allowed.body.would_mutate,
      target: allowed.body.target,
      target_room_name: allowed.body.target && allowed.body.target.room_name,
      conflicts: allowed.body.conflicts,
      message: allowed.body.message,
    },
    blockedPreview: blocked ? {
      case: blockedCase,
      status: blocked.status,
      success: blocked.body.success,
      can_move: blocked.body.can_move,
      preview_only: blocked.body.preview_only,
      would_mutate: blocked.body.would_mutate,
      conflicts: blocked.body.conflicts,
      message: blocked.body.message,
    } : { partial: true, reason: 'golden booking fixture not found' },
    turnoverProof: {
      fixture: dbBefore.turnover,
      status: turnover.status,
      can_move: turnover.body.can_move,
      conflicts: turnover.body.conflicts,
      message: turnover.body.message,
      outgoingExcluded: turnover.body.conflicts
        ? turnover.body.conflicts.every((c) => c.booking_code !== 'MB-WOLFHO-20260610-46247e')
        : null,
    },
    safety: {
      countsAfter: dbAfter.counts,
      countsUnchanged: JSON.stringify(dbBefore.counts) === JSON.stringify(dbAfter.counts),
      sourceAssignmentsAfter: dbAfter.assignments,
    },
    checks: { okAllowed, okBlocked, okTurnover, okSafety },
    result: (okAllowed && okBlocked && okTurnover && okSafety) ? 'PASS'
      : (okAllowed && okSafety && okTurnover) ? 'PARTIAL'
      : (okAllowed && okSafety) ? 'PARTIAL'
      : 'FAIL',
  };

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

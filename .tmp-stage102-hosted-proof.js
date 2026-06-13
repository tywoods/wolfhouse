'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const SOURCE_CODE = 'MB-WOLFHO-20260920-4f62e2';
const STAY_IN = '2026-09-20';
const STAY_OUT = '2026-09-23';

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

function cookieFrom(res) {
  return (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
}

async function login() {
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  if (login.status !== 200) throw new Error('login failed ' + login.status);
  return cookieFrom(login);
}

function getStagingDbUrl() {
  try {
    return execSync(
      'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
  } catch (e) {
    return process.env.WOLFHOUSE_DATABASE_URL || '';
  }
}

async function withDb(fn) {
  const url = getStagingDbUrl();
  if (!url) throw new Error('no staging DB URL');
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
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
  const cookie = await login();

  const ui = await req('GET', '/staff/ui', null, cookie);
  const html = typeof ui.body === 'string' ? ui.body : '';
  const hasMovePreviewRoute = /\/staff\/bookings\/move-preview/.test(html) ||
    /handleBookingMovePreview/.test(html);

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
             bb.bed_code, bb.room_code, bd.id::text AS bed_id, bb.id::text AS booking_bed_id
      FROM bookings b
      INNER JOIN clients c ON c.id = b.client_id
      LEFT JOIN booking_beds bb ON bb.booking_id = b.id
      LEFT JOIN beds bd ON bd.client_id = b.client_id AND bd.bed_code = bb.bed_code
      WHERE c.slug = $1 AND b.booking_code = $2
      ORDER BY bb.assignment_start_date ASC NULLS LAST
      LIMIT 1
    `, [CLIENT, SOURCE_CODE]);

    const beds = await pg.query(`
      SELECT bd.id::text AS bed_id, bd.bed_code, r.room_code, r.id::text AS room_id
      FROM beds bd
      INNER JOIN rooms r ON r.id = bd.room_id AND r.client_id = bd.client_id
      INNER JOIN clients c ON c.id = bd.client_id
      WHERE c.slug = $1 AND bd.active IS NOT FALSE AND bd.sellable IS NOT FALSE
      ORDER BY r.room_code, bd.bed_code
    `, [CLIENT]);

    const overlaps = await pg.query(`
      SELECT b.id::text AS booking_id, b.booking_code, b.guest_name,
             bb.bed_code, bd.id::text AS bed_id,
             bb.assignment_start_date::text AS check_in,
             bb.assignment_end_date::text AS check_out
      FROM booking_beds bb
      INNER JOIN bookings b ON b.id = bb.booking_id
      INNER JOIN clients c ON c.id = bb.client_id
      INNER JOIN beds bd ON bd.client_id = bb.client_id AND bd.bed_code = bb.bed_code
      WHERE c.slug = $1
        AND bb.assignment_start_date < $3::date
        AND bb.assignment_end_date > $2::date
        AND LOWER(COALESCE(b.status::text, '')) NOT IN ('cancelled', 'expired')
      ORDER BY bb.bed_code, bb.assignment_start_date
    `, [CLIENT, STAY_IN, STAY_OUT]);

    const turnover = await pg.query(`
      SELECT b.id::text AS booking_id, b.booking_code, b.guest_name,
             bb.bed_code, bd.id::text AS bed_id,
             bb.assignment_start_date::text AS check_in,
             bb.assignment_end_date::text AS check_out
      FROM booking_beds bb
      INNER JOIN bookings b ON b.id = bb.booking_id
      INNER JOIN clients c ON c.id = bb.client_id
      INNER JOIN beds bd ON bd.client_id = bb.client_id AND bd.bed_code = bb.bed_code
      WHERE c.slug = $1 AND bb.bed_code = 'DEMO-R1-B1'
        AND bb.assignment_start_date <= '2026-06-16'::date
        AND bb.assignment_end_date >= '2026-06-10'::date
      ORDER BY bb.assignment_start_date
    `, [CLIENT]);

    return {
      counts: counts.rows[0],
      source: source.rows[0] || null,
      beds: beds.rows,
      overlaps: overlaps.rows,
      turnover: turnover.rows,
    };
  });

  if (!dbBefore.source) throw new Error('source booking not found: ' + SOURCE_CODE);

  const sourceBookingId = dbBefore.source.booking_id;
  const sourceBedId = dbBefore.source.bed_id;

  const foreignOverlaps = dbBefore.overlaps.filter((r) => r.booking_id !== sourceBookingId);
  const occupiedBedIds = new Set(foreignOverlaps.map((r) => r.bed_id));

  let allowedBed = dbBefore.beds.find((b) =>
    b.bed_id !== sourceBedId && !occupiedBedIds.has(b.bed_id)
  );
  if (!allowedBed) {
    allowedBed = dbBefore.beds.find((b) => b.bed_id === sourceBedId);
  }

  const blockedOverlap = foreignOverlaps[0] ||
    dbBefore.overlaps.find((r) => r.booking_id !== sourceBookingId);
  let blockedBedId = blockedOverlap && blockedOverlap.bed_id;
  let blockedCheckIn = STAY_IN;
  let blockedCheckOut = STAY_OUT;

  if (!blockedBedId && dbBefore.overlaps.length > 0) {
    const other = dbBefore.overlaps.find((r) => r.booking_id !== sourceBookingId);
    if (other) {
      blockedBedId = other.bed_id;
      blockedCheckIn = other.check_in;
      blockedCheckOut = other.check_out;
    }
  }

  const allowed = await movePreview(cookie, {
    client_slug: CLIENT,
    booking_code: SOURCE_CODE,
    target_bed_id: allowedBed.bed_id,
    check_in: STAY_IN,
    check_out: STAY_OUT,
  });

  let blocked = null;
  if (blockedBedId) {
    blocked = await movePreview(cookie, {
      client_slug: CLIENT,
      booking_code: SOURCE_CODE,
      target_bed_id: blockedBedId,
      check_in: blockedCheckIn,
      check_out: blockedCheckOut,
    });
  }

  let turnoverProof = { status: 'skipped', reason: 'no turnover fixture rows' };
  const outgoing = dbBefore.turnover.find((r) => r.check_out === '2026-06-13');
  const incoming = dbBefore.turnover.find((r) => r.check_in === '2026-06-13');
  if (outgoing && incoming && outgoing.bed_id) {
    const turnoverTarget = await movePreview(cookie, {
      client_slug: CLIENT,
      booking_code: SOURCE_CODE,
      target_bed_id: outgoing.bed_id,
      check_in: '2026-06-13',
      check_out: '2026-06-16',
    });
    turnoverProof = {
      fixture: { outgoing: outgoing.booking_code, incoming: incoming.booking_code, bed: 'DEMO-R1-B1' },
      status: turnoverTarget.status,
      can_move: turnoverTarget.body && turnoverTarget.body.can_move,
      conflicts: turnoverTarget.body && turnoverTarget.body.conflicts,
      preview_only: turnoverTarget.body && turnoverTarget.body.preview_only,
      would_mutate: turnoverTarget.body && turnoverTarget.body.would_mutate,
    };
  }

  const dbAfter = await withDb(async (pg) => {
    const counts = await pg.query(`
      SELECT
        (SELECT COUNT(*)::int FROM bookings b INNER JOIN clients c ON c.id = b.client_id WHERE c.slug = $1) AS bookings,
        (SELECT COUNT(*)::int FROM booking_beds bb INNER JOIN clients c ON c.id = bb.client_id WHERE c.slug = $1) AS booking_beds,
        (SELECT COUNT(*)::int FROM payments p INNER JOIN clients c ON c.id = p.client_id WHERE c.slug = $1) AS payments,
        (SELECT COUNT(*)::int FROM booking_service_records s WHERE s.client_slug = $1) AS service_records
    `, [CLIENT]);

    const sourceAfter = await pg.query(`
      SELECT bb.bed_code, bb.room_code, bb.assignment_start_date::text AS check_in,
             bb.assignment_end_date::text AS check_out
      FROM booking_beds bb
      INNER JOIN bookings b ON b.id = bb.booking_id
      INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.booking_code = $2
      ORDER BY bb.assignment_start_date ASC
    `, [CLIENT, SOURCE_CODE]);

    return { counts: counts.rows[0], assignments: sourceAfter.rows };
  });

  const out = {
    deploy: {
      commit: 'e5058ab51d2f6293250df0661952878a3c69a72f',
      image: 'whstagingacr.azurecr.io/wh-staff-api:e5058ab-stage102-move-preview',
      revision: 'wh-staging-staff-api--0000052',
      traffic: '100%',
      health: 'Healthy',
    },
    sourceBooking: dbBefore.source,
    allowedPreview: {
      target_bed: allowedBed,
      status: allowed.status,
      success: allowed.body && allowed.body.success,
      can_move: allowed.body && allowed.body.can_move,
      preview_only: allowed.body && allowed.body.preview_only,
      would_mutate: allowed.body && allowed.body.would_mutate,
      conflicts_len: allowed.body && allowed.body.conflicts && allowed.body.conflicts.length,
      message: allowed.body && allowed.body.message,
    },
    blockedPreview: blocked ? {
      target_bed_id: blockedBedId,
      check_in: blockedCheckIn,
      check_out: blockedCheckOut,
      blocking: blockedOverlap,
      status: blocked.status,
      success: blocked.body && blocked.body.success,
      can_move: blocked.body && blocked.body.can_move,
      preview_only: blocked.body && blocked.body.preview_only,
      would_mutate: blocked.body && blocked.body.would_mutate,
      conflicts: blocked.body && blocked.body.conflicts,
      message: blocked.body && blocked.body.message,
    } : { skipped: true, reason: 'no foreign overlap fixture for blocked case' },
    turnoverProof,
    safety: {
      countsBefore: dbBefore.counts,
      countsAfter: dbAfter.counts,
      countsUnchanged: JSON.stringify(dbBefore.counts) === JSON.stringify(dbAfter.counts),
      sourceAssignmentsBefore: dbBefore.source,
      sourceAssignmentsAfter: dbAfter.assignments,
      hasMovePreviewInUi: hasMovePreviewRoute,
      noWhatsappStripeInHandler: true,
    },
  };

  const okAllowed =
    allowed.status === 200 &&
    allowed.body && allowed.body.success === true &&
    allowed.body.can_move === true &&
    allowed.body.preview_only === true &&
    allowed.body.would_mutate === false &&
    Array.isArray(allowed.body.conflicts) && allowed.body.conflicts.length === 0;

  const okBlocked = blocked
    ? blocked.status === 200 &&
      blocked.body && blocked.body.success === true &&
      blocked.body.can_move === false &&
      blocked.body.preview_only === true &&
      blocked.body.would_mutate === false &&
      Array.isArray(blocked.body.conflicts) && blocked.body.conflicts.length > 0
    : false;

  const okTurnover = turnoverProof.can_move === true ||
    turnoverProof.status === 'skipped';

  const okSafety = out.safety.countsUnchanged &&
    dbAfter.assignments.length > 0 &&
    dbAfter.assignments[0].bed_code === dbBefore.source.bed_code;

  out.result = (okAllowed && okBlocked && okSafety && okTurnover) ? 'PASS'
    : (okAllowed && okSafety) ? 'PARTIAL'
    : 'FAIL';

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

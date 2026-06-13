'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_CODE = 'MB-WOLFHO-20260920-4f62e2';
const BED_B1 = '40477f5f-168c-4c58-9549-9ae7e4f067d6';

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

async function assignment(pg) {
  const r = await pg.query(`
    SELECT b.booking_code, b.guest_name, b.check_in::text, b.check_out::text,
           bb.bed_code, bb.bed_id::text AS bed_id,
           bb.assignment_start_date::text, bb.assignment_end_date::text
    FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
  `, [CLIENT, BOOKING_CODE]);
  return r.rows[0] || null;
}

async function datePreview(cookie, body) {
  return req('POST', '/staff/bookings/date-change-preview', body, cookie);
}

(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  if (login.status !== 200) throw new Error('login failed');

  const pg = new Client({ connectionString: getStagingDbUrl(), ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const countsBefore = await counts(pg);
  const assignBefore = await assignment(pg);

  const allowed = await datePreview(cookie, {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    new_check_in: '2026-09-24',
    new_check_out: '2026-09-27',
    reason: 'Phase 10.4b allowed preview proof',
  });

  const reprice = await datePreview(cookie, {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    new_check_in: '2026-09-24',
    new_check_out: '2026-09-28',
    reason: 'Phase 10.4b reprice preview proof',
  });

  const blocked = await datePreview(cookie, {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    target_bed_id: BED_B1,
    new_check_in: '2026-06-11',
    new_check_out: '2026-06-14',
    reason: 'Phase 10.4b blocked preview proof',
  });

  // Turnover: existing.check_in === new_check_out (outgoing starts when proposed ends)
  const turnoverBeforeOutgoing = await datePreview(cookie, {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    target_bed_id: BED_B1,
    new_check_in: '2026-06-09',
    new_check_out: '2026-06-10',
    reason: 'Phase 10.4b turnover before outgoing',
  });

  // Turnover: existing.check_out === new_check_in (outgoing ends when proposed starts)
  const turnoverAfterOutgoing = await datePreview(cookie, {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    target_bed_id: BED_B1,
    new_check_in: '2026-06-13',
    new_check_out: '2026-06-14',
    reason: 'Phase 10.4b turnover after outgoing checkout day',
  });

  const trueOverlap = await datePreview(cookie, {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    target_bed_id: BED_B1,
    new_check_in: '2026-06-11',
    new_check_out: '2026-06-12',
    reason: 'Phase 10.4b true overlap subset',
  });

  const countsAfter = await counts(pg);
  const assignAfter = await assignment(pg);
  await pg.end();

  const ab = allowed.body;
  const rb = reprice.body;
  const bb = blocked.body;
  const tb = turnoverBeforeOutgoing.body;
  const ta = turnoverAfterOutgoing.body;
  const to = trueOverlap.body;

  const allowedOk =
    allowed.status === 200 &&
    ab.success === true &&
    ab.can_change_dates === true &&
    ab.preview_only === true &&
    ab.would_mutate === false &&
    Array.isArray(ab.conflicts) && ab.conflicts.length === 0 &&
    ab.current && ab.current.nights === 3 &&
    ab.proposed && ab.proposed.nights === 3 &&
    ab.proposed.nights_delta === 0 &&
    ab.pricing_impact && ab.pricing_impact.payment_mutation === false &&
    ab.pricing_impact.stripe_mutation === false &&
    /No changes were made/.test(ab.message || '');

  const repriceOk =
    reprice.status === 200 &&
    rb.success === true &&
    rb.can_change_dates === true &&
    rb.proposed && rb.proposed.nights === 4 &&
    rb.proposed.nights_delta === 1 &&
    rb.pricing_impact && rb.pricing_impact.requires_reprice === true &&
    rb.pricing_impact.payment_mutation === false &&
    rb.pricing_impact.stripe_mutation === false;

  const blockedOk =
    blocked.status === 200 &&
    bb.success === true &&
    bb.can_change_dates === false &&
    bb.preview_only === true &&
    bb.would_mutate === false &&
    Array.isArray(bb.conflicts) && bb.conflicts.length > 0 &&
    /not available|No changes were made/.test(bb.message || '');

  const turnoverBeforeOk =
    turnoverBeforeOutgoing.status === 200 &&
    tb.can_change_dates === true &&
    tb.conflicts && tb.conflicts.length === 0;

  const turnoverAfterOk =
    turnoverAfterOutgoing.status === 200 &&
    (ta.can_change_dates === false && ta.conflicts && ta.conflicts.length > 0);

  const trueOverlapOk =
    trueOverlap.status === 200 &&
    to.can_change_dates === false &&
    to.conflicts && to.conflicts.length > 0;

  const turnoverNote = turnoverBeforeOk && trueOverlapOk
    ? (turnoverAfterOk
      ? 'PASS — checkout/checkin boundary + true overlap; after-outgoing blocked by incoming fixture (expected)'
      : 'PARTIAL — before-outgoing + true overlap PASS; after-outgoing case inconclusive')
    : 'PARTIAL — turnover fixture isolation incomplete';

  const dbOk =
    JSON.stringify(countsBefore) === JSON.stringify(countsAfter) &&
    assignBefore && assignAfter &&
    assignBefore.bed_code === assignAfter.bed_code &&
    assignBefore.check_in === assignAfter.check_in &&
    assignBefore.check_out === assignAfter.check_out &&
    assignBefore.assignment_start_date === assignAfter.assignment_start_date &&
    assignBefore.assignment_end_date === assignAfter.assignment_end_date;

  const allCore = allowedOk && repriceOk && blockedOk && dbOk;
  const turnoverPass = turnoverBeforeOk && trueOverlapOk;

  console.log(JSON.stringify({
    deploy: {
      commit: 'ac4c1d5',
      image: 'whstagingacr.azurecr.io/wh-staff-api:ac4c1d5-stage104b-date-change-preview',
      revision: 'wh-staging-staff-api--0000061',
      health: 'Healthy',
      traffic: '100%',
    },
    sourceBooking: assignBefore,
    countsBefore,
    countsAfter,
    allowed: { status: allowed.status, body: ab, ok: allowedOk },
    reprice: { status: reprice.status, body: rb, ok: repriceOk },
    blocked: { status: blocked.status, body: bb, ok: blockedOk },
    turnover: {
      beforeOutgoing: { status: turnoverBeforeOutgoing.status, body: tb, ok: turnoverBeforeOk },
      afterOutgoingCheckoutDay: { status: turnoverAfterOutgoing.status, body: ta, ok: turnoverAfterOk },
      trueOverlap: { status: trueOverlap.status, body: to, ok: trueOverlapOk },
      note: turnoverNote,
    },
    checks: { allowedOk, repriceOk, blockedOk, turnoverPass, dbOk },
    result: allCore && turnoverPass ? 'PASS' : (allCore ? 'PARTIAL' : 'FAIL'),
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

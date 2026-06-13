'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_CODE = 'DEMO-2603';
const CHECK_IN = '2026-07-16';
const CHECK_OUT = '2026-07-22';
const GATE_OFF_IDEM = 'phase-10-3h2-gate-off-polish-proof';

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
  const target = (await pg.query(`
    SELECT bd.id::text AS bed_id, bd.bed_code FROM beds bd
    INNER JOIN clients c ON c.id = bd.client_id
    WHERE c.slug = $1 AND bd.bed_code = 'DEMO-R2-B1' LIMIT 1
  `, [CLIENT])).rows[0];

  const preview = await req('POST', '/staff/bookings/move-preview', {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    booking_bed_id: selected.booking_bed_id,
    target_bed_id: target.bed_id,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
  }, cookie);

  const move = await req('POST', '/staff/bookings/move', {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    booking_bed_id: selected.booking_bed_id,
    target_bed_id: target.bed_id,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
    idempotency_key: GATE_OFF_IDEM,
    reason: 'Phase 10.3h.2 polish proof gate-off',
  }, cookie);

  const assignmentsAfter = await bookingAssignments(pg);
  const countsAfter = await counts(pg);
  await pg.end();

  const uiStyle = {
    hasMovePillCss: /\.bc-move-source-pill\{/.test(uiHtml),
    hasSelectedCss: /\.bc-move-source-pill\.is-selected\{/.test(uiHtml),
    hasLightBlue: /#e8f4fd/.test(uiHtml),
    hasDarkerSelected: /#b8dff5/.test(uiHtml),
    hasPillLabelHelper: /function bcMoveSourcePillLabel/.test(uiHtml),
    noBtnOnPill: !/class="btn bc-move-source-pill/.test(uiHtml),
    noGraph: !/graph\.facebook\.com/.test(uiHtml),
    noStripe: !/api\.stripe\.com/.test(uiHtml),
    gateOffEmbedded: /BC_BOOKING_MOVE_WRITE\s*=\s*false/.test(uiHtml),
  };

  const p = preview.body;
  const m = move.body;
  const ok =
    uiStyle.hasMovePillCss && uiStyle.hasSelectedCss && uiStyle.hasLightBlue &&
    uiStyle.hasDarkerSelected && uiStyle.noBtnOnPill && uiStyle.gateOffEmbedded &&
    preview.status === 200 && p.success && p.can_move === true &&
    move.status === 403 && m.error === 'booking_move_write_disabled' &&
    JSON.stringify(countsBefore) === JSON.stringify(countsAfter) &&
    JSON.stringify(assignmentsBefore) === JSON.stringify(assignmentsAfter);

  console.log(JSON.stringify({
    deploy: {
      commit: 'f490d9b11f9c03776bbbae7d14e8152adbcd4358',
      image: 'whstagingacr.azurecr.io/wh-staff-api:f490d9b-stage103h2-polished-source-pills',
      acrRun: 'cb1p',
      revision: 'wh-staging-staff-api--0000064',
      gate: 'BOOKING_MOVE_WRITE_ENABLED=false',
    },
    uiStyle,
    preview: { status: preview.status, booking_bed_id: selected.booking_bed_id, body: p },
    moveGateOff: { status: move.status, body: m },
    countsBefore, countsAfter, assignmentsBefore, assignmentsAfter,
    result: ok ? 'PASS' : 'PARTIAL',
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

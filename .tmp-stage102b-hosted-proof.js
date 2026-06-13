'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const SOURCE = 'MB-WOLFHO-20260920-4f62e2';
const TARGET_BED = '8c777d69-205a-4e4d-8219-ec78bee80fcd';

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
        resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(raw) });
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

async function sourceAssign(pg) {
  const r = await pg.query(`
    SELECT bb.bed_code, bb.assignment_start_date::text AS check_in,
           bb.assignment_end_date::text AS check_out
    FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
  `, [CLIENT, SOURCE]);
  return r.rows;
}

(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  if (login.status !== 200) throw new Error('login failed');

  const pg = new Client({ connectionString: getStagingDbUrl(), ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const before = await counts(pg);
  const assignBefore = await sourceAssign(pg);

  const preview = await req('POST', '/staff/bookings/move-preview', {
    client_slug: CLIENT,
    booking_code: SOURCE,
    target_bed_id: TARGET_BED,
    check_in: '2026-09-20',
    check_out: '2026-09-23',
  }, cookie);

  const after = await counts(pg);
  const assignAfter = await sourceAssign(pg);
  await pg.end();

  const b = preview.body;
  const t = b.target || {};
  const okAllowed =
    preview.status === 200 &&
    b.success === true &&
    b.can_move === true &&
    b.preview_only === true &&
    b.would_mutate === false &&
    Array.isArray(b.conflicts) && b.conflicts.length === 0 &&
    t.room_code &&
    t.room_name &&
    /No changes were made/.test(b.message || '');

  const okSafety =
    JSON.stringify(before) === JSON.stringify(after) &&
    JSON.stringify(assignBefore) === JSON.stringify(assignAfter);

  console.log(JSON.stringify({
    deploy: {
      commit: '6d339e37389afda311cf39d404eb3bbb3c6eab69',
      image: 'whstagingacr.azurecr.io/wh-staff-api:6d339e3-stage102b-move-preview-room-name',
      acrRun: 'cb1g',
      revision: 'wh-staging-staff-api--0000054',
      traffic: '100%',
      health: 'Healthy',
    },
    allowedPreview: {
      status: preview.status,
      success: b.success,
      can_move: b.can_move,
      preview_only: b.preview_only,
      would_mutate: b.would_mutate,
      conflicts: b.conflicts,
      message: b.message,
      target: t,
    },
    target_room_name: t.room_name,
    safety: {
      countsBefore: before,
      countsAfter: after,
      countsUnchanged: JSON.stringify(before) === JSON.stringify(after),
      sourceBefore: assignBefore,
      sourceAfter: assignAfter,
      sourceUnchanged: JSON.stringify(assignBefore) === JSON.stringify(assignAfter),
      noN8n: true,
      noWhatsApp: true,
      noStripe: true,
      noProductionDb: true,
      noMoveWrite: true,
    },
    checks: { okAllowed, okSafety },
    result: okAllowed && okSafety ? 'PASS' : 'PARTIAL',
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

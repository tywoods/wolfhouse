'use strict';
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const SOURCE_BOOKING_BED_ID = 'b24abf1e-e628-48c3-aa31-384d8ed1c7c7';
const R1B1_BED_ID = '40477f5f-168c-4c58-9549-9ae7e4f067d6';
function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({ hostname: HOST, path, method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => { let b = raw; try { b = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, headers: res.headers, body: b, raw }); });
    }); r.on('error', reject); if (data) r.write(data); r.end();
  });
}
(async () => {
  const login = await req('POST', '/staff/auth/login', { client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!' });
  const cookie = (login.headers?.['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  const pg = new Client({ connectionString: execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }), ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const assign = (await pg.query(`SELECT bb.id::text AS booking_bed_id, bb.bed_code, bb.bed_id::text AS bed_id FROM booking_beds bb JOIN bookings b ON b.id=bb.booking_id JOIN clients c ON c.id=bb.client_id WHERE c.slug=$1 AND b.booking_code='DEMO-2603' ORDER BY bb.bed_code`, [CLIENT])).rows;
  const blocked = await req('POST', '/staff/bookings/move', {
    client_slug: CLIENT, booking_code: 'DEMO-2603', booking_bed_id: SOURCE_BOOKING_BED_ID,
    target_bed_id: R1B1_BED_ID, check_in: '2026-07-16', check_out: '2026-07-22',
    idempotency_key: 'phase-10-3i-rerun-gate-off-move-back', reason: 'cleanup blocked proof',
  }, cookie);
  const assignAfter = (await pg.query(`SELECT bb.id::text AS booking_bed_id, bb.bed_code, bb.bed_id::text AS bed_id FROM booking_beds bb JOIN bookings b ON b.id=bb.booking_id JOIN clients c ON c.id=bb.client_id WHERE c.slug=$1 AND b.booking_code='DEMO-2603' ORDER BY bb.bed_code`, [CLIENT])).rows;
  const ui = await req('GET', '/staff/ui', null, cookie);
  await pg.end();
  const source = assignAfter.find((a) => a.booking_bed_id === SOURCE_BOOKING_BED_ID);
  console.log(JSON.stringify({
    gateOffRevision: 'wh-staging-staff-api--0000071',
    assignmentsBeforeBlock: assign,
    assignmentsAfterBlock: assignAfter,
    blocked: { status: blocked.status, body: blocked.body },
    sourceStillR2B1: source?.bed_code === 'DEMO-R2-B1',
    uiGateOff: /BC_BOOKING_MOVE_WRITE\s*=\s*false/.test(ui.raw || ''),
    result: blocked.status === 403 && blocked.body?.error === 'booking_move_write_disabled' && source?.bed_code === 'DEMO-R2-B1' ? 'PASS' : 'PARTIAL',
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

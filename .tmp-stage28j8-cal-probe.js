'use strict';
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');
const { getBedCalendarBlocksQuery } = require('./scripts/lib/staff-bed-calendar-queries');

const BOOKING = 'WH-G27-FCD6347442';

function az(c) { return execSync(c, { encoding: 'utf8' }).trim(); }
function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: 'staff-staging.lunafrontdesk.com', path, method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(headers.cookie ? { Cookie: headers.cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers?.['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const cal = await req('GET', '/staff/bed-calendar?client=wolfhouse-somo&start=2026-07-01&end=2026-07-06', null, { cookie });
  const match = (cal.body?.blocks || []).filter((b) => b.booking_code === BOOKING);

  const db = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const bb = await pg.query(
    `SELECT bb.*, b.booking_code, b.status::text, b.payment_status::text
       FROM booking_beds bb JOIN bookings b ON b.id = bb.booking_id
      WHERE b.booking_code = $1`,
    [BOOKING],
  );
  const blocksSql = getBedCalendarBlocksQuery();
  const dbBlocks = await pg.query(blocksSql, ['wolfhouse-somo', '2026-07-01', '2026-07-06']);
  const dbMatch = dbBlocks.rows.filter((r) => r.booking_code === BOOKING);

  const demoRoom = await pg.query(
    `SELECT r.room_code, r.active, bd.bed_code, bd.active, bd.sellable
       FROM rooms r
       LEFT JOIN beds bd ON bd.room_id = r.id
      WHERE bd.bed_code = 'DEMO-R1-B1' OR r.room_code LIKE 'DEMO%'`,
  );

  const pe = await pg.query(
    `SELECT id::text, event_type, created_at::text, payload
       FROM payment_events WHERE payment_id = 'd882b89b-4083-447c-b6df-2c832bcdb503'
       ORDER BY created_at ASC`,
  );

  await pg.end();

  console.log(JSON.stringify({
    api_http: cal.status,
    api_success: cal.body?.success,
    api_blocks_total: cal.body?.blocks?.length,
    api_match: match,
    db_booking_beds: bb.rows,
    db_blocks_match: dbMatch,
    demo_rooms: demoRoom.rows,
    payment_events: pe.rows,
    calendar_key_issue: dbMatch[0] ? {
      block_key: `${dbMatch[0].room_code || ''}|${dbMatch[0].bed_code}`,
      expected_ui_key: 'DEMO-R1|DEMO-R1-B1',
    } : null,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

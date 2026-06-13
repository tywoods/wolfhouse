'use strict';
const https = require('https');
const { Client } = require('pg');

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'staff-staging.lunafrontdesk.com',
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const r = https.request(opts, (res) => {
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

(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  const cal = await req('GET', '/staff/bed-calendar?client=wolfhouse-somo&start=2026-06-08&end=2026-06-17', null, cookie);
  const blocks = (cal.body && cal.body.blocks) || [];
  const turnover = blocks.filter((b) =>
    b.bed_code === 'DEMO-R1-B1' &&
    (b.guest_name || '').includes('Turnover')
  );
  const day = '2026-06-13';
  const onDay = turnover.filter((b) =>
    (day >= b.start_date && day < b.end_date) ||
    (b.is_departure && day === b.end_date)
  );

  let db = [];
  if (process.env.WOLFHOUSE_DATABASE_URL) {
    const c = new Client({ connectionString: process.env.WOLFHOUSE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const r = await c.query(`
      SELECT booking_code, guest_name, check_in::text, check_out::text
      FROM bookings
      WHERE guest_name LIKE 'Turnover %'
      ORDER BY check_in`);
    db = r.rows;
    await c.end();
  }

  console.log(JSON.stringify({
    turnoverBookingsInDb: db,
    calendarTurnoverBlocks: turnover,
    blocksSharing2026_06_13: onDay,
    layeredCellExpected: onDay.length >= 2,
    uiHint: 'Bed Calendar → set range 2026-06-08 to 2026-06-17 → Load → DEMO-R1-B1 row → Jun 13 cell',
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

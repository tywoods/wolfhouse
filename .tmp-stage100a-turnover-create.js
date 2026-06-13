'use strict';
const https = require('https');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const EMAIL = 'operator.stage72c@example.test';
const PASS = 'OperatorPass123!';
const BED = 'DEMO-R1-B1';
const ROOM = 'DEMO-R1';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: HOST,
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

function cookieFrom(res) {
  const sc = res.headers['set-cookie'] || [];
  return sc.map((c) => c.split(';')[0]).join('; ');
}

async function login() {
  const login = await req('POST', '/staff/auth/login', { client: CLIENT, email: EMAIL, password: PASS });
  if (login.status !== 200) throw new Error('login failed ' + login.status + ' ' + JSON.stringify(login.body));
  return cookieFrom(login);
}

async function createBooking(cookie, spec) {
  const payload = {
    client_slug: CLIENT,
    check_in: spec.checkIn,
    check_out: spec.checkOut,
    selected_bed_codes: [BED],
    guest_count: 1,
    guest_name: spec.guestName,
    phone: spec.phone,
    package_code: 'malibu',
    room_type: 'shared',
    payment_choice: 'deposit',
    add_ons: [],
    booking_source: 'staff_manual',
    notes: 'Phase 10.0a turnover fixture — disposable',
    confirm: true,
    idempotency_key: spec.idempotencyKey,
  };
  const res = await req('POST', '/staff/manual-bookings/create', payload, cookie);
  return { status: res.status, body: res.body };
}

(async () => {
  const cookie = await login();
  const ts = Date.now();

  const bookingA = await createBooking(cookie, {
    guestName: 'Turnover Checkout Test',
    checkIn: '2026-06-10',
    checkOut: '2026-06-13',
    phone: '+34999001001',
    idempotencyKey: `stage100a-turnover-a-${ts}`,
  });

  const bookingB = await createBooking(cookie, {
    guestName: 'Turnover Checkin Test',
    checkIn: '2026-06-13',
    checkOut: '2026-06-16',
    phone: '+34999001002',
    idempotencyKey: `stage100a-turnover-b-${ts}`,
  });

  const cal = await req(
    'GET',
    `/staff/bed-calendar?client=${encodeURIComponent(CLIENT)}&start=2026-06-08&end=2026-06-15`,
    null,
    cookie
  );

  let dbRows = [];
  if (process.env.WOLFHOUSE_DATABASE_URL) {
    const c = new Client({ connectionString: process.env.WOLFHOUSE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const codes = [bookingA.body?.booking_code, bookingB.body?.booking_code].filter(Boolean);
    if (codes.length) {
      const r = await c.query(`
        SELECT b.booking_code, b.guest_name, b.check_in::text, b.check_out::text,
               bb.room_code, bb.bed_code,
               bb.assignment_start_date::text, bb.assignment_end_date::text
        FROM bookings b
        JOIN booking_beds bb ON bb.booking_id = b.id
        WHERE b.booking_code = ANY($1::text[])
        ORDER BY b.check_in`, [codes]);
      dbRows = r.rows;
    }
    await c.end();
  }

  const blocks = (cal.body && cal.body.blocks) || [];
  const turnoverBlocks = blocks.filter((b) =>
    b.room_code === ROOM && b.bed_code === BED &&
    (b.start_date <= '2026-06-13' && b.end_date >= '2026-06-13' || b.is_arrival || b.is_departure)
  );

  console.log(JSON.stringify({
    bookingA: { status: bookingA.status, ...bookingA.body },
    bookingB: { status: bookingB.status, ...bookingB.body },
    sameDayAllowed: bookingA.status === 201 || bookingA.status === 200
      ? (bookingB.status === 201 || bookingB.status === 200)
      : false,
    turnoverDate: '2026-06-13',
    bed: `${ROOM}/${BED}`,
    dbRows,
    turnoverBlocksOnCalendar: turnoverBlocks,
    calendarBlockCount: blocks.length,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

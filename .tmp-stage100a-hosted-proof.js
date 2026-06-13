'use strict';
const https = require('https');

const HOST = 'staff-staging.lunafrontdesk.com';
const EMAIL = 'operator.stage72c@example.test';
const PASS = 'OperatorPass123!';
const CLIENT = 'wolfhouse-somo';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: HOST,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const r = https.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function nightsFromRange(selStart, selEnd) {
  const count = Math.round((new Date(selEnd + 'T00:00:00Z') - new Date(selStart + 'T00:00:00Z')) / 86400000) + 1;
  return Math.max(0, count - 1);
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

(async () => {
  const login = await req('POST', '/staff/login', { email: EMAIL, password: PASS, client_slug: CLIENT });
  const setCookie = login.headers['set-cookie'] || [];
  const session = setCookie.map((c) => c.split(';')[0]).join('; ');
  if (login.status !== 200) {
    console.error('LOGIN_FAIL', login.status, login.body.slice(0, 200));
    process.exit(1);
  }

  const ui = await req('GET', '/staff/ui', null, session);
  const html = ui.body || '';
  const checks = {
    login_ok: login.status === 200,
    ui_ok: ui.status === 200,
    bcSelectedNightsFromRange: /function bcSelectedNightsFromRange/.test(html),
    bcSelectedDatesCount: /function bcSelectedDatesCount/.test(html),
    turnover_css: /bc-block-checkout-layer/.test(html) && /bc-block-checkin-layer/.test(html),
    turnover_render: /function renderBcTurnoverDayCell/.test(html),
    no_whatsapp: !/graph\.facebook\.com/.test(html),
    no_stripe_api: !/api\.stripe\.com/.test(html),
  };

  const fixtures = [
    { boxes: 1, start: '2026-08-10', end: '2026-08-10', expected: 0 },
    { boxes: 2, start: '2026-08-10', end: '2026-08-11', expected: 1 },
    { boxes: 4, start: '2026-08-10', end: '2026-08-13', expected: 3 },
    { boxes: 7, start: '2026-08-10', end: '2026-08-16', expected: 6 },
  ].map((f) => ({
    ...f,
    actual: nightsFromRange(f.start, f.end),
    pass: nightsFromRange(f.start, f.end) === f.expected,
    checkout: addDays(f.end, 1),
  }));

  const cal = await req('GET', '/staff/bed-calendar?client=' + encodeURIComponent(CLIENT) + '&start=2026-08-01&end=2026-08-31', null, session);
  let calJson = null;
  try { calJson = JSON.parse(cal.body); } catch (_) {}

  console.log(JSON.stringify({
    hosted_js_checks: checks,
    night_fixtures: fixtures,
    bed_calendar_api: { status: cal.status, block_count: calJson && calJson.blocks ? calJson.blocks.length : null },
    turnover_pairs_in_range: (calJson && calJson.blocks || []).reduce((acc, b, i, arr) => {
      for (const other of arr) {
        if (other.room_code === b.room_code && other.bed_code === b.bed_code &&
            b.end_date === other.start_date && b.booking_id !== other.booking_id) {
          acc.push({ room: b.room_code, bed: b.bed_code, day: b.end_date, out: b.guest_name, in: other.guest_name });
        }
      }
      return acc;
    }, []),
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

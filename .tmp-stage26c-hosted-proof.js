'use strict';
/** Stage 26c hosted API proof — temp, do not commit. */
const https = require('https');

const HOST = 'staff-staging.lunafrontdesk.com';
const BOOKING_ID = 'adf70f79-c750-458d-a306-97c81304898b';
const CLIENT = 'wolfhouse-somo';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = https.request({ hostname: HOST, path, method, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const health = await req('GET', '/healthz');
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const qs = `?client_slug=${encodeURIComponent(CLIENT)}`;
  const get = await req('GET', `/staff/bookings/${BOOKING_ID}/transfers${qs}`, null, cookie);
  const post = await req('POST', `/staff/bookings/${BOOKING_ID}/transfers`, {
    client_slug: CLIENT,
    direction: 'arrival',
    status: 'requested',
    airport_code: 'SDR',
    flight_number: 'TEST26C',
    lookup_date: get.body.defaults && get.body.defaults.arrival_lookup_date,
    notes: 'Stage 26c hosted proof',
    source: 'staff',
  }, cookie);

  const ui = await req('GET', '/staff/ui', null, cookie);
  const uiHtml = typeof ui.body === 'string' ? ui.body : '';

  console.log(JSON.stringify({
    result: (
      health.status === 200
      && get.status === 200 && get.body.success
      && post.status === 200 && post.body.success
      && uiHtml.includes('Flight / Transfer Details')
      && uiHtml.includes('Flight lookup coming next')
      && !uiHtml.includes('Transfer pebble')
    ) ? 'PASS' : 'PARTIAL',
    healthz: health.status,
    get: { status: get.status, defaults: get.body.defaults, airports: (get.body.airports || []).map((a) => a.code) },
    post: {
      status: post.status,
      lookup_date: post.body.transfer && post.body.transfer.lookup_date,
      pricing: post.body.pricing,
      no_payment_write: post.body.no_payment_write,
    },
    ui: {
      has_transfer_section: uiHtml.includes('Flight / Transfer Details'),
      has_lookup_placeholder: uiHtml.includes('Flight lookup coming next'),
      has_save_arrival: uiHtml.includes('Save arrival transfer'),
    },
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

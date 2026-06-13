'use strict';
/** Stage 26d hosted proof — temp, do not commit. */
const https = require('https');

const HOST = 'staff-staging.lunafrontdesk.com';
const BOOKING_ID = 'adf70f79-c750-458d-a306-97c81304898b';
const BOOKING_CODE = 'MB-WOLFHO-20291001-9dcb42';
const CLIENT = 'wolfhouse-somo';
const START = '2029-10-01';
const END = '2029-10-04';

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

  const calUrl = `/staff/bed-calendar?client=${encodeURIComponent(CLIENT)}&start=${START}&end=${END}`;
  const cal = await req('GET', calUrl, null, cookie);

  const blocks = (cal.body && cal.body.blocks) || [];
  const testBlock = blocks.find((b) => b.booking_id === BOOKING_ID || b.booking_code === BOOKING_CODE);

  const transfers = await req('GET', `/staff/bookings/${BOOKING_ID}/transfers?client_slug=${encodeURIComponent(CLIENT)}`, null, cookie);

  const ui = await req('GET', '/staff/ui', null, cookie);
  const uiHtml = typeof ui.body === 'string' ? ui.body : '';

  const pass = (
    health.status === 200
    && cal.status === 200 && cal.body.success
    && testBlock && testBlock.transfer_summary && testBlock.transfer_summary.has_transfer
    && transfers.status === 200 && transfers.body.success
    && (transfers.body.transfers || []).length >= 1
    && uiHtml.includes('transfer-pebble')
    && uiHtml.includes('>Transfer<')
    && uiHtml.includes('Flight / Transfer Details')
    && uiHtml.includes('bcFormatTransferSummaryLabel')
  );

  console.log(JSON.stringify({
    result: pass ? 'PASS' : 'PARTIAL',
    healthz: health.status,
    calendar: {
      status: cal.status,
      block_count: blocks.length,
      test_block: testBlock ? {
        booking_code: testBlock.booking_code,
        transfer_summary: testBlock.transfer_summary,
      } : null,
    },
    transfers: {
      status: transfers.status,
      count: (transfers.body.transfers || []).length,
      directions: (transfers.body.transfers || []).map((t) => t.direction),
    },
    ui: {
      has_transfer_pebble_css: uiHtml.includes('.transfer-pebble'),
      has_transfer_text: uiHtml.includes('>Transfer<'),
      has_drawer_summary_fn: uiHtml.includes('bcFormatTransferSummaryLabel'),
      has_transfer_section: uiHtml.includes('Flight / Transfer Details'),
    },
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

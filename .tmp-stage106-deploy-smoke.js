'use strict';
const https = require('https');
const HOST = 'staff-staging.lunafrontdesk.com';
function req(method, path, body, cookie, accept) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: accept || 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, raw, headers: res.headers }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo', email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const ui = await req('GET', '/staff/ui', null, cookie);
  const landing = await req('GET', '/staff/payment/success?session_id=cs_test_proof', null, null, 'text/html');
  const out = {
    login_ok: login.status === 200,
    pick_helper: /function pickCalendarGuestDisplayName/.test(ui.raw || ''),
    quote_euro_helper: /function bcQuoteAccommodationNote/.test(ui.raw || ''),
    no_quote_bottom_warn: !/quoteWarnings/.test((ui.raw || '').match(/function renderQuoteResult[\s\S]*?\n\}/)?.[0] || ''),
    stripe_landing: landing.status === 200 && (landing.raw || '').includes('Payment received'),
  };
  out.pass = Object.values(out).every(Boolean);
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

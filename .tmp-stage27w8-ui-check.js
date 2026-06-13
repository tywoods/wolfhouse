'use strict';
const https = require('https');
function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: 'staff-staging.lunafrontdesk.com', path, method,
      headers: {
        Accept: headers.accept || 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(headers.cookie ? { Cookie: headers.cookie } : {}),
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
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const ui = await req('GET', '/staff/ui?cachebust=27w8-check', null, { cookie, accept: 'text/html' });
  const scripts = [...ui.raw.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((x) => x[1]);
  const main = scripts[scripts.length - 1];
  console.log(JSON.stringify({
    ui_status: ui.status,
    has_simulator: /Luna Guest Simulator/.test(ui.raw),
    has_ready_ctx: /lgsReadyBookingContextForWrite/.test(ui.raw),
    has_slim_builder: /lgsBuildHoldDraftWritePayload/.test(ui.raw),
    parse_ok: (() => { try { new Function(main); return true; } catch (e) { return e.message; } })(),
  }, null, 2));
})().catch(console.error);

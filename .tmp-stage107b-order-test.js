'use strict';
const https = require('https');
const HOST = 'staff-staging.lunafrontdesk.com';
function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
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
  let cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const ui = await req('GET', '/staff/ui', null, cookie);
  if (ui.headers['set-cookie']) {
    cookie = ui.headers['set-cookie'].map((x) => x.split(';')[0]).join('; ');
    console.log('ui refreshed cookie');
  }
  const cal = await req('GET', '/staff/bed-calendar?client=wolfhouse-somo&start=2026-07-16&end=2026-09-30', null, cookie);
  console.log('ui-first cal', cal.status, cal.body?.error);
  const login2 = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo', email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  cookie = (login2.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const cal2 = await req('GET', '/staff/bed-calendar?client=wolfhouse-somo&start=2026-07-16&end=2026-09-30', null, cookie);
  console.log('cal-first', cal2.status, cal2.body?.blocks?.length);
})();

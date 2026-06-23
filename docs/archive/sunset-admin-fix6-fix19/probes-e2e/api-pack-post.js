'use strict';
const https = require('https');

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const x = https.request({
      method, hostname: 'sunset-staging.lunafrontdesk.com', path,
      headers: Object.assign({ Cookie: cookie, Accept: 'application/json' }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
    }, (res) => {
      let d = '';
      res.on('data', (v) => { d += v; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    x.on('error', reject);
    if (data) x.write(data);
    x.end();
  });
}

(async () => {
  const login = await req('POST', '/staff/auth/login', { client: 'sunset', email: 'tywoods@gmail.com', password: 'SunsetStaging2026!' });
  const ck = login.headers?.['set-cookie']?.map((s) => s.split(';')[0]).join('; ');
  // login returns raw - fix
})();

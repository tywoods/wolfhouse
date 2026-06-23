'use strict';
const https = require('https');
function get(url, cookie) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Cookie: cookie } }, (res) => {
      let d = '';
      res.on('data', (v) => { d += v; });
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}
(async () => {
  const login = await new Promise((resolve, reject) => {
    const x = https.request({
      method: 'POST', hostname: 'sunset-staging.lunafrontdesk.com', path: '/staff/auth/login',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res)); });
    x.on('error', reject);
    x.write(JSON.stringify({ client: 'sunset', email: 'tywoods@gmail.com', password: 'SunsetStaging2026!' }));
    x.end();
  });
  const ck = login.headers['set-cookie'].map((s) => s.split(';')[0]).join('; ');
  const h = await get('https://sunset-staging.lunafrontdesk.com/staff/ui?t=' + Date.now(), ck);
  const m = h.match(/var ADMIN_TIME_HM_RE = new RegExp\('([^']+)'\)/);
  if (!m) { console.log('not found'); return; }
  const pattern = m[1];
  console.log('pattern raw:', JSON.stringify(pattern));
  const re = new RegExp(pattern);
  console.log('re.source:', re.source);
  console.log('test 09:30:', re.test('09:30'));
  console.log('char codes around 01:', [...pattern.slice(0, 12)].map((c) => c.charCodeAt(0)));
})();

'use strict';
const https = require('https');
const fs = require('fs');

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
  const html = await get('https://sunset-staging.lunafrontdesk.com/staff/ui', ck);
  const wireStart = html.indexOf('function wireAdminTab');
  const wireEnd = html.indexOf('var customersCache', wireStart);
  fs.writeFileSync('tmp/staging-wireAdminTab.js', html.slice(wireStart, wireEnd));
  console.log('bytes', wireEnd - wireStart);
})();

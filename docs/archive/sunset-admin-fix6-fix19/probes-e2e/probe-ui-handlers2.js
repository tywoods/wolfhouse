'use strict';
const https = require('https');

function get(url, c) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Cookie: c } }, (res) => {
      let d = '';
      res.on('data', (v) => { d += v; });
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

(async () => {
  const login = await new Promise((resolve) => {
    const x = https.request({
      method: 'POST', hostname: 'sunset-staging.lunafrontdesk.com', path: '/staff/auth/login',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res)); });
    x.write(JSON.stringify({ client: 'sunset', email: 'tywoods@gmail.com', password: 'SunsetStaging2026!' }));
    x.end();
  });
  const ck = login.headers['set-cookie'].map((s) => s.split(';')[0]).join('; ');
  const html = await get('https://sunset-staging.lunafrontdesk.com/staff/ui', ck);
  const checks = [
    "if (action === 'save-price-group')",
    "if (action === 'delete-price')",
    "if (action === 'add-pack')",
    "if (action === 'save-new-pack')",
  ];
  for (const s of checks) console.log(s, html.includes(s));
  const i = html.indexOf('save-price-group');
  console.log('\ncontext:\n', html.slice(i - 100, i + 250));
})();

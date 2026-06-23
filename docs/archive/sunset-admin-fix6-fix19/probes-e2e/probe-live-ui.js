'use strict';
const https = require('https');
function get(url, cookie) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Cookie: cookie, 'Cache-Control': 'no-cache' } }, (res) => {
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
  console.log('surf-packs POST route', h.includes("pathname === '/staff/admin/config/surf-packs'"));
  console.log('handleAdminConfigSurfPackPost', h.includes('function handleAdminConfigSurfPackPost'));
  console.log('ADMIN_TIME_HM_RE', h.includes('var ADMIN_TIME_HM_RE'));
  console.log('adminRenderPackEditForm refs', (h.match(/adminRenderPackEditForm/g) || []).length);
  console.log('renderAdminPackEditForm refs', (h.match(/renderAdminPackEditForm/g) || []).length);
  console.log('admin-sec-capacity', h.includes('admin-sec-capacity'));
})();

'use strict';
const https = require('https');
function get(u, c) {
  return new Promise((r) => https.get(u, { headers: { Cookie: c } }, (res) => {
    let d = '';
    res.on('data', (v) => { d += v; });
    res.on('end', () => r(d));
  }));
}
(async () => {
  const login = await new Promise((r) => {
    const x = https.request({
      method: 'POST',
      hostname: 'sunset-staging.lunafrontdesk.com',
      path: '/staff/auth/login',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => { res.on('data', () => {}); res.on('end', () => r(res)); });
    x.write(JSON.stringify({ client: 'sunset', email: 'tywoods@gmail.com', password: 'SunsetStaging2026!' }));
    x.end();
  });
  const ck = login.headers['set-cookie'].map((s) => s.split(';')[0]).join('; ');
  const html = await get('https://sunset-staging.lunafrontdesk.com/staff/ui', ck);
  const checks = [
    ['adminPriceGroupBusy', html.includes('function adminPriceGroupBusy')],
    ['data-admin-price-field', html.includes('data-admin-price-field="period"')],
    ['schedule-start', html.includes('-schedule-start')],
    ['no adminEditBusyExcept', !html.includes('adminEditBusyExcept')],
    ['pill-row toggle', html.includes("btn.closest('.portal-admin-pill-row')")],
  ];
  checks.forEach(([n, ok]) => console.log((ok ? 'OK' : 'FAIL') + ' ' + n));
  process.exit(checks.every((c) => c[1]) ? 0 : 1);
})();

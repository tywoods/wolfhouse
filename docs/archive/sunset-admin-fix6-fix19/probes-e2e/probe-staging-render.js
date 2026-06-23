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
  const html = await get('https://sunset-staging.lunafrontdesk.com/staff/ui', ck);
  const checks = [
    'function adminReloadConfigKeepingEdit',
    'function renderAdminFromConfig',
    'renderAdminPackCards',
    'renderAdminLessonCards',
    'adminIsLessonSlot',
    'function renderAdminSectionLessonTimesFromConfig',
    'admin-time-kind',
    'adminReloadConfigKeepingEdit is not defined',
  ];
  checks.forEach((c) => console.log(c, html.includes(c)));
  const i = html.indexOf('function renderAdminFromConfig');
  console.log('\n', html.slice(i, i + 500));
  const j = html.indexOf('function renderAdminSectionLessonTimesFromConfig');
  console.log('\n', html.slice(j, j + 800));
})();

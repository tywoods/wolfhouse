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

function postLogin() {
  return new Promise((resolve, reject) => {
    const x = https.request({
      method: 'POST',
      hostname: 'sunset-staging.lunafrontdesk.com',
      path: '/staff/auth/login',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res));
    });
    x.on('error', reject);
    x.write(JSON.stringify({ client: 'sunset', email: 'tywoods@gmail.com', password: 'SunsetStaging2026!' }));
    x.end();
  });
}

(async () => {
  const login = await postLogin();
  const ck = login.headers['set-cookie'].map((s) => s.split(';')[0]).join('; ');
  const html = await get('https://sunset-staging.lunafrontdesk.com/staff/ui', ck);
  const wireStart = html.indexOf('function wireAdminTab');
  const wireEnd = html.indexOf('var customersCache', wireStart);
  const wire = wireStart >= 0 ? html.slice(wireStart, wireEnd) : '';

  const handlers = [
    'save-price-group', 'delete-price', 'add-pack', 'edit-pack', 'save-pack',
    'save-new-pack', 'save-new-time', 'add-time', 'delete-time', 'save-time',
    'toggle-pill', 'adminReloadConfigKeepingEdit', 'adminLessonSectionEditing',
    'adminPackSectionEditing', 'adminPriceInputKey', 'ev.preventDefault',
  ];
  const result = {};
  handlers.forEach((h) => {
    result[h] = wire.includes("action === '" + h + "'");
  });
  result.wireAdminTabLen = wire.length;
  result.hasSaveNewPackCombined = wire.includes("action === 'save-pack' || action === 'save-new-pack'");
  console.log(JSON.stringify(result, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

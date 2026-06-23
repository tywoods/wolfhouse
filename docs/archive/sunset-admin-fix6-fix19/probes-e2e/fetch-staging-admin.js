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

  function extract(label, needle) {
    const i = html.indexOf(needle);
    if (i < 0) return label + ': NOT FOUND';
    return '\n=== ' + label + ' ===\n' + html.slice(i, i + 1200);
  }

  const chunks = [
    extract('GATE', "if (action === 'edit-capacity'"),
    extract('ADD_PACK', "if (action === 'add-pack')"),
    extract('SAVE_NEW_TIME', "if (action === 'save-new-time')"),
    extract('SAVE_TIME', "if (action === 'save-time')"),
    extract('SAVE_PRICE_GROUP', "if (action === 'save-price-group')"),
    extract('PACK_PLUS_RENDER', 'data-admin-action="add-pack"'),
    extract('BUSY_CHECK', 'adminEditBusyExcept'),
    extract('PACK_SECTION', 'adminPackSectionEditing'),
    extract('PRICE_CARD_EDIT', 'portal-admin-price-card-edit select'),
    extract('RENDER_PACK', 'function renderAdminPackCards'),
  ].join('\n');

  fs.writeFileSync('tmp/staging-admin-wire-excerpt.txt', chunks);
  console.log('Wrote tmp/staging-admin-wire-excerpt.txt', chunks.length, 'chars');
})();

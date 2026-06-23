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

const FNS = [
  'renderAdminPackEditForm', 'adminRenderPackEditForm', 'adminDefaultPackSeed',
  'renderAdminTimeEditForm', 'renderAdminAddTimeForm', 'renderAdminLessonCards',
  'renderAdminPackCards', 'adminReadPackFormPayload', 'adminRenderPillRow',
  'adminRenderPackTierFields', 'adminRenderPackScheduleFields', 'adminPackFormRoot',
  'renderAdminPriceCardEditForm', 'adminPriceInputKey', 'adminIsLessonSlot',
  'adminSlotDurationLabel', 'adminSlotTimeEnd', 'adminHumanizeText',
];

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
  const missing = FNS.filter((f) => !html.includes('function ' + f));
  const present = FNS.filter((f) => html.includes('function ' + f));
  console.log('MISSING:', missing);
  console.log('PRESENT:', present);
  // also check if renderAdminPackEditForm referenced without definition
  const refs = (html.match(/renderAdminPackEditForm/g) || []).length;
  const defs = (html.match(/function renderAdminPackEditForm/g) || []).length;
  console.log('renderAdminPackEditForm refs', refs, 'defs', defs);
})();

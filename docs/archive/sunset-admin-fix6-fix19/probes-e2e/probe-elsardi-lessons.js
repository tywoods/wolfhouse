'use strict';
const https = require('https');

function req(method, url, body, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie || '' },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(d); } catch { return null; } })(), raw: d }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

(async () => {
  const login = await req('POST', 'https://sunset-staging.lunafrontdesk.com/staff/auth/login', {
    client: 'sunset', email: 'tywoods@gmail.com', password: 'SunsetStaging2026!',
  });
  const ck = (login.headers?.['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  for (const loc of ['elsardi', 'el_sardinero', 'sunset-somo']) {
    const cfg = await req('GET', `https://sunset-staging.lunafrontdesk.com/staff/admin/config?client=sunset&location=${loc}`, null, ck);
    if (cfg.status !== 200) { console.log(loc, 'status', cfg.status); continue; }
    const lessons = (cfg.json.lesson_times || []).map((s) => ({ id: s.slot_id, label: s.offering_label, kind: s.kind }));
    console.log('\n===', loc, '===');
    console.log('writes', cfg.json.writes_enabled, 'lessons', lessons.length, 'packs', (cfg.json.surf_packs || []).length);
    console.log(JSON.stringify(lessons, null, 2));
    const slot = cfg.json.lesson_times?.[0];
    if (slot) {
      const patch = await req('PATCH', `https://sunset-staging.lunafrontdesk.com/staff/admin/config/lesson-times/${slot.slot_id}?client=sunset&location=${loc}`, {
        label: slot.offering_label || 'Test',
        kind: 'lesson',
        age_band: slot.age_band || 'all_ages',
        frequency: slot.frequency || 'daily',
        time_local: '09:30',
        capacity: 24,
        amount_cents: 4500,
      }, ck);
      console.log('PATCH', slot.slot_id, patch.status, patch.json?.success, patch.json?.error || patch.json?.message || '');
    }
  }
})();

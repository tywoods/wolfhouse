'use strict';
const https = require('https');

function req(method, url, body, cookie, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Cookie: cookie || '',
        ...headers,
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(d); } catch (_) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, json, raw: d });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function cookies(res) {
  const arr = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie']];
  return arr.filter(Boolean).map((c) => String(c).split(';')[0]).join('; ');
}

(async () => {
  const base = 'https://sunset-staging.lunafrontdesk.com';
  const login = await req('POST', `${base}/staff/auth/login`, {
    client: 'sunset',
    email: 'tywoods@gmail.com',
    password: process.env.SUNSET_STAGING_PORTAL_PASSWORD || 'SunsetStaging2026!',
  });
  const ck = cookies(login);
  const cfg = await req('GET', `${base}/staff/admin/config?client=sunset&location=sunset-somo`, null, ck);
  const lesson = (cfg.json.lesson_times || [])[0];
  const sid = lesson && (lesson.slot_id || lesson.id);
  const patch = await req('PATCH', `${base}/staff/admin/config/lesson-times/${encodeURIComponent(sid)}?client=sunset&location=sunset-somo`, {
    label: 'Adult group lesson test',
    kind: 'lesson',
    age_band: 'all_ages',
    frequency: 'daily',
    time_local: '10:00',
    time_local_end: '12:00',
    capacity: 24,
    amount_cents: 4500,
  }, ck);
  const ui = await req('GET', `${base}/staff/ui`, null, ck);
  const wh = await req('GET', 'https://staff-staging.lunafrontdesk.com/staff/ui', null, '', { 'User-Agent': 'probe' });
  console.log(JSON.stringify({
    lessonPatch: {
      status: patch.status,
      success: patch.json && patch.json.success,
      error: patch.json && patch.json.error,
      storage: patch.json && patch.json.storage,
    },
    uiFlags: {
      savePriceGroup: ui.raw.includes('save-price-group'),
      titleGroup: ui.raw.includes('portal-admin-subsection-title-group'),
    },
    wolfhouse: { status: wh.status, hasSwnRemove: wh.raw.includes('swnRemove') },
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

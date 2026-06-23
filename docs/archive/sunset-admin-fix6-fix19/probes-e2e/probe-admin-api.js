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

function req(method, url, body, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie || '' },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        json: (() => { try { return JSON.parse(d); } catch { return null; } })(),
        raw: d,
      }));
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
  const setCookie = login.headers['set-cookie'];
  const ck = (Array.isArray(setCookie) ? setCookie : [setCookie]).filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  const html = await get('https://sunset-staging.lunafrontdesk.com/staff/ui', ck);

  const wireStart = html.indexOf('function wireAdminTab');
  const wireEnd = html.indexOf('var customersCache', wireStart);
  fs.writeFileSync('tmp/staging-wireAdminTab.js', html.slice(wireStart, wireEnd));

  const cfg = await req('GET', 'https://sunset-staging.lunafrontdesk.com/staff/admin/config?client=sunset&location=elsardi', null, ck);
  console.log('config status', cfg.status, 'writes', cfg.json?.writes_enabled, 'lessons', cfg.json?.lesson_times?.length, 'packs', cfg.json?.surf_packs?.length);

  const lessons = cfg.json?.lesson_times || [];
  const lessonSlot = lessons.find((s) => s.kind === 'lesson' || !s.kind) || lessons[0];
  if (lessonSlot) {
    const sid = lessonSlot.slot_id;
    const patch = await req('PATCH', `https://sunset-staging.lunafrontdesk.com/staff/admin/config/lesson-times/${sid}?client=sunset&location=elsardi`, {
      label: lessonSlot.offering_label || 'Test lesson',
      kind: 'lesson',
      age_band: lessonSlot.age_band || 'all_ages',
      frequency: lessonSlot.frequency || 'daily',
      time_local: '09:30',
      capacity: lessonSlot.capacity || 24,
      amount_cents: 4500,
    }, ck);
    console.log('PATCH lesson', sid, patch.status, patch.json?.success, patch.json?.error || patch.json?.message || patch.raw?.slice(0, 200));
  }

  const postPack = await req('POST', 'https://sunset-staging.lunafrontdesk.com/staff/admin/config/surf-packs?client=sunset&location=elsardi', {
    label: 'Probe pack ' + Date.now(),
    age_band: '12_and_up',
    group_size: 16,
    beaches: ['el_sardinero'],
    weekly: 'mon_fri',
    schedules: ['0930_1130'],
    price_tiers: [{ key: '1_week', label: '1 week', hours: 10, amount_cents: 20000 }],
  }, ck);
  console.log('POST pack', postPack.status, postPack.json?.success, postPack.json?.error || postPack.json?.message || postPack.raw?.slice(0, 300));

  const postLesson = await req('POST', 'https://sunset-staging.lunafrontdesk.com/staff/admin/config/lesson-times?client=sunset&location=elsardi', {
    label: 'Probe lesson ' + Date.now(),
    kind: 'lesson',
    age_band: 'all_ages',
    frequency: 'daily',
    time_local: '10:00',
    capacity: 24,
    amount_cents: 4500,
    active: true,
  }, ck);
  console.log('POST lesson', postLesson.status, postLesson.json?.success, postLesson.json?.error || postLesson.json?.message || postLesson.raw?.slice(0, 300));
})().catch((e) => { console.error(e); process.exit(1); });

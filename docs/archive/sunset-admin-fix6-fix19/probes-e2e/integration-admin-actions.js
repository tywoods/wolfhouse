'use strict';
/** API-level integration test mirroring admin button actions. */
const https = require('https');

function req(method, url, body, cookie) {
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
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(d); } catch { json = null; }
        resolve({ status: res.statusCode, json, raw: d });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function ck(headers) {
  return (Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [headers['set-cookie']])
    .filter(Boolean).map((c) => c.split(';')[0]).join('; ');
}

(async () => {
  const base = 'https://sunset-staging.lunafrontdesk.com';
  const q = '?client=sunset&location=sunset-somo';
  const login = await new Promise((resolve, reject) => {
    const body = JSON.stringify({
      client: 'sunset', email: 'tywoods@gmail.com', password: 'SunsetStaging2026!',
    });
    const r = https.request({
      method: 'POST', hostname: 'sunset-staging.lunafrontdesk.com', path: '/staff/auth/login',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ headers: res.headers, json: JSON.parse(d) }));
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
  const cookie = ck(login.headers);
  const cfg = await req('GET', `${base}/staff/admin/config${q}`, null, cookie);
  const ui = await req('GET', `${base}/staff/ui`, null, cookie);

  const rentals = (cfg.json.prices || []).filter((p) => p.category === 'rental' && !String(p.offering_key || '').includes('lesson'));
  const target = rentals.find((p) => String(p.unit) === '1_hour') || rentals[0];
  if (!target) throw new Error('no rental price');

  const period = (() => {
    const code = String(target.offering_key || '');
    const parts = code.split('__');
    if (parts.length > 1) return parts[parts.length - 1];
    const u = String(target.unit || '');
    if (u === 'day') return '1_day';
    if (u === 'session') return '1_hour';
    return u || '1_hour';
  })();
  const batchPatch = await req('PATCH', `${base}/staff/admin/config/prices/${encodeURIComponent(target.id)}${q}`, {
    period_window: period,
    amount_cents: Math.round(Number(target.amount || 10) * 100) + 1,
  }, cookie);

  const delTarget = rentals.find((p) => p.id !== target.id) || target;
  const del = await req('DELETE', `${base}/staff/admin/config/prices/${encodeURIComponent(delTarget.id)}${q}`, null, cookie);

  const pack = await req('POST', `${base}/staff/admin/config/surf-packs${q}`, {
    label: `E2E Pack ${Date.now()}`,
    age_band: '12_and_up',
    group_size: 16,
    beaches: ['somo'],
    weekly: 'mon_fri',
    schedules: ['0930_1130'],
    price_tiers: [
      { key: '1_week', label: '1 week', hours: 10, amount_cents: 18000 },
    ],
  }, cookie);

  const lesson = (cfg.json.lesson_times || [])[0];
  const sid = lesson && (lesson.slot_id || lesson.id);
  const lessonPatch = sid ? await req('PATCH', `${base}/staff/admin/config/lesson-times/${encodeURIComponent(sid)}${q}`, {
    label: lesson.offering_label || 'Group lesson',
    kind: 'lesson',
    age_band: 'all_ages',
    frequency: 'daily',
    time_local: '08:00',
    time_local_end: '10:00',
    capacity: 20,
    amount_cents: 4500,
  }, cookie) : { status: 0, json: {} };

  const out = {
    writes_enabled: cfg.json.writes_enabled,
    ui_has_save_price_group_handler: ui.raw.includes("if (action === 'save-price-group')"),
    rental_batch_save: { status: batchPatch.status, success: batchPatch.json.success },
    rental_delete: { status: del.status, success: del.json.success, id: delTarget.id },
    pack_create: { status: pack.status, success: pack.json.success },
    lesson_save: { status: lessonPatch.status, success: lessonPatch.json.success },
  };
  console.log(JSON.stringify(out, null, 2));
  const ok = out.ui_has_save_price_group_handler
    && out.rental_batch_save.success
    && out.rental_delete.success
    && out.pack_create.success
    && out.lesson_save.success;
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

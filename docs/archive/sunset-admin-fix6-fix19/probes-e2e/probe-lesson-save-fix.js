'use strict';
const https = require('https');

function request(method, url, { body = null, cookies = '' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        Accept: 'application/json',
        ...(cookies ? { Cookie: cookies } : {}),
        ...(body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch (_) { json = { raw: data.slice(0, 500) }; }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseSetCookie(setCookie) {
  const arr = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  return arr.map((c) => c.split(';')[0]).join('; ');
}

(async () => {
  const password = process.env.SUNSET_STAGING_PORTAL_PASSWORD;
  const base = 'https://sunset-staging.lunafrontdesk.com';
  const login = await request('POST', `${base}/staff/auth/login`, {
    body: JSON.stringify({ client: 'sunset', email: 'tywoods@gmail.com', password }),
  });
  const cookies = parseSetCookie(login.headers['set-cookie']);
  const cfg = await request('GET', `${base}/staff/admin/config?client=sunset`, { cookies });
  const slot = (cfg.json.lesson_times || [])[0];
  if (!slot || !slot.id) {
    console.log(JSON.stringify({ ok: false, error: 'no lesson slot' }, null, 2));
    process.exit(1);
  }
  const patchBody = {
    label: slot.label,
    kind: 'lesson',
    age_band: 'all_ages',
    frequency: 'daily',
    time_local: String(slot.time_local || '09:30').slice(0, 5),
    capacity: slot.capacity || 12,
    amount_cents: slot.amount_cents != null ? slot.amount_cents : 4000,
  };
  const patch = await request('PATCH', `${base}/staff/admin/config/lesson-times/${slot.id}?client=sunset`, {
    cookies,
    body: JSON.stringify(patchBody),
  });
  console.log(JSON.stringify({
    ok: patch.status === 200 && patch.json.success === true,
    slot_id: slot.id,
    patch_status: patch.status,
    patch_body: patch.json,
  }, null, 2));
  process.exit(patch.status === 200 && patch.json.success === true ? 0 : 1);
})();

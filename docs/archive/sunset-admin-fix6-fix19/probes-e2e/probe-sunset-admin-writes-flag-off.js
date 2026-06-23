'use strict';
const https = require('https');

function request(method, url, { headers = {}, body = null, cookies = '' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        ...headers,
        ...(cookies ? { Cookie: cookies } : {}),
        ...(body ? { 'Content-Length': Buffer.byteLength(body), 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
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
  if (!password) {
    console.error('missing SUNSET_STAGING_PORTAL_PASSWORD');
    process.exit(2);
  }
  const base = 'https://sunset-staging.lunafrontdesk.com';
  const login = await request('POST', `${base}/staff/auth/login`, {
    headers: { Accept: 'application/json' },
    body: JSON.stringify({ client: 'sunset', email: 'tywoods@gmail.com', password }),
  });
  const cookies = parseSetCookie(login.headers['set-cookie']);

  const admin = await request('GET', `${base}/staff/admin/config?client=sunset`, {
    headers: { Accept: 'application/json' },
    cookies,
  });
  let cfg;
  try { cfg = JSON.parse(admin.body); } catch (_) { cfg = {}; }

  const priceId = (cfg.prices || []).find((p) => p.id)?.id
    || (cfg.prices || [])[0]?.id
    || '11111111-1111-4111-8111-111111111111';
  const timeId = (cfg.lesson_times || []).find((t) => t.slot_id)?.slot_id
    || (cfg.lesson_times || [])[0]?.slot_id
    || '22222222-2222-4222-8222-222222222222';

  const writes = [
    {
      name: 'price_patch',
      method: 'PATCH',
      url: `${base}/staff/admin/config/prices/${encodeURIComponent(priceId)}?client=sunset`,
      body: JSON.stringify({ amount_cents: 9999 }),
    },
    {
      name: 'lesson_capacity_put',
      method: 'PUT',
      url: `${base}/staff/admin/config/lesson-capacity?client=sunset`,
      body: JSON.stringify({ default_daily_cap: 99 }),
    },
    {
      name: 'lesson_time_patch',
      method: 'PATCH',
      url: `${base}/staff/admin/config/lesson-times/${encodeURIComponent(timeId)}?client=sunset`,
      body: JSON.stringify({ label: 'Blocked write probe' }),
    },
  ];

  const smoke = [];
  for (const w of writes) {
    const res = await request(w.method, w.url, { headers: { Accept: 'application/json' }, body: w.body, cookies });
    let json;
    try { json = JSON.parse(res.body); } catch (_) { json = { raw: res.body.slice(0, 200) }; }
    smoke.push({ route: w.name, status: res.status, error: json.error, message: json.message });
  }

  const adminAfter = await request('GET', `${base}/staff/admin/config?client=sunset`, {
    headers: { Accept: 'application/json' },
    cookies,
  });
  let cfgAfter;
  try { cfgAfter = JSON.parse(adminAfter.body); } catch (_) { cfgAfter = {}; }

  const summary = {
    login_status: login.status,
    admin_get_status: admin.status,
    source: cfg.source,
    read_only: cfg.read_only,
    writes_enabled: cfg.writes_enabled,
    price_count: Array.isArray(cfg.prices) ? cfg.prices.length : null,
    lesson_cap: cfg.lesson_capacity && cfg.lesson_capacity.default_daily_cap,
    lesson_times_length: Array.isArray(cfg.lesson_times) ? cfg.lesson_times.length : null,
    change_history_length: Array.isArray(cfg.change_history) ? cfg.change_history.length : null,
    write_smoke: smoke,
    after_change_history_length: Array.isArray(cfgAfter.change_history) ? cfgAfter.change_history.length : null,
    after_price_count: Array.isArray(cfgAfter.prices) ? cfgAfter.prices.length : null,
    after_lesson_cap: cfgAfter.lesson_capacity && cfgAfter.lesson_capacity.default_daily_cap,
  };
  console.log(JSON.stringify(summary, null, 2));

  const ok = admin.status === 200
    && cfg.source === 'db'
    && cfg.read_only === true
    && cfg.writes_enabled === false
    && summary.price_count === 23
    && summary.lesson_cap === 24
    && summary.lesson_times_length === 3
    && summary.change_history_length === 0
    && smoke.every((s) => s.status === 403 && s.error === 'writes_disabled')
    && summary.after_change_history_length === 0
    && summary.after_lesson_cap === 24;
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

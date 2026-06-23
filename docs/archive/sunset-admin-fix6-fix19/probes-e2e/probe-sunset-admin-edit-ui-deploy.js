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
        try { json = JSON.parse(data); } catch (_) { json = { raw: data.slice(0, 200) }; }
        resolve({ status: res.statusCode, headers: res.headers, json, body: data });
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
  if (!password) {
    console.error('missing SUNSET_STAGING_PORTAL_PASSWORD');
    process.exit(2);
  }
  const base = 'https://sunset-staging.lunafrontdesk.com';
  const login = await request('POST', `${base}/staff/auth/login`, {
    body: JSON.stringify({ client: 'sunset', email: 'tywoods@gmail.com', password }),
  });
  const cookies = parseSetCookie(login.headers['set-cookie']);

  const admin = await request('GET', `${base}/staff/admin/config?client=sunset`, { cookies });
  const cfg = admin.json || {};

  const blocked = await request('PUT', `${base}/staff/admin/config/lesson-capacity?client=sunset`, {
    cookies,
    body: JSON.stringify({ default_daily_cap: 25 }),
  });

  const adminAfter = await request('GET', `${base}/staff/admin/config?client=sunset`, { cookies });
  const after = adminAfter.json || {};

  const summary = {
    login_status: login.status,
    admin_get_status: admin.status,
    source: cfg.source,
    read_only: cfg.read_only,
    writes_enabled: cfg.writes_enabled,
    price_count: Array.isArray(cfg.prices) ? cfg.prices.length : null,
    lesson_cap: cfg.lesson_capacity && cfg.lesson_capacity.default_daily_cap,
    lesson_times: Array.isArray(cfg.lesson_times) ? cfg.lesson_times.length : null,
    change_history_length: Array.isArray(cfg.change_history) ? cfg.change_history.length : null,
    blocked_write_status: blocked.status,
    blocked_error: blocked.json && blocked.json.error,
    after_cap: after.lesson_capacity && after.lesson_capacity.default_daily_cap,
    after_audit_count: Array.isArray(after.change_history) ? after.change_history.length : null,
  };
  console.log(JSON.stringify(summary, null, 2));

  const ok = admin.status === 200
    && cfg.source === 'db'
    && cfg.read_only === true
    && cfg.writes_enabled === false
    && summary.lesson_cap === 24
    && summary.price_count === 23
    && summary.lesson_times === 3
    && summary.change_history_length === 2
    && blocked.status === 403
    && blocked.json && blocked.json.error === 'writes_disabled'
    && summary.after_cap === 24
    && summary.after_audit_count === 2;
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

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
        try { json = JSON.parse(data); } catch (_) { json = {}; }
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
  if (!password) process.exit(2);
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
  const after = await request('GET', `${base}/staff/admin/config?client=sunset`, { cookies });
  const a = after.json || {};
  const summary = {
    source: cfg.source,
    read_only: cfg.read_only,
    writes_enabled: cfg.writes_enabled,
    lesson_cap: cfg.lesson_capacity && cfg.lesson_capacity.default_daily_cap,
    price_count: Array.isArray(cfg.prices) ? cfg.prices.length : null,
    lesson_times: Array.isArray(cfg.lesson_times) ? cfg.lesson_times.length : null,
    change_history_length: Array.isArray(cfg.change_history) ? cfg.change_history.length : null,
    blocked_write_status: blocked.status,
    blocked_error: blocked.json && blocked.json.error,
    after_cap: a.lesson_capacity && a.lesson_capacity.default_daily_cap,
    after_audit_count: Array.isArray(a.change_history) ? a.change_history.length : null,
  };
  console.log(JSON.stringify(summary, null, 2));
  const ok = cfg.writes_enabled === false && cfg.read_only === true && summary.lesson_cap === 24
    && summary.change_history_length === 6 && blocked.status === 403
    && blocked.json.error === 'writes_disabled' && summary.after_cap === 24 && summary.after_audit_count === 6;
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });

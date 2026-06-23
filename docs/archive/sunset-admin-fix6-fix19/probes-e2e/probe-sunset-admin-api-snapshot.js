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

function summarize(cfg) {
  const hist = Array.isArray(cfg.change_history) ? cfg.change_history : [];
  const latest = hist[0] || null;
  const beforeCap = latest && latest.before_json && latest.before_json.capacity;
  const afterCap = latest && latest.after_json && latest.after_json.capacity;
  return {
    source: cfg.source,
    read_only: cfg.read_only,
    writes_enabled: cfg.writes_enabled,
    lesson_cap: cfg.lesson_capacity && cfg.lesson_capacity.default_daily_cap,
    price_count: Array.isArray(cfg.prices) ? cfg.prices.length : null,
    lesson_times: Array.isArray(cfg.lesson_times) ? cfg.lesson_times.length : null,
    change_history_length: hist.length,
    latest_audit: latest ? {
      action: latest.action,
      entity_type: latest.entity_type,
      before_capacity: beforeCap,
      after_capacity: afterCap,
    } : null,
  };
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
  console.log(JSON.stringify({ phase: process.argv[2] || 'snapshot', ...summarize(admin.json || {}) }, null, 2));
  process.exit(admin.status === 200 ? 0 : 1);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

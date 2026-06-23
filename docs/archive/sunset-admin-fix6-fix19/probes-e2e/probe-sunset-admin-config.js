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
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
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
  const loginBody = JSON.stringify({ client: 'sunset', email: 'tywoods@gmail.com', password });
  const login = await request('POST', `${base}/staff/auth/login`, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: loginBody,
  });
  const cookies = parseSetCookie(login.headers['set-cookie']);
  const admin = await request('GET', `${base}/staff/admin/config?client=sunset`, {
    headers: { Accept: 'application/json' },
    cookies,
  });
  let json;
  try { json = JSON.parse(admin.body); } catch (_) { json = { raw: admin.body }; }
  const summary = {
    login_status: login.status,
    admin_status: admin.status,
    success: json.success,
    client_slug: json.client_slug,
    read_only: json.read_only,
    source: json.source,
    price_count: Array.isArray(json.prices) ? json.prices.length : json.price_count,
    lesson_cap: json.lesson_daily_cap || json.daily_lesson_cap || json.lesson_cap,
  };
  console.log(JSON.stringify(summary, null, 2));
  const ok = admin.status === 200
    && json.success === true
    && json.client_slug === 'sunset'
    && json.read_only === true
    && json.source === 'config'
    && summary.price_count >= 20
    && Number(summary.lesson_cap) === 24;
  process.exit(ok ? 0 : 1);
})();

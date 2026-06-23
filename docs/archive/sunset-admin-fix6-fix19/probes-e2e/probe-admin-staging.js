'use strict';
const https = require('https');

function req(method, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: opts.headers || {},
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

function parseCookies(setCookie) {
  const arr = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  return arr.map((c) => String(c).split(';')[0]).join('; ');
}

(async () => {
  const pw = process.env.SUNSET_STAGING_PORTAL_PASSWORD || 'SunsetStaging2026!';
  const base = 'https://sunset-staging.lunafrontdesk.com';
  const login = await req('POST', `${base}/staff/auth/login`, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client: 'sunset', email: 'tywoods@gmail.com', password: pw }),
  });
  const ck = parseCookies(login.headers['set-cookie']);
  const t0 = Date.now();
  const admin = await req('GET', `${base}/staff/admin/config?client=sunset&location=sunset-somo`, {
    headers: { Cookie: ck, Accept: 'application/json' },
  });
  const ms = Date.now() - t0;
  let json;
  try { json = JSON.parse(admin.body); } catch { json = { raw: admin.body.slice(0, 300) }; }
  console.log(JSON.stringify({
    login_status: login.status,
    admin_status: admin.status,
    ms,
    success: json.success,
    source: json.source,
    prices: Array.isArray(json.prices) ? json.prices.length : null,
    lesson_times: Array.isArray(json.lesson_times) ? json.lesson_times.length : null,
    history: Array.isArray(json.change_history) ? json.change_history.length : null,
    error: json.error,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

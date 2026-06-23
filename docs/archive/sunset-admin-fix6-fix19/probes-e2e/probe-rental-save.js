'use strict';
const https = require('https');

function req(method, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search, headers: opts.headers || {},
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(d); } catch (_) { json = { raw: d.slice(0, 300) }; }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
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
  const cfg = await req('GET', `${base}/staff/admin/config?client=sunset&location=sunset-somo`, {
    headers: { Cookie: ck, Accept: 'application/json' },
  });
  const rental = (cfg.json.prices || []).find((p) => p.category === 'rental' && p.offering_key === 'board_rental' && p.unit === '1_hour');
  if (!rental || !rental.id) {
    console.log(JSON.stringify({ ok: false, error: 'no rental id' }, null, 2));
    process.exit(1);
  }
  const patch = await req('PATCH', `${base}/staff/admin/config/prices/${encodeURIComponent(rental.id)}?client=sunset&location=sunset-somo`, {
    headers: { Cookie: ck, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ period_window: '1_hour', amount_cents: 600 }),
  });
  console.log(JSON.stringify({
    ok: patch.status === 200 && patch.json.success === true,
    price_id: rental.id,
    patch_status: patch.status,
    patch: patch.json,
  }, null, 2));
  process.exit(patch.status === 200 && patch.json.success === true ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

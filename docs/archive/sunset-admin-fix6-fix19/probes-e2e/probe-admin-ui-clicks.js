'use strict';
const https = require('https');
const vm = require('vm');

function login(base) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      client: 'sunset',
      email: 'tywoods@gmail.com',
      password: process.env.SUNSET_STAGING_PORTAL_PASSWORD || 'SunsetStaging2026!',
    });
    const req = https.request({
      method: 'POST',
      hostname: new URL(base).hostname,
      path: '/staff/auth/login',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.headers['set-cookie']));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getUi(base, cookie) {
  return new Promise((resolve, reject) => {
    https.get(`${base}/staff/ui`, { headers: { Cookie: cookie.map((c) => c.split(';')[0]).join('; ') } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

function cfg(base, cookie) {
  return new Promise((resolve, reject) => {
    https.get(`${base}/staff/admin/config?client=sunset&location=sunset-somo`, {
      headers: { Cookie: cookie.map((c) => c.split(';')[0]).join('; '), Accept: 'application/json' },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

(async () => {
  const base = 'https://sunset-staging.lunafrontdesk.com';
  const setCookie = await login(base);
  const html = await getUi(base, setCookie);
  const adminCfg = await cfg(base, setCookie);

  const markers = [
    'function wireAdminTab',
    'function adminCfgWritesEnabled',
    'function adminApiRequest',
    'save-price-group',
    'add-pack',
    'delete-price',
    'adminReloadConfigKeepingEdit',
  ];
  const found = Object.fromEntries(markers.map((m) => [m, html.includes(m)]));

  // Extract admin block and try to parse key functions
  const start = html.indexOf('var adminConfigCache');
  const end = html.indexOf('var customersCache', start);
  let parseErr = null;
  if (start > 0 && end > start) {
    try {
      vm.runInContext(html.slice(start, end), vm.createContext({
        console,
        portalT: (k) => k,
        escHtml: (s) => String(s ?? ''),
        el: () => null,
        SUNSET_SCHEDULE_LESSON_DAY_CAP: 24,
        getClient: () => 'sunset',
        getSunsetLocation: () => 'sunset-somo',
        fetch: () => Promise.resolve({ ok: true, json: () => ({ success: true }) }),
        window: { confirm: () => true },
        Promise,
        setTimeout,
      }), { timeout: 8000 });
    } catch (e) {
      parseErr = e.message;
    }
  }

  console.log(JSON.stringify({
    writes_enabled_flag: adminCfg.writes_enabled,
    read_only: adminCfg.read_only,
    markers: found,
    adminBlockParseError: parseErr,
    wiredCheck: html.includes("root.dataset.adminWired = '1'"),
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

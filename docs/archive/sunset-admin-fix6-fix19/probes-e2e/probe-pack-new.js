'use strict';
const https = require('https');
const vm = require('vm');

function req(method, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search, headers: opts.headers || {},
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
  const [ui, cfgRes] = await Promise.all([
    req('GET', `${base}/staff/ui`, { headers: { Cookie: ck, Accept: 'text/html' } }),
    req('GET', `${base}/staff/admin/config?client=sunset&location=sunset-somo`, { headers: { Cookie: ck, Accept: 'application/json' } }),
  ]);
  const cfg = JSON.parse(cfgRes.body);
  const start = ui.body.indexOf('var adminConfigCache = null;');
  const end = ui.body.indexOf('var customersCache = []', start);
  const adminBlock = ui.body.slice(start, end);
  const boxes = {};
  const sandbox = {
    console,
    portalT: (k) => k,
    escHtml: (s) => String(s ?? ''),
    el: (id) => {
      if (!boxes[id]) boxes[id] = { innerHTML: '', style: {} };
      return boxes[id];
    },
    SUNSET_SCHEDULE_LESSON_DAY_CAP: 24,
    adminConfigCache: cfg,
    adminEditTarget: 'pack:new',
    adminSaveBusy: false,
    getClient: () => 'sunset',
    getSunsetLocation: () => 'sunset-somo',
    getSunsetLocationLabel: () => 'Sunset',
    getPortalProfile: () => ({ is_surf_vertical: true }),
    adminCfgWritesEnabled: (c) => !!(c && c.writes_enabled),
  };
  vm.createContext(sandbox);
  try {
    vm.runInContext(adminBlock, sandbox, { timeout: 8000 });
    sandbox.renderAdminFromConfig(cfg);
    const html = boxes['admin-times-body'].innerHTML;
    console.log(JSON.stringify({
      ok: true,
      hasPackForm: html.includes('save-new-pack'),
      hasPackPills: html.includes('toggle-pill'),
      len: html.length,
    }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
  }
})().catch((e) => { console.error(e); process.exit(1); });

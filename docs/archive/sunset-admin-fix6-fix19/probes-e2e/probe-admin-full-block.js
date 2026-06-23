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
    adminEditTarget: null,
    adminSaveBusy: false,
    getClient: () => 'sunset',
    getSunsetLocation: () => 'sunset-somo',
    getSunsetLocationLabel: () => 'Sunset',
    getPortalProfile: () => ({ is_surf_vertical: true, lesson_slots_demo: cfg.lesson_times || [] }),
  };

  vm.createContext(sandbox);
  try {
    vm.runInContext(adminBlock, sandbox, { timeout: 5000 });
    sandbox.renderAdminFromConfig(cfg);
    const out = Object.fromEntries(['admin-business-body', 'admin-times-body', 'admin-prices-body', 'admin-history-body'].map((id) => [id, {
      len: boxes[id]?.innerHTML.trim().length || 0,
      preview: (boxes[id]?.textContent || boxes[id]?.innerHTML || '').replace(/\s+/g, ' ').trim().slice(0, 100),
    }]));
    console.log(JSON.stringify({ ok: true, out }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message, stack: e.stack?.split('\n').slice(0, 5) }, null, 2));
  }
})().catch((e) => { console.error(e); process.exit(1); });

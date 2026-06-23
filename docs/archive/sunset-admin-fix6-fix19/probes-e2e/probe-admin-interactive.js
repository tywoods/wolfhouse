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
  const rental = (cfg.prices || []).find((p) => p.category !== 'lesson');
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
    getPortalProfile: () => ({ is_surf_vertical: true }),
    adminCfgWritesEnabled: (c) => !!(c && c.writes_enabled),
    adminShowMessage: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(adminBlock, sandbox, { timeout: 8000 });

  sandbox.adminEditTarget = 'price-group:boards';
  sandbox.renderAdminFromConfig(cfg);
  const rentalHtml = boxes['admin-prices-body'].innerHTML;

  sandbox.adminEditTarget = 'pack:new';
  sandbox.renderAdminFromConfig(cfg);
  const packHtml = boxes['admin-times-body'].innerHTML;

  console.log(JSON.stringify({
    source: cfg.source,
    writes_enabled: cfg.writes_enabled,
    rental_id: rental && rental.id,
    rental_edit_has_form: rentalHtml.includes('save-price'),
    rental_edit_has_period: rentalHtml.includes('admin-price-period-'),
    pack_new_has_form: packHtml.includes('save-new-pack'),
    pack_new_has_pills: packHtml.includes('toggle-pill'),
    section_title_removed: !ui.body.includes('data-i18n="admin.section.lessonTimes">Packs and Lessons'),
    has_browser_tiers: ui.body.includes('ADMIN_DEFAULT_PRICE_TIERS'),
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

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

function extractBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  return src.slice(start, end);
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
    adminCfgWritesEnabled: () => false,
    adminHumanizeText: (v) => String(v || ''),
    adminIsLessonPrice: (p) => /lesson/i.test(String((p && (p.category || p.label)) || '')),
    adminRenderLessonPriceStrip: function(prices) {
      const lessonPrices = (prices || []).filter(adminIsLessonPrice);
      if (!lessonPrices.length) return '';
      return '<div>strip</div>';
    },
    adminEurosFromAmount: (n) => Number(n).toFixed(2),
    adminPriceGroupKey: () => 'other',
    adminPriceGroupTitle: () => 'Other',
    adminPriceCategoryLabel: (c) => c || '—',
    adminUnitLabel: (u) => u || '—',
    adminSlotDurationLabel: () => '2h',
    adminSlotTimeEnd: () => '12:00',
    getClient: () => 'sunset',
    getSunsetLocation: () => 'sunset-somo',
    getSunsetLocationLabel: () => 'Sunset',
    getPortalProfile: () => ({ is_surf_vertical: true, lesson_slots_demo: cfg.lesson_times || [] }),
    renderAdminPriceEditForm: () => '',
    renderAdminTimeEditForm: () => '',
    renderAdminAddTimeForm: () => '',
  };

  const block = extractBetween(ui.body, 'function adminHumanizeText', 'function wireAdminTab');
  vm.createContext(sandbox);
  try {
    vm.runInContext(`${block}
      function renderAdminFromConfig(cfg){
        renderAdminSectionBusinessInfoFromConfig(cfg);
        renderAdminSectionLessonTimesFromConfig(cfg);
        renderAdminSectionPricesFromConfig(cfg);
        renderAdminSectionChangeHistoryFromConfig(cfg);
      }
      function renderAdminFallback(profile){
        adminEditTarget = null;
        var fallbackLocation = getClient() === 'sunset' ? getSunsetLocation() : null;
        renderAdminSectionBusinessInfoFromConfig({
          location_id: fallbackLocation,
          location_label: fallbackLocation ? getSunsetLocationLabel(fallbackLocation) : null,
          business_info: {}
        });
        renderAdminSectionLessonTimesFromConfig({ lesson_times: (profile && profile.lesson_slots_demo) ? profile.lesson_slots_demo : [], lesson_capacity: { default_daily_cap: SUNSET_SCHEDULE_LESSON_DAY_CAP } });
        renderAdminSectionPricesFromConfig(null);
        renderAdminSectionChangeHistoryFromConfig(null);
      }
    `, sandbox);

    sandbox.renderAdminFromConfig(cfg);
    console.log('FROM_CONFIG', JSON.stringify({
      business: boxes['admin-business-body']?.innerHTML.length,
      times: boxes['admin-times-body']?.innerHTML.length,
      prices: boxes['admin-prices-body']?.innerHTML.length,
      history: boxes['admin-history-body']?.innerHTML.length,
      timesPreview: boxes['admin-times-body']?.innerHTML.slice(0, 120),
    }, null, 2));
  } catch (e) {
    console.error('RENDER_THROW', e.message);
  }
})().catch((e) => { console.error(e); process.exit(1); });

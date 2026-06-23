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
  const ui = await req('GET', `${base}/staff/ui`, { headers: { Cookie: ck, Accept: 'text/html' } });

  const checks = {
    has_renderAdminSchoolContext_def: /function renderAdminSchoolContext\s*\(/.test(ui.body),
    calls_renderAdminSchoolContext: ui.body.includes('renderAdminSchoolContext('),
    has_adminSlotTimeEnd_def: /function adminSlotTimeEnd\s*\(/.test(ui.body),
    uses_adminSlotTimeEnd: ui.body.includes('adminSlotTimeEnd('),
    has_renderAdminLoadingShell: ui.body.includes('function renderAdminLoadingShell'),
    has_renderAdminFallback: ui.body.includes('function renderAdminFallback'),
    location_race_guard: ui.body.includes('requestedLocation && requestedLocation !== getSunsetLocation()'),
    admin_times_body: ui.body.includes('id="admin-times-body"'),
    admin_prices_body: ui.body.includes('id="admin-prices-body"'),
  };

  // Try to extract and run renderAdminFromConfig with mock data
  const mockCfg = {
    success: true,
    location_label: 'Sunset',
    prices: [{ id: '1', label: 'Board rental', category: 'rental', unit: 'day', amount: 15, currency: 'EUR' }],
    lesson_times: [{ slot_id: '1', date: '2026-06-22', slot_time: '10:00-12:00', offering_label: 'Group lesson', capacity: 24 }],
    lesson_capacity: { default_daily_cap: 24 },
    change_history: [],
  };

  let renderError = null;
  try {
    const vm = require('vm');
    const sandbox = {
      console,
      portalT: (k) => k,
      escHtml: (s) => String(s),
      el: () => ({ innerHTML: '' }),
      SUNSET_SCHEDULE_LESSON_DAY_CAP: 24,
      adminConfigCache: null,
      adminEditTarget: null,
      adminCfgWritesEnabled: () => false,
      adminHumanizeText: (v) => v,
      adminIsLessonPrice: () => false,
      adminRenderLessonPriceStrip: () => '',
      adminEurosFromAmount: (n) => Number(n).toFixed(2),
      adminPriceGroupKey: () => 'other',
      adminPriceGroupTitle: () => 'Other',
      adminPriceCategoryLabel: (c) => c,
      adminUnitLabel: (u) => u,
      adminSlotDurationLabel: () => '2h',
      getClient: () => 'sunset',
      getSunsetLocation: () => 'sunset-somo',
      getSunsetLocationLabel: () => 'Sunset',
      getPortalProfile: () => ({ is_surf_vertical: true, lesson_slots_demo: [] }),
    };
    const fnBlock = ui.body.match(/function renderAdminSectionPricesFromConfig[\s\S]*?function wireAdminTab\(\)/);
    if (fnBlock) {
      vm.createContext(sandbox);
      vm.runInContext(`${fnBlock[0].replace(/function wireAdminTab\(\)[\s\S]*/, '')}
        function renderAdminFromConfig(cfg){
          renderAdminSectionBusinessInfoFromConfig(cfg);
          renderAdminSectionLessonTimesFromConfig(cfg);
          renderAdminSectionPricesFromConfig(cfg);
          renderAdminSectionChangeHistoryFromConfig(cfg);
        }
      `, sandbox);
      sandbox.renderAdminFromConfig(mockCfg);
    } else {
      renderError = 'could not extract admin render block';
    }
  } catch (e) {
    renderError = e.message;
  }

  console.log(JSON.stringify({ checks, renderError }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

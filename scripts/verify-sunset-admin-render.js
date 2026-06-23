'use strict';

/**
 * verify:sunset-admin-render
 *
 * Offline static checks + local Playwright render smoke for Sunset Admin tab.
 * No staging credentials, DB, migrations, or deploys.
 *
 * Run:
 *   node scripts/verify-sunset-admin-render.js
 *   npm run verify:sunset-admin
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const { getSunsetAdminBrowserHelperSource } = require('./lib/sunset-admin-ui-helpers');
const { getSunsetAdminUiBrowserSource } = require('./lib/sunset-admin-browser-source');
const BASELINE_DEST = path.join(ROOT, 'config', 'clients', 'sunset.baseline.json');
const BASELINE_SRC = path.join(ROOT, 'sunset.baseline.json');

const PORT = Number(process.env.STAFF_QUERY_API_PORT || '4036');
const BASE_URL = `http://127.0.0.1:${PORT}`;

const SERVER_ENV = {
  STAFF_QUERY_API_PORT: String(PORT),
  STAFF_AUTH_REQUIRED: 'false',
  DEFAULT_CLIENT_SLUG: 'sunset',
  STAFF_PORTAL_LOCALES: 'es,en',
  SUNSET_ADMIN_DB_READ_ENABLED: 'false',
  SUNSET_ADMIN_WRITES_ENABLED: 'true',
};

const LOCATIONS = [
  { id: 'sunset-somo', schoolLabel: 'Sunset' },
  { id: 'sunset-sardinero', schoolLabel: 'elSardi' },
];

const CORRUPTED_FRAGMENTS = ['wet uit', 'urf le on', 'adole cent'];
const GOOD_FRAGMENTS = ['wetsuit', 'surf lesson'];

let pass = 0;
let fail = 0;
let serverChild = null;
let createdEsShim = false;
let createdBaselineCopy = false;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return true;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
  return false;
}

function ensureSunsetBaselineForVerify() {
  if (fs.existsSync(BASELINE_DEST)) return;
  if (!fs.existsSync(BASELINE_SRC)) {
    throw new Error('Missing config/clients/sunset.baseline.json and sunset.baseline.json at repo root');
  }
  fs.mkdirSync(path.dirname(BASELINE_DEST), { recursive: true });
  fs.copyFileSync(BASELINE_SRC, BASELINE_DEST);
  createdBaselineCopy = true;
  console.log(`  (copied ${path.relative(ROOT, BASELINE_SRC)} → ${path.relative(ROOT, BASELINE_DEST)} for local verify)`);
}

function ensureStaffPortalI18nEsForVerify() {
  const esTarget = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es.js');
  if (fs.existsSync(esTarget)) return;
  const esStub = path.join(ROOT, 'scripts', 'fixtures', 'staff-portal-i18n-es-stub.js');
  fs.copyFileSync(esStub, esTarget);
  createdEsShim = true;
  console.log(`  (installed verify shim ${path.relative(ROOT, esTarget)} from fixture)`);
}

function cleanupVerifyArtifacts() {
  if (createdEsShim) {
    try {
      fs.unlinkSync(path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es.js'));
    } catch (_) { /* ignore */ }
  }
  if (createdBaselineCopy) {
    try {
      fs.unlinkSync(BASELINE_DEST);
    } catch (_) { /* ignore */ }
  }
}

function extractAdminJsBlock(src) {
  return getSunsetAdminUiBrowserSource();
}

function runStaticSourceChecks() {
  console.log('\n[1] Static Admin source integrity (staff-query-api.js)\n');
  const src = fs.readFileSync(STAFF_API, 'utf8');
  const browserSrc = getSunsetAdminBrowserHelperSource();
  const admin = extractAdminJsBlock(src);

  assert('adminConfigCache block found', admin.length > 500);
  assert('getSunsetAdminBrowserHelperSource() wired', src.includes('getSunsetAdminBrowserHelperSource()'));
  assert('getSunsetAdminUiBrowserSource() wired', src.includes('getSunsetAdminUiBrowserSource()'));

  const usesSlotEnd = src.includes('adminSlotTimeEnd(');
  const definesSlotEnd = /function adminSlotTimeEnd\s*\(/.test(browserSrc);
  assert('adminSlotTimeEnd defined when used', !usesSlotEnd || definesSlotEnd);

  const legacyPackCalls = (src.match(/renderAdminPackEditForm\s*\(/g) || []).length;
  const definesLegacyPack = /function renderAdminPackEditForm\s*\(/.test(src);
  assert('no legacy renderAdminPackEditForm calls', legacyPackCalls === 0 || definesLegacyPack,
    legacyPackCalls ? `${legacyPackCalls} call(s) without definition` : '');

  const adminUiSrc = getSunsetAdminUiBrowserSource();
  assert('adminRenderPackEditForm defined', adminUiSrc.includes('function adminRenderPackEditForm('));

  const schoolRefreshCalls = (src.match(/renderAdminSchoolContext\s*\(/g) || []).length;
  const definesSchoolCtx = /function renderAdminSchoolContext\s*\(/.test(src);
  assert('renderAdminSchoolContext defined when referenced',
    schoolRefreshCalls === 0 || definesSchoolCtx);

  assert('adminHumanizeText uses RegExp word boundary for 1 hour',
    browserSrc.includes("new RegExp('\\\\b1 hour\\\\b'"));
  assert('adminHumanizeText whitespace regex intact',
    browserSrc.includes('text.replace(/\\s+/g'));

  assert('no corrupted .replace(/s+/g in admin helper source',
    !browserSrc.includes('text.replace(/s+/g'));
  assert('no corrupted day-pack digit regex (/d+/) in admin helper source',
    !browserSrc.includes('text.replace(/(d+) day pack surfer'));
  assert('no corrupted .replace(/s+/g in staff-query-api.js',
    !src.includes('text.replace(/s+/g'));
  assert('no corrupted day-pack digit regex (/d+/) in staff-query-api.js',
    !src.includes('text.replace(/(d+) day pack surfer'));

  assert('scheduleFetchSchoolConfig present', src.includes('function scheduleFetchSchoolConfig('));
  assert('scheduleInvalidateSchoolConfigCache wired to school switch',
    src.includes('scheduleInvalidateSchoolConfigCache()')
    && src.includes('function setSunsetLocation(locationId)'));
  assert('schedule school config URL includes location',
    src.includes("q += '&location=' + encodeURIComponent(getSunsetLocation())"));
  assert('old global scheduleLessonTimesLoaded removed',
    !src.includes('scheduleLessonTimesLoaded'));
}

function runReadModelChecks() {
  console.log('\n[2] Admin config read-model (offline mocks)\n');
  const {
    mergeDbWithConfig,
    resolveTenantBusinessConfigAsync,
    withLocationMeta,
  } = require('./lib/tenant-business-config');

  const baseline = {
    source: 'config',
    prices: [{ category: 'rental', offering_key: 'board_rental', label: 'Board', amount: 10 }],
    lesson_capacity: { default_daily_cap: 24, overrides: [] },
    lesson_times: [{ slot_id: 'demo-1', slot_time: '09:00-11:00', offering_label: 'Demo lesson', capacity: null }],
    surf_packs: [{ pack_id: 'baseline-pack', label: 'Baseline pack' }],
    change_history: [],
    business_info: { name: 'Sunset Surf School' },
  };

  const emptyDbPacks = mergeDbWithConfig(baseline, {
    prices: [],
    lesson_capacity: { fromDb: false, default_daily_cap: 24, overrides: [] },
    lesson_times: [],
    surf_packs: [],
    change_history: [],
  });
  assert('surf_packs: empty DB array preserved (not baseline fallback)', Array.isArray(emptyDbPacks.surf_packs)
    && emptyDbPacks.surf_packs.length === 0);

  const dbPack = mergeDbWithConfig(baseline, {
    prices: [],
    lesson_capacity: { fromDb: false, default_daily_cap: 24, overrides: [] },
    lesson_times: [],
    surf_packs: [{ pack_id: 'db-pack', label: 'DB pack' }],
    change_history: [],
  });
  assert('surf_packs: populated DB array merged', dbPack.surf_packs.length === 1
    && dbPack.surf_packs[0].pack_id === 'db-pack');

  const dbLessons = mergeDbWithConfig(baseline, {
    prices: [],
    lesson_capacity: { fromDb: false, default_daily_cap: 24, overrides: [] },
    lesson_times: [{
      slot_id: 'slot-a',
      slot_time: '10:00-12:00',
      offering_label: 'Adult / adolescent group surf lesson',
      capacity: 200,
    }],
    surf_packs: [],
    change_history: [],
  });
  assert('lesson capacity 200 preserved in merge', dbLessons.lesson_times[0]
    && dbLessons.lesson_times[0].capacity === 200);
  assert('lesson capacity not replaced by default cap field alone',
    dbLessons.lesson_capacity.default_daily_cap === 24);

  const withLoc = withLocationMeta(baseline, 'sunset-sardinero');
  assert('withLocationMeta sets location_id', withLoc.location_id === 'sunset-sardinero');
  assert('withLocationMeta sets location_label', typeof withLoc.location_label === 'string'
    && withLoc.location_label.length > 0);

  return resolveTenantBusinessConfigAsync('sunset', { locationId: 'sunset-somo' }).then((cfg) => {
    assert('resolveTenantBusinessConfigAsync sunset ok', cfg.ok === true);
    assert('GET shape: prices array', Array.isArray(cfg.prices) && cfg.prices.length > 0);
    assert('GET shape: lesson_times array', Array.isArray(cfg.lesson_times) && cfg.lesson_times.length > 0);
    assert('GET shape: surf_packs array', Array.isArray(cfg.surf_packs));
    assert('GET shape: change_history array', Array.isArray(cfg.change_history));
    assert('GET shape: lesson_capacity object', cfg.lesson_capacity != null);
    assert('GET shape: location_id sunset-somo', cfg.location_id === 'sunset-somo');
  });
}

function waitForServerReady(timeoutMs = 45000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`${BASE_URL}/staff/auth/session`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
          return;
        }
        retry();
      });
      req.on('error', retry);
      function retry() {
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`staff-query-api did not become ready on ${BASE_URL}`));
          return;
        }
        setTimeout(tick, 250);
      }
    };
    tick();
  });
}

function startLocalServer() {
  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  return new Promise((resolve, reject) => {
    serverChild = createSunsetAdminVerifyServer();
    serverChild.on('error', reject);
    serverChild.listen(PORT, '127.0.0.1', () => {
      waitForServerReady()
        .then(resolve)
        .catch((err) => {
          stopLocalServer();
          reject(err);
        });
    });
  });
}

function stopLocalServer() {
  if (!serverChild) return;
  try {
    serverChild.close();
  } catch (_) { /* ignore */ }
  serverChild = null;
}

async function fetchJson(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}${urlPath}`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body) });
        } catch (err) {
          reject(new Error(`Invalid JSON from ${urlPath}: ${body.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

async function loadPlaywright() {
  try {
    return require('playwright');
  } catch (err) {
    console.error('Playwright required: npm install --save-dev playwright && npx playwright install chromium');
    process.exit(2);
  }
}

async function waitForPortalReady(page) {
  await page.waitForFunction(() => {
    return document.body && !document.body.classList.contains('portal-profile-pending');
  }, null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const sel = document.getElementById('c-client');
    return sel && sel.options.length > 0 && sel.value === 'sunset';
  }, null, { timeout: 30000 });
  const adminTab = page.locator('button.tab-btn[data-tab="admin"]');
  await adminTab.waitFor({ state: 'visible', timeout: 20000 });
}

async function waitForAdminRendered(page) {
  await page.waitForSelector('#tab-admin.tab-panel.active', { timeout: 20000 });
  await page.waitForSelector('.portal-admin-school-heading', { timeout: 20000 });
  await page.waitForFunction(() => {
    const lessons = document.querySelectorAll('#admin-lesson-card-grid .portal-admin-lesson-card').length;
    const prices = document.querySelectorAll('#admin-prices-body .portal-admin-price-card').length;
    const packsTitle = document.querySelector('#admin-times-body .portal-admin-subsection-title');
    return lessons >= 1 && prices >= 1 && packsTitle && packsTitle.textContent.trim().length > 0;
  }, null, { timeout: 25000 });
}

async function runBrowserChecks(playwright) {
  console.log('\n[3] Local Playwright Admin render (both schools)\n');
  const browser = await playwright.chromium.launch({ headless: true });
  const renderResults = [];

  try {
    for (const loc of LOCATIONS) {
      const pageErrors = [];
      const consoleErrors = [];
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      await context.addInitScript(({ client, location }) => {
        localStorage.setItem('staff_portal_client', client);
        localStorage.setItem('staff_portal_sunset_location', location);
        localStorage.setItem('wh_staff_portal_locale', 'en');
      }, { client: 'sunset', location: loc.id });

      await page.goto(`${BASE_URL}/staff/ui`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitForPortalReady(page);

      await page.locator('button.tab-btn[data-tab="admin"]').click();
      await waitForAdminRendered(page);

      const cfgResp = await fetchJson(`/staff/admin/config?client=sunset&location=${encodeURIComponent(loc.id)}`);
      assert(`${loc.id} GET /staff/admin/config 200`, cfgResp.status === 200);
      assert(`${loc.id} GET includes surf_packs array`, Array.isArray(cfgResp.json.surf_packs));
      assert(`${loc.id} GET includes lesson_times array`, Array.isArray(cfgResp.json.lesson_times)
        && cfgResp.json.lesson_times.length > 0);
      assert(`${loc.id} GET location_id matches`, cfgResp.json.location_id === loc.id);

      const snapshot = await page.evaluate(() => {
        const text = (document.body && document.body.innerText) || '';
        const activeAdmin = !!document.querySelector('button.tab-btn[data-tab="admin"].active');
        const business = document.querySelector('#admin-business-body');
        const times = document.querySelector('#admin-times-body');
        const prices = document.querySelector('#admin-prices-body');
        const history = document.querySelector('#admin-history-body');
        const lessonCards = document.querySelectorAll('#admin-lesson-card-grid .portal-admin-lesson-card').length;
        const priceCards = document.querySelectorAll('#admin-prices-body .portal-admin-price-card').length;
        const packSection = document.querySelector('#admin-times-body .portal-admin-subsection-title');
        const schoolHeading = document.querySelector('.portal-admin-school-heading');
        return {
          activeAdmin,
          businessText: business ? business.innerText.trim() : '',
          timesText: times ? times.innerText.trim() : '',
          pricesText: prices ? prices.innerText.trim() : '',
          historyText: history ? history.innerText.trim() : '',
          lessonCards,
          priceCards,
          packSectionText: packSection ? packSection.innerText.trim() : '',
          schoolHeading: schoolHeading ? schoolHeading.innerText.trim() : '',
          bodyText: text,
        };
      });

      const refErrors = [...pageErrors, ...consoleErrors].filter((e) => /ReferenceError/i.test(e));
      assert(`${loc.id} no pageerror`, pageErrors.length === 0, pageErrors.join(' | '));
      assert(`${loc.id} no ReferenceError in console`, refErrors.length === 0, refErrors.join(' | '));
      assert(`${loc.id} Admin tab active`, snapshot.activeAdmin);
      assert(`${loc.id} business body non-empty`, snapshot.businessText.length > 0);
      assert(`${loc.id} lessons/packs body non-empty`, snapshot.timesText.length > 0);
      assert(`${loc.id} rentals body non-empty`, snapshot.pricesText.length > 0);
      assert(`${loc.id} history body non-empty`, snapshot.historyText.length > 0);
      assert(`${loc.id} lesson card present`, snapshot.lessonCards >= 1);
      assert(`${loc.id} rental price card present`, snapshot.priceCards >= 1);
      assert(`${loc.id} surf packs subsection present`, snapshot.packSectionText.length > 0
        && !/^admin\./i.test(snapshot.packSectionText));
      assert(`${loc.id} school heading shows ${loc.schoolLabel}`,
        snapshot.schoolHeading.includes(loc.schoolLabel));

      for (const bad of CORRUPTED_FRAGMENTS) {
        assert(`${loc.id} text does not contain "${bad}"`, !snapshot.bodyText.toLowerCase().includes(bad));
      }
      assert(`${loc.id} text does not expose raw admin.* keys`,
        !/\badmin\.[a-z][a-z0-9_.]+\b/i.test(snapshot.bodyText));

      for (const good of GOOD_FRAGMENTS) {
        assert(`${loc.id} text contains "${good}"`, snapshot.bodyText.toLowerCase().includes(good));
      }
      if (/adult|adolescent/i.test(snapshot.timesText)) {
        assert(`${loc.id} adolescent label intact when lesson labels present`,
          snapshot.bodyText.toLowerCase().includes('adolescent')
          && !snapshot.bodyText.toLowerCase().includes('adole cent'));
      }

      renderResults.push({ location: loc.id, snapshot, pageErrors, refErrors });
      await context.close();
    }
  } finally {
    await browser.close();
  }

  return renderResults;
}

async function runI18nSubprocess() {
  console.log('\n[4] Admin i18n completeness (subprocess)\n');
  const { spawnSync } = require('child_process');
  const child = spawnSync(process.execPath, [path.join(__dirname, 'verify-sunset-admin-i18n.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  assert('verify-sunset-admin-i18n exit 0', child.status === 0, `exit ${child.status}`);
}

async function main() {
  try {
    console.log('\nverify:sunset-admin-render — Sunset Admin regression safety net\n');
    Object.assign(process.env, SERVER_ENV);
    ensureSunsetBaselineForVerify();
    ensureStaffPortalI18nEsForVerify();
    runStaticSourceChecks();
    await runReadModelChecks();
    await runI18nSubprocess();

    const playwright = await loadPlaywright();
    await startLocalServer();
    await runBrowserChecks(playwright);

    console.log('\n' + '─'.repeat(48));
    console.log(`Results: ${pass} passed, ${fail} failed`);
    if (fail > 0) {
      console.error('verify:sunset-admin-render — FAILED');
      process.exitCode = 1;
      return;
    }
    console.log('verify:sunset-admin-render — ALL CHECKS PASSED');
  } finally {
    stopLocalServer();
    cleanupVerifyArtifacts();
  }
}

main().catch((err) => {
  console.error('verify:sunset-admin-render — ERROR:', err.message);
  process.exit(1);
});

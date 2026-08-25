'use strict';

/**
 * Wolfhouse (lodging) Admin tab browser gate.
 *
 * Runs the production-generated /staff/ui and its production owners for both
 * tenants: Wolfhouse must get the new lodging Admin shell, Sunset must keep the
 * surf Admin shell it already had. Nothing here reconstructs markup, copy, or CSS.
 */

const fs = require('fs');
const path = require('path');

process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
process.env.NODE_ENV = 'test';
process.env.STAFF_PORTAL_LOCALES = 'en,es,it';

const WH_CLIENT = 'wolfhouse-somo';
const SUNSET_CLIENT = 'sunset';
const EXPECTED_WH_SUBTABS = ['finance', 'pricing', 'luna-staff', 'services', 'tour-operator', 'email'];
const EXPECTED_WH_LABELS = ['Finance', 'Pricing', 'Luna Staff', 'Camps, Lessons and Services', 'Tour Operator', 'Email'];
// Pricing is no longer a placeholder — scripts/browser/wolfhouse-admin-pricing-ui.js
// owns that panel. Its own gate is verify:wolfhouse-admin-pricing.
const PLACEHOLDER_SUBTABS = ['email'];
const HOSTED_SUBTABS = { 'luna-staff': 'tab-ask-luna', services: 'tab-services', 'tour-operator': 'tab-tour-operator' };
const NESTED_NAV_TABS = ['ask-luna', 'services', 'tour-operator'];

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`); return; }
  failed += 1;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}
function equal(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(label, same, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }
/**
 * Prefer the copy of Playwright that actually has Chromium downloaded.
 * WH_PLAYWRIGHT_PATH is the escape hatch for dev machines where the bundled copy
 * has no browsers.
 */
function loadPlaywright() {
  const candidates = [
    process.env.WH_PLAYWRIGHT_PATH,
    path.join(__dirname, '..', 'node_modules', 'playwright'),
    'playwright',
    '/opt/wolfhouse/WH/node_modules/playwright',
  ].filter(Boolean);
  for (const candidate of candidates) {
    let mod;
    try { mod = require(candidate); } catch (_) { continue; }
    try {
      if (fs.existsSync(mod.chromium.executablePath())) return mod;
    } catch (_) { /* browsers not downloaded for this copy */ }
  }
  console.error('Playwright required: install playwright and Chromium; verifier fails closed.');
  process.exit(2);
}

/**
 * Build the portal HTML for one deploy client in a child-free fresh module
 * registry so the second tenant is not served the first tenant's cached HTML.
 */
function buildHtmlFor(clientSlug) {
  const previous = process.env.DEFAULT_CLIENT_SLUG;
  process.env.DEFAULT_CLIENT_SLUG = clientSlug;
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}scripts${path.sep}`)) delete require.cache[key];
  }
  process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
  const api = require('./staff-query-api');
  if (typeof api.buildUiHtmlForOfflineTest !== 'function') {
    throw new Error('Production staff UI builder seam is unavailable');
  }
  const html = api.buildUiHtmlForOfflineTest(0, clientSlug);
  process.env.DEFAULT_CLIENT_SLUG = previous;
  return html;
}

function createPortalServer(html) {
  const http = require('http');
  const url = require('url');
  const { buildClientProfilesMap, getAccessibleClients } = require('./lib/staff-portal-clients');
  function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  }
  return http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';
    if (pathname === '/staff/ui') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (pathname === '/staff/auth/session') {
      return sendJson(res, 200, {
        success: true,
        auth_required: false,
        role: 'owner',
        email: null,
        display_name: null,
        clients: getAccessibleClients(null),
        client_profiles: buildClientProfilesMap(null),
        can_use_owner_insights: true,
      });
    }
    if (pathname.startsWith('/staff/assets/')) { res.writeHead(204); return res.end(); }
    if (pathname.startsWith('/staff/')) {
      return sendJson(res, 200, { success: true, rows: [], conversations: [], offerings: [], services: [], days: [], counts: {} });
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
}

async function openPortal(context, base, clientSlug) {
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err.message || err)));
  await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction((slug) => {
    const select = document.getElementById('c-client');
    return document.body
      && !document.body.classList.contains('portal-profile-pending')
      && select && select.value === slug;
  }, clientSlug, { timeout: 30000 });
  return { page, pageErrors };
}

function navVisibility(page) {
  return page.evaluate(() => {
    const out = {};
    document.querySelectorAll('.tab-btn[data-tab]').forEach((btn) => {
      out[btn.getAttribute('data-tab')] = btn.style.display !== 'none';
    });
    return out;
  });
}

async function runWolfhouse(playwright, browser) {
  console.log('\n[1] Wolfhouse portal — lodging Admin shell\n');
  const server = createPortalServer(buildHtmlFor(WH_CLIENT));
  const base = await listen(server);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript((slug) => {
    localStorage.setItem('staff_portal_client', slug);
    localStorage.setItem('wh_staff_portal_locale', 'en');
  }, WH_CLIENT);
  const { page, pageErrors } = await openPortal(context, base, WH_CLIENT);

  try {
    const nav = await navVisibility(page);
    check('Admin nav tab is visible for Wolfhouse', nav.admin === true, JSON.stringify(nav));
    for (const tab of NESTED_NAV_TABS) {
      check(`top-level "${tab}" nav tab is hidden (now inside Admin)`, nav[tab] === false, JSON.stringify(nav));
    }
    check('Booking Calendar nav stays visible', nav['bed-calendar'] === true, JSON.stringify(nav));

    await page.locator('button.tab-btn[data-tab="admin"]').click();
    await page.waitForSelector('#tab-admin.tab-panel.active', { timeout: 20000 });

    const shells = await page.evaluate(() => ({
      sunsetHidden: document.getElementById('admin-sunset-shell')?.hidden,
      whHidden: document.getElementById('admin-wh-shell')?.hidden,
    }));
    check('Sunset admin shell is hidden for Wolfhouse', shells.sunsetHidden === true, JSON.stringify(shells));
    check('Wolfhouse admin shell is shown', shells.whHidden === false, JSON.stringify(shells));

    const subTabs = await page.evaluate(() => Array.prototype.slice
      .call(document.querySelectorAll('#wh-admin-subtab-list [data-wh-admin-tab]:not([hidden])'))
      .map((btn) => ({ key: btn.getAttribute('data-wh-admin-tab'), label: btn.textContent.trim(), selected: btn.getAttribute('aria-selected') })));
    equal('Wolfhouse Admin sub-tab order', subTabs.map((s) => s.key), EXPECTED_WH_SUBTABS);
    equal('Wolfhouse Admin sub-tab labels (EN)', subTabs.map((s) => s.label), EXPECTED_WH_LABELS);
    equal('Finance is the default selected sub-tab',
      subTabs.filter((s) => s.selected === 'true').map((s) => s.key), ['finance']);

    for (const key of PLACEHOLDER_SUBTABS) {
      await page.locator(`#wh-admin-tab-${key}`).click();
      const state = await page.evaluate((subKey) => {
        const panel = document.getElementById(`wh-admin-panel-${subKey}`);
        return { hidden: panel?.hidden, text: (panel?.innerText || '').trim() };
      }, key);
      check(`"${key}" placeholder panel is visible`, state.hidden === false, JSON.stringify(state));
      check(`"${key}" panel shows the not-built-yet placeholder`,
        /Not built yet\./.test(state.text), state.text.slice(0, 120));
    }

    for (const [key, panelId] of Object.entries(HOSTED_SUBTABS)) {
      await page.locator(`#wh-admin-tab-${key}`).click();
      const state = await page.evaluate(([subKey, hostedId]) => {
        const wrapper = document.getElementById(`wh-admin-panel-${subKey}`);
        const hosted = document.getElementById(hostedId);
        return {
          wrapperHidden: wrapper?.hidden,
          parentId: hosted?.parentElement?.id || null,
          active: !!hosted?.classList.contains('active'),
          visible: !!(hosted && hosted.getClientRects().length),
        };
      }, [key, panelId]);
      check(`"${key}" sub-tab panel is visible`, state.wrapperHidden === false, JSON.stringify(state));
      check(`"${panelId}" is moved into wh-admin-panel-${key}`,
        state.parentId === `wh-admin-panel-${key}`, JSON.stringify(state));
      check(`"${panelId}" is active and rendered`, state.active && state.visible, JSON.stringify(state));
    }

    // Only one hosted panel may be active at a time.
    const activeHosted = await page.evaluate((ids) => ids.filter((id) => {
      const node = document.getElementById(id);
      return !!node && node.classList.contains('active');
    }), Object.values(HOSTED_SUBTABS));
    equal('exactly one hosted panel is active', activeHosted, ['tab-tour-operator']);

    check('no uncaught page errors on Wolfhouse Admin', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await context.close();
    await close(server);
  }
}

async function runSunsetRegression(playwright, browser) {
  console.log('\n[2] Sunset portal — surf Admin shell unchanged\n');
  const server = createPortalServer(buildHtmlFor(SUNSET_CLIENT));
  const base = await listen(server);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript((slug) => {
    localStorage.setItem('staff_portal_client', slug);
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  }, SUNSET_CLIENT);
  const { page, pageErrors } = await openPortal(context, base, SUNSET_CLIENT);

  try {
    const nav = await navVisibility(page);
    check('Admin nav tab is visible for Sunset', nav.admin === true, JSON.stringify(nav));
    check('Sunset keeps Luna Staff nested (top-level hidden)', nav['ask-luna'] === false, JSON.stringify(nav));

    await page.locator('button.tab-btn[data-tab="admin"]').click();
    await page.waitForSelector('#tab-admin.tab-panel.active', { timeout: 20000 });

    const shells = await page.evaluate(() => ({
      sunsetHidden: document.getElementById('admin-sunset-shell')?.hidden,
      whHidden: document.getElementById('admin-wh-shell')?.hidden,
      lunaParent: document.getElementById('tab-ask-luna')?.parentElement?.id || null,
      subTabs: Array.prototype.slice
        .call(document.querySelectorAll('#admin-subtab-list [data-admin-tab]'))
        .map((btn) => btn.getAttribute('data-admin-tab')),
    }));
    check('Sunset admin shell stays visible', shells.sunsetHidden === false, JSON.stringify(shells));
    check('Wolfhouse admin shell stays hidden for Sunset', shells.whHidden === true, JSON.stringify(shells));
    // Sunset moved Bookings to a top-level tab; Admin keeps Finance/Pricing/Luna Staff.
    equal('Sunset Admin sub-tabs unchanged', shells.subTabs, ['finance', 'pricing', 'luna-staff']);
    equal('Sunset Luna Staff panel still hosted by the Sunset shell', shells.lunaParent, 'admin-panel-luna-staff');

    check('no uncaught page errors on Sunset Admin', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await context.close();
    await close(server);
  }
}

async function main() {
  const playwright = loadPlaywright();
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    await runWolfhouse(playwright, browser);
    await runSunsetRegression(playwright, browser);
  } finally {
    await browser.close();
  }

  console.log(`\n── wolfhouse-admin-tabs: ${passed} passed, ${failed} failed ──`);
  if (failed) {
    console.error('verify:wolfhouse-admin-tabs — FAILED');
    process.exit(1);
  }
  console.log('verify:wolfhouse-admin-tabs — ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

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
const PLACEHOLDER_SUBTABS = [];
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

async function runRealTourOperatorScenario(browser, base, operation, outcome, refreshMode) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript((slug) => {
    window.__staffUiTestHooks = { refreshTimeoutMs: 50 };
    localStorage.setItem('staff_portal_client', slug);
    localStorage.setItem('wh_staff_portal_locale', 'en');
  }, WH_CLIENT);
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  const mutationPath = operation === 'op' ? '/staff/tour-operator/blocks/create' : '/staff/tour-operator/release';
  await page.route(`**${mutationPath}`, async (route) => {
    if (outcome === 'uncertain') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
    }
    if (outcome === 'blocked') {
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'guest_conflict' }) });
    }
    const body = operation === 'op'
      ? { success: true, booking: { booking_code: 'TEST-BLOCK', room_code: 'R1', check_in: '2026-10-10', check_out: '2026-10-12' } }
      : { success: true, release: {} };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction((slug) => document.getElementById('c-client')?.value === slug, WH_CLIENT);
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.locator('#wh-admin-tab-tour-operator').click();
  await page.locator(operation === 'op' ? '#staff-room-block-toggle' : '#staff-room-release-toggle').click();
  await page.evaluate(({ operation, refreshMode }) => {
    const addOption = (id, value, data) => {
      const select = document.getElementById(id);
      const option = document.createElement('option');
      option.value = value; option.textContent = value;
      Object.assign(option.dataset, data || {});
      select.appendChild(option); select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    document.getElementById('bc-start').value = '2026-10-10';
    document.getElementById('bc-end').value = '2026-10-12';
    if (operation === 'op') {
      document.getElementById('to-op-name').value = 'Test Operator';
      document.getElementById('to-op-cin').value = '2026-10-10';
      document.getElementById('to-op-cout').value = '2026-10-12';
      addOption('to-op-room', 'R1');
      document.getElementById('to-op-name').dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      addOption('to-rr-block-select', 'block-1', { cin: '2026-10-10', cout: '2026-10-12', room: 'R1' });
      addOption('to-rr-room', 'R1');
      document.getElementById('to-rr-start').value = '2026-10-10';
      document.getElementById('to-rr-end').value = '2026-10-12';
      document.getElementById('to-rr-start').dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (!refreshMode) return;
    const h = window.__staffUiTestHooks;
    let blocks = (cb) => cb(true);
    let calendar = (cb) => cb({}, true);
    if (refreshMode === 'blockFalse') blocks = (cb) => cb(false);
    if (refreshMode === 'blockUndefined') blocks = (cb) => cb(undefined);
    if (refreshMode === 'blockThrow') blocks = () => { throw new Error('block refresh throw'); };
    if (refreshMode === 'blockReject') blocks = () => Promise.reject(new Error('block refresh reject'));
    if (refreshMode === 'blockNoCallback') blocks = () => undefined;
    if (refreshMode === 'missingBlockLoader') blocks = undefined;
    if (refreshMode === 'calendarFalse') calendar = (cb) => cb({}, false);
    if (refreshMode === 'calendarUndefined') calendar = (cb) => cb({}, undefined);
    if (refreshMode === 'calendarThrow') calendar = () => { throw new Error('calendar refresh throw'); };
    if (refreshMode === 'calendarReject') calendar = () => Promise.reject(new Error('calendar refresh reject'));
    if (refreshMode === 'calendarNoCallback') calendar = () => undefined;
    if (refreshMode === 'missingCalendarLoader') calendar = undefined;
    if (refreshMode === 'missingDates') {
      document.getElementById('bc-start').value = '';
      document.getElementById('bc-end').value = '';
    }
    h.setTourOperatorRefreshLoaders(blocks, calendar);
  }, { operation, refreshMode });
  const button = operation === 'op' ? '#to-op-create-btn' : '#to-rr-release-btn';
  const result = operation === 'op' ? '#to-op-result' : '#to-rr-result';
  await page.locator(button).click();
  await page.waitForFunction((selector) => {
    const node = document.querySelector(selector);
    return node && node.style.display === 'block' && node.textContent.trim();
  }, result);
  if (outcome === 'uncertain') await page.waitForTimeout(/NoCallback$/.test(refreshMode || '') ? 80 : 20);
  const observed = await page.locator(result).evaluate((node) => ({
    role: node.getAttribute('role'), live: node.getAttribute('aria-live'), text: node.textContent,
  }));
  const retry = await page.evaluate(() => window.__staffUiTestHooks.getTourOperatorRetryState());
  await context.close();
  return { observed, retry };
}

async function verifyRealTourOperatorFlows(browser, base) {
  for (const operation of ['op', 'rr']) {
    for (const outcome of ['success', 'blocked']) {
      const got = await runRealTourOperatorScenario(browser, base, operation, outcome, null);
      const success = outcome === 'success';
      equal(`${operation} real ${outcome} announcement`, { role: got.observed.role, live: got.observed.live },
        success ? { role: 'status', live: 'polite' } : { role: 'alert', live: 'assertive' });
    }
    for (const mode of [
      'blockFalse', 'blockUndefined', 'blockThrow', 'blockReject', 'blockNoCallback', 'missingBlockLoader',
      'calendarFalse', 'calendarUndefined', 'calendarThrow', 'calendarReject', 'calendarNoCallback', 'missingCalendarLoader',
      'missingDates', 'trueTrue',
    ]) {
      const got = await runRealTourOperatorScenario(browser, base, operation, 'uncertain', mode);
      equal(`${operation} real uncertain ${mode} announcement`, { role: got.observed.role, live: got.observed.live },
        { role: 'alert', live: 'assertive' });
      if (mode !== 'trueTrue') {
        check(`${operation} refresh ${mode} shows translated recovery message`,
          got.observed.text.includes('Refresh the block list and calendar before retrying.'), got.observed.text);
      }
      const hold = operation === 'op' ? got.retry.opHold : got.retry.rrHold;
      const disabled = operation === 'op' ? got.retry.opDisabled : got.retry.rrDisabled;
      equal(`${operation} retry ${mode}`, { hold, disabled },
        mode === 'trueTrue' ? { hold: false, disabled: false } : { hold: true, disabled: true });
    }
  }
}

async function runWolfhouse(playwright, browser) {
  console.log('\n[1] Wolfhouse portal — lodging Admin shell\n');
  const server = createPortalServer(buildHtmlFor(WH_CLIENT));
  const base = await listen(server);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript((slug) => {
    window.__staffUiTestHooks = {};
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

    // Drive production Room Block and Room Release submit handlers. Responses and
    // refresh dependencies vary, but no result renderer is invoked by the test.
    await verifyRealTourOperatorFlows(browser, base);

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
    window.__staffUiTestHooks = {};
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

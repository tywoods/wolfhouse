'use strict';

/**
 * Wolfhouse Admin > Pricing browser gate.
 *
 * Runs the production-generated /staff/ui and the real pricing UI module in
 * Chromium. Nothing here reconstructs markup, copy or CSS.
 *
 * The stub API is deliberately only stubbed at the SQL layer: it serves the
 * real buildAdminPricingView payload and validates writes with the real
 * wolfhouse-pricing-writes validators, keeping the overlay in memory. So this
 * gate exercises the real UI against the real payload shape and the real
 * validation rules without needing Postgres. The SQL itself is covered offline
 * by verify:wolfhouse-admin-pricing.
 *
 * Sunset is a read-only control in this gate: it must keep its own Admin shell
 * and must never render the Wolfhouse pricing body.
 */

const fs = require('fs');
const path = require('path');

process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
process.env.NODE_ENV = 'test';
process.env.STAFF_PORTAL_LOCALES = 'en,es,it';

const WH_CLIENT = 'wolfhouse-somo';
const SUNSET_CLIENT = 'sunset';

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`); return; }
  failed += 1;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }

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

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => resolve(raw));
  });
}

/**
 * Portal server with a real-payload pricing API over an in-memory overlay.
 * `writesEnabled` drives the read-only path exactly as the env flag would.
 */
function createPricingPortalServer(html, options) {
  const opts = options || {};
  const http = require('http');
  const url = require('url');
  const { buildClientProfilesMap, getAccessibleClients } = require('./lib/staff-portal-clients');
  const resolve = require('./lib/wolfhouse-pricing-resolve');
  const writes = require('./lib/wolfhouse-pricing-writes');
  const { getClientTransferConfig } = require('./lib/client-transfer-config');

  const overlay = { seasons: [], rules: [], items: [], transfers: [] };
  const config = resolve.loadPricingConfig();
  const transferConfig = getClientTransferConfig(WH_CLIENT);

  function view() {
    const v = resolve.buildAdminPricingView({
      config,
      transferConfig,
      dbSeasons: overlay.seasons,
      dbRules: overlay.rules,
      dbItems: overlay.items,
      dbTransferRules: overlay.transfers,
      writesEnabled: opts.writesEnabled !== false,
    });
    v.overlay_available = true;
    return v;
  }

  function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function upsert(list, matchFn, value) {
    const idx = list.findIndex(matchFn);
    if (idx >= 0) list[idx] = value; else list.push(value);
  }

  function gate(res) {
    if (opts.writesEnabled === false) {
      sendJson(res, 403, { success: false, error: 'writes_disabled' });
      return false;
    }
    return true;
  }

  return http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';
    const method = (req.method || 'GET').toUpperCase();

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

    if (pathname === '/staff/admin/wh/pricing' && method === 'GET') {
      return sendJson(res, 200, Object.assign({ success: true }, view()));
    }
    if (pathname === '/staff/admin/wh/pricing/seasons' && method === 'PUT') {
      if (!gate(res)) return undefined;
      const parsedBody = writes.validateSeasonBody(JSON.parse((await readBody(req)) || '{}'));
      if (!parsedBody.ok) return sendJson(res, 400, { success: false, error: parsedBody.error });
      upsert(overlay.seasons, (s) => s.code === parsedBody.value.code,
        Object.assign({ active: true }, parsedBody.value));
      return sendJson(res, 200, Object.assign({ success: true }, view()));
    }
    if (pathname === '/staff/admin/wh/pricing/prices' && method === 'PUT') {
      if (!gate(res)) return undefined;
      const parsedBody = writes.validatePriceRuleBody(JSON.parse((await readBody(req)) || '{}'));
      if (!parsedBody.ok) return sendJson(res, 400, { success: false, error: parsedBody.error });
      const v = parsedBody.value;
      upsert(overlay.rules, (r) => r.item_type === v.item_type
        && r.item_code === v.item_code
        && (r.season_code || null) === (v.season_code || null), v);
      return sendJson(res, 200, Object.assign({ success: true }, view()));
    }
    if (pathname === '/staff/admin/wh/pricing/items' && method === 'PUT') {
      if (!gate(res)) return undefined;
      const parsedBody = writes.validateItemBody(JSON.parse((await readBody(req)) || '{}'));
      if (!parsedBody.ok) return sendJson(res, 400, { success: false, error: parsedBody.error });
      const v = parsedBody.value;
      upsert(overlay.items, (i) => i.item_type === v.item_type && i.item_code === v.item_code, v);
      return sendJson(res, 200, Object.assign({ success: true }, view()));
    }
    if (pathname === '/staff/admin/wh/pricing/transfers' && method === 'PUT') {
      if (!gate(res)) return undefined;
      const parsedBody = writes.validateTransferRuleBody(JSON.parse((await readBody(req)) || '{}'));
      if (!parsedBody.ok) return sendJson(res, 400, { success: false, error: parsedBody.error });
      const v = parsedBody.value;
      upsert(overlay.transfers, (tr) => tr.airport_code === v.airport_code, v);
      return sendJson(res, 200, Object.assign({ success: true }, view()));
    }
    const seasonDelete = /^\/staff\/admin\/wh\/pricing\/seasons\/([^/?]+)$/.exec(pathname);
    if (seasonDelete && method === 'DELETE') {
      if (!gate(res)) return undefined;
      const code = decodeURIComponent(seasonDelete[1]);
      overlay.seasons = overlay.seasons.filter((s) => s.code !== code);
      overlay.seasons.push({ code, active: false });
      return sendJson(res, 200, Object.assign({ success: true }, view()));
    }

    if (pathname.startsWith('/staff/assets/')) { res.writeHead(204); return res.end(); }
    if (pathname.startsWith('/staff/')) {
      return sendJson(res, 200, {
        success: true, rows: [], conversations: [], offerings: [], services: [], days: [], counts: {},
      });
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not found');
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

async function openPricingTab(page) {
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.waitForSelector('#tab-admin.tab-panel.active', { timeout: 20000 });
  await page.locator('#wh-admin-tab-pricing').click();
  await page.waitForFunction(() => {
    const body = document.getElementById('wh-admin-pricing-body');
    return body && /Seasons/.test(body.innerText || '');
  }, null, { timeout: 20000 });
}

function pricingText(page) {
  return page.evaluate(() => {
    const body = document.getElementById('wh-admin-pricing-body');
    return (body && body.innerText) || '';
  });
}

async function runEditable(playwright, browser) {
  console.log('\n[1] Wolfhouse Pricing — editable\n');
  const server = createPricingPortalServer(buildHtmlFor(WH_CLIENT), { writesEnabled: true });
  const base = await listen(server);
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.addInitScript((slug) => {
    localStorage.setItem('staff_portal_client', slug);
    localStorage.setItem('wh_staff_portal_locale', 'en');
  }, WH_CLIENT);
  const { page, pageErrors } = await openPortal(context, base, WH_CLIENT);

  try {
    await openPricingTab(page);
    const text = await pricingText(page);

    check('Pricing no longer shows the not-built-yet placeholder',
      !/Not built yet/.test(text), text.slice(0, 160));
    for (const section of ['Seasons', 'Packages', 'Rentals', 'Services', 'Transfers', 'Extras']) {
      check(`"${section}" section renders`, text.includes(section));
    }
    check('Full day section renders', /Full day/.test(text));
    check('a package price shows in euros', text.includes('€349.00'), text.slice(0, 400));
    check('season names are readable, not raw codes',
      text.includes('Spring Autumn') && !text.includes('spring_autumn'));
    check('an unpriced season reads Not set', text.includes('Not set'));
    check('a transfer shows its airport code', text.includes('(SDR)'));
    check('no read-only banner in editable mode', !/Read-only/.test(text));

    // Edit an existing package price end to end.
    await page.locator('[data-wh-price-action="edit-package-price"][data-wh-season="august"]')
      .first().click();
    await page.waitForSelector('#wh-price-amount', { timeout: 10000 });
    await page.fill('#wh-price-amount', '375.00');
    await page.locator('[data-wh-price-action="save-package-price"]').first().click();
    await page.waitForFunction(() => {
      const body = document.getElementById('wh-admin-pricing-body');
      return body && /€375\.00/.test(body.innerText || '');
    }, null, { timeout: 15000 });
    const afterEdit = await pricingText(page);
    check('saving a package price shows the new amount', afterEdit.includes('€375.00'));
    check('a saved price is marked edited', afterEdit.includes('edited'));
    check('saving confirms with a notice', /Saved\./.test(afterEdit));

    // Server-side validation must surface, not fail silently.
    const rentalEdit = page.locator('[data-wh-price-action="edit-rental-price"]').first();
    await rentalEdit.click();
    await page.waitForSelector('#wh-price-amount', { timeout: 10000 });
    await page.fill('#wh-price-amount', '0');
    await page.locator('[data-wh-price-action="save-rental-price"]').first().click();
    await page.waitForFunction(() => {
      const body = document.getElementById('wh-admin-pricing-body');
      return body && /greater than zero/.test(body.innerText || '');
    }, null, { timeout: 15000 });
    check('a rejected zero price surfaces the server reason', true);

    // Add-range must not lose the draft (regression for the season draft bug).
    await page.locator('[data-wh-price-action="cancel"]').first().click();
    await page.locator('[data-wh-price-action="new-season"]').click();
    await page.waitForSelector('#wh-price-season-code', { timeout: 10000 });
    const rangesBefore = await page.locator('.wh-price-range-row').count();
    await page.fill('#wh-price-season-label', 'Shoulder');
    await page.locator('[data-wh-price-action="add-range"]').click();
    await page.waitForFunction((n) => document
      .querySelectorAll('.wh-price-range-row').length === n + 1, rangesBefore, { timeout: 10000 });
    const rangesAfter = await page.locator('.wh-price-range-row').count();
    check('Add range adds a row', rangesAfter === rangesBefore + 1);
    const keptLabel = await page.inputValue('#wh-price-season-label');
    check('Add range keeps what was already typed', keptLabel === 'Shoulder', keptLabel);

    // Save the new season.
    await page.fill('#wh-price-season-code', 'shoulder');
    await page.locator('[data-wh-price-action="save-season"]').click();
    await page.waitForFunction(() => {
      const body = document.getElementById('wh-admin-pricing-body');
      return body && /Shoulder/.test(body.innerText || '');
    }, null, { timeout: 15000 });
    const afterSeason = await pricingText(page);
    check('a new season appears in the list', afterSeason.includes('Shoulder'));
    check('a new season becomes a package price slot',
      (afterSeason.match(/Shoulder/g) || []).length > 1, 'expected season + package slot');

    check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await context.close();
    await close(server);
  }
}

async function runReadOnly(playwright, browser) {
  console.log('\n[2] Wolfhouse Pricing — writes disabled\n');
  const server = createPricingPortalServer(buildHtmlFor(WH_CLIENT), { writesEnabled: false });
  const base = await listen(server);
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.addInitScript((slug) => {
    localStorage.setItem('staff_portal_client', slug);
    localStorage.setItem('wh_staff_portal_locale', 'en');
  }, WH_CLIENT);
  const { page, pageErrors } = await openPortal(context, base, WH_CLIENT);

  try {
    await openPricingTab(page);
    const text = await pricingText(page);
    check('read-only mode explains itself', /Read-only/.test(text), text.slice(0, 200));
    check('read-only mode still shows prices', text.includes('€349.00'));
    const editCount = await page.locator('[data-wh-price-action^="edit-"]').count();
    const newCount = await page.locator('[data-wh-price-action^="new-"]').count();
    const delCount = await page.locator('[data-wh-price-action^="delete-"]').count();
    check('read-only mode renders no write controls',
      editCount === 0 && newCount === 0 && delCount === 0,
      `edit=${editCount} new=${newCount} delete=${delCount}`);
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await context.close();
    await close(server);
  }
}

/** Sunset is a control: it must be untouched by any of this. */
async function runSunsetControl(playwright, browser) {
  console.log('\n[3] Sunset portal — unchanged control\n');
  const server = createPricingPortalServer(buildHtmlFor(SUNSET_CLIENT), { writesEnabled: true });
  const base = await listen(server);
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.addInitScript((slug) => {
    localStorage.setItem('staff_portal_client', slug);
    localStorage.setItem('wh_staff_portal_locale', 'en');
  }, SUNSET_CLIENT);
  const { page, pageErrors } = await openPortal(context, base, SUNSET_CLIENT);

  try {
    await page.locator('button.tab-btn[data-tab="admin"]').click();
    await page.waitForSelector('#tab-admin.tab-panel.active', { timeout: 20000 });

    const shells = await page.evaluate(() => ({
      sunsetHidden: document.getElementById('admin-sunset-shell')?.hidden,
      whHidden: document.getElementById('admin-wh-shell')?.hidden,
      whPricingText: (document.getElementById('wh-admin-pricing-body')?.innerText || '').trim(),
      subTabs: Array.from(document.querySelectorAll('#admin-subtab-list [data-admin-tab]'))
        .map((b) => b.getAttribute('data-admin-tab')),
    }));

    check('Sunset keeps its own Admin shell', shells.sunsetHidden === false,
      JSON.stringify(shells));
    check('the Wolfhouse Admin shell stays hidden for Sunset', shells.whHidden === true,
      JSON.stringify(shells));
    check('the Wolfhouse pricing body renders nothing for Sunset',
      shells.whPricingText === '', shells.whPricingText.slice(0, 120));
    check('Sunset Admin sub-tabs are unchanged',
      JSON.stringify(shells.subTabs) === JSON.stringify(['finance', 'pricing', 'luna-staff']),
      JSON.stringify(shells.subTabs));
    check('no uncaught page errors on Sunset', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await context.close();
    await close(server);
  }
}

(async function main() {
  const playwright = loadPlaywright();
  const browser = await playwright.chromium.launch();
  try {
    await runEditable(playwright, browser);
    await runReadOnly(playwright, browser);
    await runSunsetControl(playwright, browser);
  } finally {
    await browser.close();
  }
  console.log('\n────────────────────────────────────────────────');
  console.log(`verify:wolfhouse-admin-pricing-ui — ${failed ? 'FAILED' : 'PASSED'}`);
  console.log(`Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('verifier crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});

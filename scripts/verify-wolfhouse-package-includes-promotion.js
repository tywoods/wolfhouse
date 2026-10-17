'use strict';

/**
 * R1356-1 — seeded package copy must survive catalog promotion.
 *
 * Native editor save → real pricing route (promoteConfigCatalogToStaffItems
 * still runs) → direct SQL → fresh document's Malibu editor, at 1280 and 390.
 * A space-label control (Malibu VIP) is paired with the underscore name
 * (Malibu_VIP) at each width.
 *
 * Auth/session and non-pricing staff routes are synthetic and labeled.
 * The pricing route, store, validator, promotion, and generated Staff page
 * are real. Persistence is isolated local PGlite, not live Postgres.
 * Underscore names stay allowed. Promotion is not mocked away.
 */

const http = require('http');
const { PGlite } = require('@electric-sql/pglite');
const { chromium } = require('playwright');

process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
process.env.NODE_ENV = 'test';
process.env.STAFF_PORTAL_LOCALES = 'en,es,it';
process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
process.env.DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';
process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = 'true';

const { createWolfhousePricingRoutes } = require('./lib/wolfhouse-pricing-routes');
const { buildClientProfilesMap, getAccessibleClients } = require('./lib/staff-portal-clients');

const BASE = '/staff/admin/wh/pricing';
const CLIENT = 'wolfhouse-somo';
const ADMIN = {
  role: 'admin',
  staff_user_id: '00000000-0000-4000-8000-000000000001',
};
const COPY = {
  description: 'comes with a free t-shirt',
  include: 'Airport transfer',
  minDays: '9',
  prorate: false,
};

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

function metaOf(row) {
  const raw = row && row.metadata;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw) {
    try { return JSON.parse(raw); } catch (_) { return {}; }
  }
  return {};
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function openDb() {
  const db = new PGlite();
  await db.waitReady;
  const pg = {
    query: async (sql, params) => {
      if (!params && String(sql).includes('CREATE TABLE')) {
        await db.exec(sql);
        return { rows: [], rowCount: 0 };
      }
      const result = await db.query(sql, params);
      return Object.assign({}, result, { rowCount: result.affectedRows });
    },
  };
  const routes = createWolfhousePricingRoutes({
    sendJSON: (res, status, body) => Object.assign(res, { status, body }),
    send400: (res, error) => Object.assign(res, { status: 400, body: { success: false, error } }),
    readBody: async (req) => req.body,
    assertStaffClientAccess: () => true,
    appendAuditLog: () => {},
    withPgClient: (run) => run(pg),
    DEFAULT_CLIENT: CLIENT,
    SQL_INJECT_RE: /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i,
    STAFF_AUTH_REQUIRED: true,
    resolveStaffRole: (user) => String((user && user.role) || '').toLowerCase(),
  });
  return { db, routes };
}

async function callRoute(routes, pathname, method, rawBody, query) {
  const handler = routes.match(pathname, method);
  if (typeof handler !== 'function') return null;
  const res = {};
  await handler(
    { client: (query && query.client) || CLIENT },
    { body: rawBody == null ? '' : rawBody },
    res,
    ADMIN,
  );
  return res;
}

async function malibuRow(db) {
  const sql = await db.query(
    `SELECT label, description, metadata
       FROM wh_pricing_items
      WHERE client_slug = $1 AND item_type = 'package' AND item_code = 'malibu' AND active = true`,
    [CLIENT],
  );
  return sql.rows[0] || null;
}

function expectStored(row, label, where) {
  const meta = metaOf(row);
  const includes = Array.isArray(meta.includes) ? meta.includes.join('|') : '';
  check(`${where}: SQL keeps the staff name`, !!(row && row.label === label), JSON.stringify(row));
  check(`${where}: SQL keeps the description`, !!(row && row.description === COPY.description), JSON.stringify(row));
  check(`${where}: SQL keeps Includes`, includes === COPY.include, JSON.stringify(meta));
  check(`${where}: SQL keeps minimum days`, Number(meta.min_days) === Number(COPY.minDays), JSON.stringify(meta));
  check(`${where}: SQL keeps proration off`, meta.allow_daily_proration === false, JSON.stringify(meta));
  check(`${where}: SQL does not replace metadata with a promotion stamp`,
    !(meta.promoted_from === 'config' && !meta.includes),
    JSON.stringify(meta));
}

async function seedThenSave(routes, db, label) {
  const seeded = await callRoute(routes, BASE, 'GET', '', { client: CLIENT });
  check('missing-item seeding returns the catalog', seeded && seeded.status === 200 && seeded.body && seeded.body.success);
  const before = await malibuRow(db);
  check('missing Malibu is seeded with the config name', !!(before && before.label === 'Malibu'), JSON.stringify(before));
  check('a seeded Malibu has no staff description yet', !!(before && before.description == null), JSON.stringify(before));

  const body = JSON.stringify({
    item_type: 'package',
    item_code: 'malibu',
    label,
    description: COPY.description,
    metadata: {
      pebble: 'peach',
      min_days: Number(COPY.minDays),
      allow_daily_proration: false,
      includes: [COPY.include],
    },
  });
  const saved = await callRoute(routes, `${BASE}/items`, 'PUT', body, { client: CLIENT });
  check(`${label}: full handler returns 200`, saved && saved.status === 200, JSON.stringify(saved && saved.status));
  const viewPkg = saved && saved.body && (saved.body.packages || []).find((pkg) => pkg.code === 'malibu');
  check(`${label}: handler view keeps the name`, !!(viewPkg && viewPkg.label === label), JSON.stringify(viewPkg && viewPkg.label));
  check(`${label}: handler view keeps the description`, !!(viewPkg && viewPkg.description === COPY.description));
  check(`${label}: handler view keeps Includes`, !!(viewPkg && Array.isArray(viewPkg.includes) && viewPkg.includes.join('|') === COPY.include));
  expectStored(await malibuRow(db), label, `${label} after handler`);

  const reread = await callRoute(routes, BASE, 'GET', '', { client: CLIENT });
  const again = reread && reread.body && (reread.body.packages || []).find((pkg) => pkg.code === 'malibu');
  check(`${label}: a later read still returns the staff name`, !!(again && again.label === label), JSON.stringify(again && again.label));
  expectStored(await malibuRow(db), label, `${label} after second promotion`);
}

function buildHtml() {
  const api = require('./staff-query-api');
  if (typeof api.buildUiHtmlForOfflineTest !== 'function') {
    throw new Error('Production staff UI builder seam is unavailable');
  }
  return api.buildUiHtmlForOfflineTest(0, CLIENT);
}

function createPortal(html, routes, ledger) {
  return http.createServer(async (req, res) => {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    const pathname = parsed.pathname;
    const method = (req.method || 'GET').toUpperCase();
    const entry = { method, path: pathname, disposition: 'unhandled' };
    ledger.push(entry);

    function sendJson(status, body, disposition) {
      entry.disposition = disposition;
      entry.status = status;
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
    }

    if (pathname === '/staff/ui' && method === 'GET') {
      entry.disposition = 'emitted-staff-page';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (pathname === '/staff/auth/session' && method === 'GET') {
      sendJson(200, {
        success: true,
        auth_required: false,
        role: 'owner',
        email: null,
        display_name: null,
        clients: getAccessibleClients(null),
        client_profiles: buildClientProfilesMap(null),
        can_use_owner_insights: true,
      }, 'synthetic-auth');
      return;
    }
    if (pathname.startsWith('/staff/admin/wh/pricing')) {
      const raw = method === 'GET' ? '' : await readRawBody(req);
      entry.requestBody = raw;
      const query = Object.fromEntries(parsed.searchParams.entries());
      const result = await callRoute(routes, pathname, method, raw, query);
      if (!result) {
        sendJson(404, { success: false, error: 'pricing route not registered' }, 'pricing-unhandled');
        return;
      }
      entry.responseLabel = result.body && result.body.packages
        ? (result.body.packages.find((pkg) => pkg.code === 'malibu') || {}).label
        : null;
      sendJson(result.status || 500, result.body || { success: false }, 'real-pricing-route');
      return;
    }
    if (pathname.startsWith('/staff/assets/')) {
      entry.disposition = 'synthetic-asset';
      res.writeHead(204);
      res.end();
      return;
    }
    if (pathname.startsWith('/staff/')) {
      sendJson(200, {
        success: true,
        rows: [],
        conversations: [],
        offerings: [],
        services: [],
        days: [],
        counts: {},
      }, 'synthetic-ancillary');
      return;
    }
    entry.disposition = 'not-found';
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
}

async function openMalibuEditor(page) {
  const admin = page.locator('button.tab-btn[data-tab="admin"]');
  if (!(await admin.isVisible())) {
    await page.locator('#nav-menu-toggle').click();
  }
  await admin.click();
  await page.waitForSelector('#tab-admin.tab-panel.active', { timeout: 20000 });
  await page.locator('#wh-admin-tab-pricing').click();
  await page.waitForFunction(() => {
    const body = document.getElementById('wh-admin-pricing-body');
    return body && /packages/i.test(body.innerText || '');
  }, null, { timeout: 60000 });
  const toggle = page.locator('[aria-controls="wh-pricing-collapse-packages"]');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const edit = page.locator('[data-wh-price-action="edit-package"][data-wh-item-code="malibu"]');
  await edit.waitFor({ state: 'visible', timeout: 20000 });
  await edit.click();
  await page.waitForSelector('#wh-price-item-label', { state: 'visible', timeout: 15000 });
}

async function readEditor(page) {
  return page.evaluate(() => ({
    label: (document.getElementById('wh-price-item-label') || {}).value || '',
    description: (document.getElementById('wh-price-item-description') || {}).value || '',
    include: (document.getElementById('wh-price-include-0') || {}).value || '',
    minDays: (document.getElementById('wh-price-item-min-days') || {}).value || '',
    prorate: !!((document.getElementById('wh-price-item-prorate') || {}).checked),
  }));
}

async function browserCase(browser, html, width, label) {
  console.log(`\n── ${width}px  ${label} ──`);
  const { db, routes } = await openDb();
  const ledger = [];
  const pageErrors = [];
  const server = createPortal(html, routes, ledger);
  const base = await listen(server);
  const context = await browser.newContext({
    viewport: { width, height: width < 500 ? 844 : 1000 },
    serviceWorkers: 'block',
  });
  await context.addInitScript((slug) => {
    localStorage.setItem('staff_portal_client', slug);
    localStorage.setItem('wh_staff_portal_locale', 'en');
  }, CLIENT);
  const page = await context.newPage();
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));
  try {
    await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction((slug) => {
      const select = document.getElementById('c-client');
      return document.body
        && !document.body.classList.contains('portal-profile-pending')
        && select && select.value === slug;
    }, CLIENT, { timeout: 30000 });
    await openMalibuEditor(page);
    const seeded = await malibuRow(db);
    check(`${width} ${label}: page load seeded Malibu`, !!(seeded && seeded.label === 'Malibu'), JSON.stringify(seeded));

    await page.fill('#wh-price-item-label', label);
    await page.fill('#wh-price-item-description', COPY.description);
    await page.fill('#wh-price-include-0', COPY.include);
    await page.fill('#wh-price-item-min-days', COPY.minDays);
    await page.locator('#wh-price-item-prorate').uncheck();
    // The production click listener owns the save. A coordinate click in this
    // headless viewport can land on a covering div even when the button is the
    // center hit target, so activate the Save button itself.
    await page.locator('[data-wh-price-action="save-package-item"][data-wh-item-code="malibu"]')
      .evaluate((btn) => btn.click());
    await page.waitForFunction(() => {
      const body = document.getElementById('wh-admin-pricing-body');
      return body && /Saved\./.test(body.innerText || '');
    }, null, { timeout: 20000 });

    const put = ledger.filter((row) => row.method === 'PUT' && row.path === `${BASE}/items`);
    check(`${width} ${label}: save dispatched through the registered route`,
      put.length === 1 && put[0].disposition === 'real-pricing-route' && put[0].status === 200,
      JSON.stringify(put));
    const sent = put[0] && put[0].requestBody ? JSON.parse(put[0].requestBody) : null;
    check(`${width} ${label}: route received the name, description and Includes`,
      !!(sent && sent.label === label && sent.description === COPY.description
        && sent.metadata && sent.metadata.includes && sent.metadata.includes.join('|') === COPY.include));
    check(`${width} ${label}: no synthetic pricing success`,
      ledger.filter((row) => row.path.startsWith(BASE)).every((row) => row.disposition === 'real-pricing-route'));
    expectStored(await malibuRow(db), label, `${width} ${label} SQL after save`);

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !document.body.classList.contains('portal-profile-pending'), null, { timeout: 30000 });
    await openMalibuEditor(page);
    const editor = await readEditor(page);
    check(`${width} ${label}: fresh editor keeps the name`, editor.label === label, JSON.stringify(editor));
    check(`${width} ${label}: fresh editor keeps the description`, editor.description === COPY.description, JSON.stringify(editor));
    check(`${width} ${label}: fresh editor keeps Includes`, editor.include === COPY.include, JSON.stringify(editor));
    check(`${width} ${label}: fresh editor keeps minimum days`, editor.minDays === COPY.minDays, JSON.stringify(editor));
    check(`${width} ${label}: fresh editor keeps proration off`, editor.prorate === false, JSON.stringify(editor));
    expectStored(await malibuRow(db), label, `${width} ${label} SQL after fresh read`);
    check(`${width} ${label}: no page errors`, pageErrors.length === 0, pageErrors.join(' | '));
  } catch (err) {
    const bodyText = await page.evaluate(() => {
      const body = document.getElementById('wh-admin-pricing-body');
      return body ? body.innerText.slice(0, 800) : 'no pricing body';
    }).catch((e) => String(e.message || e));
    console.error('page text:', bodyText);
    console.error('pricing ledger:', JSON.stringify(ledger.filter((row) => row.path.startsWith('/staff/admin/wh/pricing')), null, 2));
    console.error('page errors:', pageErrors);
    throw err;
  } finally {
    await context.close();
    await closeServer(server);
    await db.close();
  }
}

async function main() {
  console.log('\n── route: native payload through the full handler ──');
  const underscore = await openDb();
  try {
    await seedThenSave(underscore.routes, underscore.db, 'Malibu_VIP');
  } finally {
    await underscore.db.close();
  }
  const space = await openDb();
  try {
    await seedThenSave(space.routes, space.db, 'Malibu VIP');
  } finally {
    await space.db.close();
  }

  console.log('\n── emitted page: native save, SQL, fresh editor ──');
  const html = buildHtml();
  const browser = await chromium.launch({ headless: true });
  try {
    await browserCase(browser, html, 1280, 'Malibu VIP');
    await browserCase(browser, html, 390, 'Malibu VIP');
    await browserCase(browser, html, 1280, 'Malibu_VIP');
    await browserCase(browser, html, 390, 'Malibu_VIP');
  } finally {
    await browser.close();
  }

  console.log(`\n── package-includes promotion: ${passed} passed, ${failed} failed ──\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nverifier crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});

'use strict';

/**
 * Mandatory Finance browser verifier.
 *
 * This runs the production-generated /staff/ui and its production owners.  The
 * only browser interception is the Finance backend response; no UI function,
 * translation, markup, or CSS is reconstructed here.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

process.env.STAFF_AUTH_REQUIRED = String(false);
process.env.STAFF_AUTH_ALLOW_OPEN = String(true);
process.env.NODE_ENV = 'test';
process.env.DEFAULT_CLIENT_SLUG = 'sunset';
process.env.STAFF_PORTAL_LOCALES = 'en,es,it';
process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'false';
process.env.SUNSET_ADMIN_WRITES_ENABLED = 'true';

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`); return; }
  failed += 1;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}
function equal(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }
function loadPlaywright() {
  try { return require('playwright'); }
  catch (err) {
    const shared = '/opt/wolfhouse/WH/node_modules/playwright';
    if (fs.existsSync(path.join(shared, 'package.json'))) return require(shared);
    console.error('Playwright required: install playwright and Chromium; verifier fails closed.');
    process.exit(2);
  }
}

const zero = { booked_cents: 0, collected_gross_cents: 0, outstanding_cents: 0, bookings_count: 0 };
function summary(booked = 4000) {
  const period = { booked_cents: booked, collected_gross_cents: 6000, outstanding_cents: 1000, bookings_count: 1 };
  return {
    periods: { today: { ...period }, week: { ...period }, month: { ...period } },
    daily_trend: [{ date: '2026-07-15', ...period }],
  };
}
const emptySummary = { periods: { today: { ...zero }, week: { ...zero }, month: { ...zero } }, daily_trend: [] };
const COPY = {
  en: {
    tabs: ['Finance', 'Pricing'], loading: 'Loading finance summary…', empty: 'No finance activity for these periods yet.',
    error: 'Could not load the finance summary.', retry: 'Retry', period: ['Today', 'This week', 'This month'],
    metrics: ['Booked', 'Collected (gross)', 'Outstanding', 'Bookings'], trend: 'Daily trend — this month',
    note: 'Collected is gross — refunds/reversals are not yet available.',
  },
  es: {
    tabs: ['Finanzas', 'Precios'], loading: 'Cargando el resumen financiero…', empty: 'Aún no hay actividad financiera en estos periodos.',
    error: 'No se pudo cargar el resumen financiero.', retry: 'Reintentar', period: ['Hoy', 'Esta semana', 'Este mes'],
    metrics: ['Reservado', 'Cobrado (bruto)', 'Pendiente', 'Reservas'], trend: 'Tendencia diaria — este mes',
    note: 'El cobrado es bruto — los reembolsos/reversos aún no están disponibles.',
  },
  it: {
    tabs: ['Finanze', 'Prezzi'], loading: 'Caricamento del riepilogo finanziario…', empty: 'Nessuna attività finanziaria per questi periodi.',
    error: 'Impossibile caricare il riepilogo finanziario.', retry: 'Riprova', period: ['Oggi', 'Questa settimana', 'Questo mese'],
    metrics: ['Prenotato', 'Incassato (lordo)', 'Da incassare', 'Prenotazioni'], trend: 'Andamento giornaliero — questo mese',
    note: 'L’incassato è lordo — rimborsi/storni non ancora disponibili.',
  },
};

async function waitPortal(page) {
  await page.waitForFunction(() => {
    const select = document.getElementById('c-client');
    return document.body && !document.body.classList.contains('portal-profile-pending')
      && select && select.value === 'sunset' && select.options.length > 1;
  }, null, { timeout: 30000 });
  await page.locator('button.tab-btn[data-tab="admin"]').waitFor({ state: 'visible', timeout: 20000 });
}
async function openAdmin(page) {
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.waitForSelector('#tab-admin.tab-panel.active');
}
async function requestCount(requests) { await sleep(40); return requests.length; }
async function text(page) { return page.locator('#admin-finance-body').innerText(); }
async function fulfill(route, body, status = 200) { await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }); }
async function nextPending(pending, timeout = 5000) {
  const start = Date.now();
  while (!pending.length && Date.now() - start < timeout) await sleep(10);
  if (!pending.length) throw new Error('Timed out waiting for intercepted Finance request');
  return pending.shift();
}

async function main() {
  const playwright = loadPlaywright();
  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const requests = [];
  const pending = [];
  const pageErrors = [];
  const consoleErrors = [];
  let mode = 'pending';

  page.on('pageerror', (err) => pageErrors.push(String(err.message || err)));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  await context.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });
  await page.route('**/staff/admin/finance/summary**', async (route) => {
    requests.push({ url: route.request().url(), at: Date.now() });
    if (mode === 'pending') { pending.push(route); return; }
    if (mode === 'empty') return fulfill(route, { success: true, summary: emptySummary });
    if (mode === 'error') return fulfill(route, { success: false, error: 'unavailable' });
    return fulfill(route, { success: true, summary: summary() });
  });

  try {
    console.log('\n[1] Real /staff/ui entry, default tab, loading and success\n');
    await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitPortal(page);
    await openAdmin(page);
    await page.waitForSelector('.portal-admin-finance-loading');
    equal('normal Admin open issues exactly one Finance request', await requestCount(requests), 1);
    equal('loading copy is exact production EN', await text(page), COPY.en.loading);
    const first = await nextPending(pending);
    await fulfill(first, { success: true, summary: summary(4000) });
    await page.waitForSelector('.pf-card');
    check('loading → success paints backend value', /€40[.,]00/.test(await text(page)), await text(page));
    const defaults = await page.evaluate(() => ({
      keys: Array.from(document.querySelectorAll('#admin-subtab-list [data-admin-tab]')).map((x) => x.dataset.adminTab),
      selected: document.getElementById('admin-tab-finance')?.getAttribute('aria-selected'),
      pricingHidden: document.getElementById('admin-panel-pricing')?.hidden,
    }));
    equal('Finance remains first and Pricing second', defaults.keys.join(','), 'finance,pricing');
    equal('Finance remains default selected', defaults.selected, 'true');
    equal('Pricing remains hidden by default', defaults.pricingHidden, true);

    console.log('\n[2] Empty and error → retry → success\n');
    mode = 'empty';
    await page.locator('button.tab-btn[data-tab="admin"]').click();
    await page.waitForSelector('.portal-admin-finance-empty');
    equal('genuine zero response paints exact empty copy',
      await page.locator('.portal-admin-finance-empty').innerText(), COPY.en.empty);
    mode = 'error';
    await page.locator('button.tab-btn[data-tab="admin"]').click();
    await page.waitForSelector('#admin-finance-retry');
    check('error paints exact production copy', (await text(page)).includes(COPY.en.error));
    equal('retry label exact', await page.locator('#admin-finance-retry').innerText(), COPY.en.retry);
    const beforeRetry = requests.length;
    mode = 'success';
    await page.locator('#admin-finance-retry').click();
    await page.waitForSelector('.pf-card');
    equal('retry sends exactly one request', requests.length, beforeRetry + 1);

    console.log('\n[3] Production owner stale-response and scope controls\n');
    mode = 'pending';
    await page.locator('button.tab-btn[data-tab="admin"]').click();
    const old = await nextPending(pending);
    await page.locator('button.tab-btn[data-tab="admin"]').click();
    const fresh = await nextPending(pending);
    await fulfill(fresh, { success: true, summary: summary(9000) });
    await page.waitForFunction(() => /€90[.,]00/.test(document.getElementById('admin-finance-body')?.innerText || ''));
    await fulfill(old, { success: true, summary: summary(1000) });
    await sleep(80);
    check('out-of-order stale response is suppressed',
      /€90[.,]00/.test(await page.locator('.pf-card .pf-metric-value').first().innerText()));

    const beforeAway = requests.length;
    await page.locator('#c-client').selectOption('wolfhouse-somo', { force: true });
    await page.locator('#c-client').dispatchEvent('change');
    await sleep(100);
    equal('switching away from Sunset sends no Finance request', requests.length, beforeAway);
    check('switch away does not repaint Finance result', /€90[.,]00/.test(await text(page)));

    await page.locator('#c-client').selectOption('sunset', { force: true });
    await page.locator('#c-client').dispatchEvent('change');
    await waitPortal(page);
    await openAdmin(page);
    const somo = await nextPending(pending);
    await page.locator('.staff-school-btn[data-school="sunset-sardinero"]').click();
    const sardi = await nextPending(pending);
    await fulfill(sardi, { success: true, summary: summary(8000) });
    await fulfill(somo, { success: true, summary: summary(2000) });
    await page.waitForFunction(() => /€80[.,]00/.test(document.getElementById('admin-finance-body')?.innerText || ''));
    await sleep(80);
    check('real location control suppresses old location response',
      /€80[.,]00/.test(await page.locator('.pf-card .pf-metric-value').first().innerText()));
    check('Finance URLs carry production client/location scope', requests.every((r) => /[?&]client=sunset(?:&|$)/.test(r.url))
      && requests.some((r) => /[?&]location=sunset-sardinero(?:&|$)/.test(r.url)));

    console.log('\n[4] Repeated real opens, localization, and Pricing draft retention\n');
    mode = 'success';
    const stormStart = requests.length;
    for (let i = 0; i < 3; i += 1) {
      await page.locator('button.tab-btn[data-tab="admin"]').click();
      await page.waitForSelector('.pf-card');
    }
    equal('three repeated real Admin opens produce exactly three requests (no duplicate wiring storm)', requests.length - stormStart, 3);

    await page.locator('#admin-tab-pricing').click();
    await page.waitForSelector('#admin-panel-pricing:not([hidden])');
    const pricingBefore = await page.locator('#admin-panel-pricing').innerText();
    await page.locator('#admin-panel-pricing [data-admin-action="edit-price-group"]').first().click();
    const draft = page.locator('#admin-panel-pricing input[data-admin-price-field="amount"]').first();
    await draft.waitFor({ state: 'visible' });
    await draft.fill('137');
    await page.locator('#admin-tab-finance').click();
    await page.locator('#admin-tab-pricing').click();
    equal('Pricing draft survives Finance round trip', await draft.inputValue(), '137');
    check('Pricing content remains intact', pricingBefore.length > 100 && (await page.locator('#admin-panel-pricing').innerText()).length > 100);

    for (const lang of ['en', 'es', 'it']) {
      // The established fixture omits header chrome, so invoke the exact
      // production locale owner that those buttons invoke.
      await page.evaluate((locale) => window.setStaffLocale(locale), lang);
      await page.locator('button.tab-btn[data-tab="admin"]').click();
      await page.waitForSelector('.pf-card');
      const financeText = await page.locator('#admin-finance-body').textContent();
      const tabText = await page.locator('#admin-subtab-list').textContent();
      const expected = COPY[lang];
      for (const phrase of [...expected.tabs, ...expected.period, ...expected.metrics, expected.trend, expected.note]) {
        check(`${lang.toUpperCase()} exact production copy: ${phrase}`, (financeText + '\n' + tabText).includes(phrase));
      }
      check(`${lang.toUpperCase()} exposes no raw admin.finance key`, !financeText.includes('admin.finance.'));
    }

    console.log('\n[5] Responsive computed layout and diagnostics\n');
    for (const width of [320, 375, 390, 430, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('#admin-tab-finance').click();
      const layout = await page.evaluate(() => {
        const rect = (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, left: r.left, right: r.right }; };
        const controls = Array.from(document.querySelectorAll('#admin-subtab-list button, #admin-finance-body button')).filter((x) => !x.hidden);
        const finance = document.getElementById('admin-finance-body');
        const panel = document.getElementById('admin-panel-finance');
        const cards = Array.from(document.querySelectorAll('.pf-card')).map(rect);
        const trend = Array.from(document.querySelectorAll('.pf-trend-row')).map(rect);
        return {
          controls: controls.map((x) => ({ id: x.id, ...rect(x) })),
          docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          bodyOverflow: document.body.scrollWidth > document.body.clientWidth,
          financeOverflow: finance.scrollWidth > finance.clientWidth + 1,
          panelOverflow: panel.scrollWidth > panel.clientWidth + 1,
          finance: rect(finance), cards, trend,
          clipped: [finance, panel, ...document.querySelectorAll('.pf-card,.pf-trend-row')].some((x) => {
            const r = x.getBoundingClientRect(); return r.left < -1 || r.right > document.documentElement.clientWidth + 1;
          }),
        };
      });
      check(`${width}px computed Finance controls are >=44x44`, layout.controls.every((x) => x.w >= 44 && x.h >= 44), JSON.stringify(layout.controls));
      check(`${width}px document/body have no horizontal overflow`, !layout.docOverflow && !layout.bodyOverflow, JSON.stringify(layout));
      check(`${width}px Finance container/panel have no overflow or clipping`, !layout.financeOverflow && !layout.panelOverflow && !layout.clipped, JSON.stringify(layout));
      check(`${width}px Finance result cards and trend are laid out visibly`, layout.cards.length === 3 && layout.trend.length === 1
        && layout.cards.every((x) => x.w > 0 && x.h > 0) && layout.trend.every((x) => x.w > 0 && x.h > 0), JSON.stringify(layout));
      if (width < 720) check(`${width}px result cards stack in one column`, layout.cards.every((x) => Math.abs(x.left - layout.cards[0].left) < 2));
      else check(`${width}px desktop result cards form a three-column row`, new Set(layout.cards.map((x) => Math.round(x.left))).size === 3);
    }

    equal('all pageerror messages', pageErrors.join(' | '), '');
    equal('all console.error messages', consoleErrors.join(' | '), '');
  } finally {
    await context.close();
    await browser.close();
    await close(server);
  }

  console.log(`\n── verify:sunset-finance-ui-playwright: ${passed} passed, ${failed} failed ──`);
  if (failed) process.exitCode = 1;
  else console.log('verify:sunset-finance-ui-playwright — ALL CHECKS PASSED');
}

main().catch((err) => { console.error(err); process.exit(1); });

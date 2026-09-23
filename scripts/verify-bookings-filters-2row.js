#!/usr/bin/env node
'use strict';

/** BOOKINGS-FILTERS-2ROW-001: real /staff/ui builder + ordinary Bookings entry.
 * Offline only: empty booking-list/CSV fixtures, never guest/payment writes.
 * Run: node scripts/verify-bookings-filters-2row.js
 * Evidence: tmp/bookings-filters-2row/<client>/ (pixels, screenshots, request URLs).
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const CLIENT = process.env.BOOKINGS_FILTERS_CLIENT;
if (!CLIENT) {
  let failed = false;
  for (const client of ['sunset-somo', 'wolfhouse-somo']) {
    const run = spawnSync(process.execPath, [__filename], {
      env: { ...process.env, BOOKINGS_FILTERS_CLIENT: client, INBOX_COLUMNS_CLIENT: client === 'sunset-somo' ? 'sunset' : client },
      stdio: 'inherit',
    });
    if (run.status !== 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
process.env.INBOX_COLUMNS_CLIENT = CLIENT === 'sunset-somo' ? 'sunset' : CLIENT;
const { buildPortalHtml, startFixtureServer, loadPlaywright } = require('./verify-inbox-columns-playwright');
const OUT = path.join(__dirname, '..', 'tmp', 'bookings-filters-2row', CLIENT);
const ids = ['q', 'clear', 'date-range-trigger', 'status', 'type', 'export'];
const evidence = [];
let passed = 0;
let failed = 0;
function check(label, run) {
  try { run(); passed++; console.log('PASS ' + label); }
  catch (error) { failed++; console.error('FAIL ' + label + ': ' + error.message); }
}
async function measure(page) {
  return page.evaluate((names) => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    return {
      controls: Object.fromEntries(names.map((name) => [name, rect(document.getElementById('admin-bookings-' + name))])),
      toolbar: rect(document.querySelector('.portal-admin-bookings-toolbar')),
      gridRows: getComputedStyle(document.querySelector('.portal-admin-bookings-toolbar')).gridTemplateRows,
      viewport: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  }, ids);
}
function checkPhone(label, m) {
  check(label + ' two rows, wide Search / small Clear, Dates|Status|Type|Export', () => {
    const c = m.controls;
    assert.equal(m.gridRows.split(' ').length, 2, JSON.stringify(m));
    assert.ok(Math.abs(c.q.y - c.clear.y) <= 2, 'Search/Clear not aligned');
    assert.ok(c.q.width >= c.clear.width * 2, 'Search must be at least twice Clear width');
    const second = ['date-range-trigger', 'status', 'type', 'export'].map((name) => c[name]);
    assert.ok(second.every((r) => Math.abs(r.y - second[0].y) <= 2), 'second row misaligned');
    assert.ok(second[0].y > c.q.bottom, 'rows overlap');
    for (let i = 1; i < second.length; i++) assert.ok(second[i].x >= second[i - 1].right, 'controls overlap');
    for (const r of Object.values(c)) {
      assert.ok(r.width >= 44 && r.height >= 38, 'control too small');
      assert.ok(r.x >= m.toolbar.x - 1 && r.right <= m.toolbar.right + 1, 'control overflows toolbar');
    }
    assert.ok(m.scrollWidth <= m.viewport, 'page horizontally overflows');
  });
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const playwright = loadPlaywright();
  assert.ok(playwright, 'Playwright required (no skip)');
  const { server, base } = await startFixtureServer(buildPortalHtml());
  let browser;
  const requests = [];
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== base) return route.abort();
      assert.equal(request.method(), 'GET', 'unexpected write in offline layout gate');
      if (url.pathname === '/staff/admin/bookings') {
        requests.push(url.href);
        return route.fulfill({ json: { success: true, rows: [], total: 0, summary: { bookings_count: 0, refund_needed_count: 0, unpaid_count: 0 } } });
      }
      if (url.pathname === '/staff/admin/bookings/export.csv') {
        requests.push(url.href);
        return route.fulfill({ contentType: 'text/csv', body: 'booking_code\n' });
      }
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/staff/ui', { waitUntil: 'domcontentloaded' });
    const nav = page.locator('.tab-btn[data-tab="bookings"]');
    if (!(await nav.isVisible())) await page.locator('#banner .nav-menu-toggle').click();
    await nav.click();
    await page.locator('#admin-bookings-q').waitFor({ state: 'visible' });
    // Real language handler remounts the shell; selectors and listeners must survive.
    for (const lang of ['en', 'es']) {
      await page.evaluate((locale) => setStaffLocale(locale), lang);
      for (const theme of ['dark', 'light']) {
        await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
        for (const width of [320, 360, 390, 430, 768, 769, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          const m = await measure(page);
          const label = `${CLIENT} ${lang} ${theme} ${width}px`;
          evidence.push({ label, ...m });
          if (width <= 768) checkPhone(label, m);
          else check(label + ' desktop toolbar preserved', () => {
            assert.equal(m.gridRows, 'none');
            assert.ok(m.controls.q.width > 0 && m.controls.export.width > 0);
            assert.equal(m.controls.type.width > 0, CLIENT === 'sunset-somo');
          });
          if (width === 390) await page.locator('.portal-admin-bookings-toolbar').screenshot({ path: path.join(OUT, `${lang}-${theme}-${width}.png`) });
        }
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#admin-bookings-clear').click();
    await page.locator('#admin-bookings-q').fill('Layout Guest');
    await page.waitForRequest((r) => new URL(r.url()).searchParams.get('q') === 'Layout Guest');
    await page.locator('#admin-bookings-status').selectOption('unpaid');
    await page.locator('#admin-bookings-type').selectOption('accommodation');
    await page.locator('#admin-bookings-date-range-trigger').click();
    // Shared date picker rejects past dates; choose next month via the normal control.
    await page.locator('#admin-bookings-date-range-next').click();
    await page.locator('[data-bookings-day]').nth(0).click();
    await page.locator('[data-bookings-day]').nth(2).click();
    await page.waitForFunction(() => document.getElementById('admin-bookings-date-range-trigger').getAttribute('aria-expanded') === 'false');
    checkPhone(CLIENT + ' selected values', await measure(page));
    const exportRequest = context.waitForEvent('request', { predicate: (r) => new URL(r.url()).pathname.endsWith('/export.csv') });
    await page.locator('#admin-bookings-export').click();
    const exported = new URL((await exportRequest).url());
    check(CLIENT + ' Export retains all selected filters', () => {
      assert.equal(exported.searchParams.get('q'), 'Layout Guest');
      assert.equal(exported.searchParams.get('status'), 'unpaid');
      assert.equal(exported.searchParams.get('type'), 'accommodation');
      assert.match(exported.searchParams.get('date_from'), /^\d{4}-\d{2}-01$/);
      assert.match(exported.searchParams.get('date_to'), /^\d{4}-\d{2}-03$/);
    });
    await page.locator('#admin-bookings-clear').click();
    const values = await page.locator('#admin-bookings-body').evaluate((root) =>
      ['q', 'status', 'type', 'date-from', 'date-to'].map((id) => root.querySelector('#admin-bookings-' + id).value));
    check(CLIENT + ' Clear resets all filters and date popup closes', () => assert.deepEqual(values, ['', '', '', '', '']));
    check(CLIENT + ' no browser JS exceptions', () => assert.deepEqual(errors, []));
  } finally {
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ evidence, requests, passed, failed }, null, 2) + '\n');
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log(`${CLIENT}: ${passed} passed, ${failed} failed; evidence ${OUT}`);
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

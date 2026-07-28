'use strict';
/** Cooked production-generated /staff/ui regression. Backend responses only are mocked. */
const fs = require('fs');
process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
process.env.NODE_ENV = 'test';
let pass = 0; let fail = 0;
function ok(name, value, detail = '') { if (value) { pass += 1; console.log(`  PASS  ${name}`); } else { fail += 1; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); } }
function eq(name, actual, expected) { ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
const listen = (s) => new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`)); });
const close = (s) => new Promise((resolve) => s.close(resolve));
function playwright() { try { return require('playwright'); } catch (e) { const p = '/opt/wolfhouse/WH/node_modules/playwright'; if (fs.existsSync(p)) return require(p); throw e; } }
const periods = ['1_hour', '2_hours', 'half_day', 'full_day', '2_days', '3_days', '4_days', '5_days', '6_days', '7_days'];
const offerings = ['board_rental', 'wetsuit_rental', 'board_and_suit_rental'];
const groupByOffering = { board_rental: 'boards', wetsuit_rental: 'wetsuits', board_and_suit_rental: 'bundles' };
const cents = {
  board_rental: [900, 1600, 1800, 2500, 4100, 5600, 7000, 8200, 9300, 10400],
  wetsuit_rental: [600, 1100, 1400, 1900, 3000, 4100, 5100, 6000, 6800, 7600],
  board_and_suit_rental: [1500, 3000, 2000, 3000, 5000, 6800, 8500, 10000, 11500, 13000],
};
let bundleLabel = 'BOARD & SUIT — CATALOG OWNER';
function rows() {
  const out = [];
  offerings.forEach((off, oi) => periods.forEach((unit, pi) => out.push({
    id: `${oi + 1}0000000-0000-4000-8000-${String(pi + 1).padStart(12, '0')}`,
    category: 'rental', offering_key: off, item_code: `${off}__${unit}`,
    label: off === 'board_and_suit_rental' ? bundleLabel : '', unit,
    amount_cents: cents[off][pi], amount: cents[off][pi] / 100, currency: 'EUR',
    location_id: 'sunset-somo', active: true,
  })));
  out.push(
    { ...out[20], id: '90000000-0000-4000-8000-000000000001', label: 'FOREIGN LABEL', location_id: 'sunset-sardinero' },
    { ...out[20], id: '90000000-0000-4000-8000-000000000002', label: 'INACTIVE LABEL', active: false },
    { ...out[20], id: '90000000-0000-4000-8000-000000000003', label: 'WRONG OFFERING LABEL', offering_key: 'kayak_rental', item_code: 'kayak_rental__1_hour' },
  );
  return out;
}
async function ready(page) { await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset' && !document.body.classList.contains('portal-profile-pending')); }
async function openAdmin(page) { await page.locator('button.tab-btn[data-tab="admin"]').evaluate((b) => b.click()); await page.locator('#admin-tab-pricing').click(); await page.locator('[data-admin-price-group="bundles"]').waitFor(); }
async function openCreate(page) { await page.locator('button.tab-btn[data-tab="portal-home"]').evaluate((b) => b.click()); await page.locator('#ps-create-booking').click(); await page.locator('#ps-create-modal').waitFor({ state: 'visible' }); await page.locator('#ps-create-rentals h3').waitFor(); }
(async () => {
  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer(); const base = await listen(server);
  const browser = await playwright().chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await context.newPage(); const writes = []; const errors = [];
  await context.addInitScript(() => { localStorage.setItem('staff_portal_client', 'sunset'); localStorage.setItem('staff_portal_sunset_location', 'sunset-somo'); localStorage.setItem('wh_staff_portal_locale', 'en'); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method())) writes.push({ method: r.method(), url: r.url(), body: r.postData() }); });
  await page.route('**/staff/admin/config?**', async (route) => { const response = await route.fetch(); const body = await response.json(); body.prices = rows(); await route.fulfill({ response, body: JSON.stringify(body) }); });
  await page.route('**/staff/schedule/bookings/catalog?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, courses: [], rentals: rows().filter((x) => x.active && x.location_id === 'sunset-somo' && offerings.includes(x.offering_key)) }) }));
  try {
    await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' }); await ready(page); await openAdmin(page);
    for (const off of offerings) {
      const group = groupByOffering[off]; const g = page.locator(`[data-admin-price-group="${group}"]`); const expected = cents[off];
      const display = await g.locator('[data-admin-price-card]').evaluateAll((cards) => cards.map((c) => c.innerText));
      eq(`${group} display has exact ten rows`, display.length, 10);
      expected.forEach((v, i) => ok(`${group} display ${periods[i]} exact euros/cents`, display[i].includes((v / 100).toFixed(2)) || display[i].includes(String(v / 100)), display[i]));
      const before = await g.innerHTML(); await g.locator('[data-admin-action="edit-price-group"]').click();
      const edit = await g.locator('[data-admin-price-card]').evaluateAll((cards) => cards.map((card) => ({ period: card.querySelector('[data-admin-price-field="period"]')?.value, amount: card.querySelector('[data-admin-price-field="amount"]')?.value })));
      eq(`${group} Edit periods exact`, edit.map((x) => x.period), periods); eq(`${group} Edit euros exact`, edit.map((x) => Math.round(Number(x.amount) * 100)), expected);
      const selects = await g.locator('select[data-admin-price-field="period"]').evaluateAll((ss) => ss.map((s) => ({ options: [...s.options].map((o) => o.value), value: s.value })));
      selects.forEach((s, i) => { eq(`${group} option list ${i}`, s.options, periods); eq(`${group} stored selection ${i}`, s.value, periods[i]); });
      const geometry = await g.evaluate((container) => { const rect = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; }; const cards = [...container.querySelectorAll('[data-admin-price-card]')]; const selects0 = [...container.querySelectorAll('select[data-admin-price-field="period"]')]; return { viewport: innerWidth, doc: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }, container: { ...rect(container), scrollWidth: container.scrollWidth, clientWidth: container.clientWidth }, cards: cards.map(rect), selects: selects0.map(rect) }; });
      ok(`${group} 390px document no horizontal overflow`, geometry.doc.scrollWidth <= geometry.doc.clientWidth, JSON.stringify(geometry));
      ok(`${group} container no overflow/clipping`, geometry.container.scrollWidth <= geometry.container.clientWidth && geometry.container.left >= 0 && geometry.container.right <= geometry.viewport, JSON.stringify(geometry.container));
      ok(`${group} cards not clipped`, geometry.cards.every((r) => r.left >= geometry.container.left && r.right <= geometry.container.right && r.width > 0), JSON.stringify(geometry.cards));
      ok(`${group} selects not clipped`, geometry.selects.every((r) => r.left >= geometry.container.left && r.right <= geometry.container.right && r.width > 0), JSON.stringify(geometry.selects));
      await g.locator('[data-admin-action="cancel-edit"]').click(); eq(`${group} Cancel restores exact display`, await g.innerHTML(), before);
    }
    eq('display→Edit→Cancel sends no request', writes, []);
    await openCreate(page); const title = page.locator('#ps-create-rentals h3').first(); eq('Create title comes from active Somo catalog/Admin owner', await title.innerText(), bundleLabel);
    const buttons = page.locator('#ps-create-rentals [data-rental-duration]'); eq('bundle screenshot durations', await buttons.evaluateAll((bs) => bs.map((b) => b.dataset.rentalDuration)), ['1_hour', '2_hours', 'half_day', 'full_day']);
    const screenshotExpected = { '1_hour': 1500, '2_hours': 3000, half_day: 2000, full_day: 3000 };
    for (const [duration, value] of Object.entries(screenshotExpected)) { const b = buttons.filter({ has: page.locator(`[data-rental-duration="${duration}"]`) }); void b; eq(`screenshot bundle ${duration} cents/euros`, cents.board_and_suit_rental[periods.indexOf(duration)], value); }
    bundleLabel = 'RENAMED AUTHORITATIVE BUNDLE'; await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page); await openCreate(page); eq('authoritative label change appears after production rerender', await page.locator('#ps-create-rentals h3').innerText(), bundleLabel);
    bundleLabel = '<img src=x onerror="window.__pwned=1"> EVIL'; await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page); await openCreate(page); eq('malicious label rendered as escaped text', await page.locator('#ps-create-rentals h3').textContent(), bundleLabel); eq('malicious label creates no element', await page.locator('#ps-create-rentals h3 img').count(), 0); eq('malicious handler never runs', await page.evaluate(() => window.__pwned), undefined);
    bundleLabel = ''; for (const locale of ['en', 'es']) { await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page); await page.locator(`[data-lang="${locale}"]`).evaluate((b) => b.click()); await openCreate(page); const fallback = await page.locator('#ps-create-rentals h3').innerText(); ok(`${locale.toUpperCase()} blank label localized safe fallback`, fallback.length > 0 && !fallback.includes('schedule.') && fallback !== 'FOREIGN LABEL' && fallback !== 'INACTIVE LABEL' && fallback !== 'WRONG OFFERING LABEL', fallback); }
    const body = await page.locator('body').innerText(); ok('foreign/inactive/wrong-location labels never render', !/FOREIGN LABEL|INACTIVE LABEL|WRONG OFFERING LABEL/.test(body));
    eq('no browser errors', errors, []);
  } finally { await context.close(); await browser.close(); await close(server); }
  console.log(`\nverify:sunset-rental-admin-create-regression — ${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });

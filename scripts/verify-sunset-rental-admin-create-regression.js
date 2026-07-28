'use strict';
/** Cooked production-generated /staff/ui regression. Backend responses only are mocked. */
process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
process.env.NODE_ENV = 'test';
// Repository-local install convention: `npm install` + `npx playwright install chromium`.
// Never borrow another checkout's node_modules or browser cache.
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
let pass = 0; let fail = 0;
function ok(name, value, detail = '') { if (value) { pass += 1; console.log(`  PASS  ${name}`); } else { fail += 1; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); } }
function eq(name, actual, expected) { ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
const listen = (s) => new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`)); });
const close = (s) => new Promise((resolve) => s.close(resolve));
const periods = ['1_hour', '2_hours', 'half_day', 'full_day', '1_day', '2_days', '3_days', '4_days', '5_days', '6_days', '7_days'];
const dayTiers = ['1_day', '2_days', '3_days', '4_days', '5_days', '6_days', '7_days'];
const offerings = ['board_rental', 'wetsuit_rental', 'board_and_suit_rental'];
const groupByOffering = { board_rental: 'boards', wetsuit_rental: 'wetsuits', board_and_suit_rental: 'bundles' };
const cents = {
  board_rental: [900, 1600, 1800, 2500, 2500, 4100, 5600, 7000, 8200, 9300, 10400],
  wetsuit_rental: [600, 1100, 1400, 1900, 1900, 3000, 4100, 5100, 6000, 6800, 7600],
  board_and_suit_rental: [1500, 3000, 2000, 3000, 3000, 5000, 6800, 8500, 10000, 11500, 13000],
};
let bundleLabel = 'BOARD & SUIT — CATALOG OWNER';
function rows() {
  const out = [];
  offerings.forEach((off, oi) => periods.forEach((unit, pi) => out.push({
    id: `${oi + 1}0000000-0000-4000-8000-${String(pi + 1).padStart(12, '0')}`,
    category: 'rental', offering_key: off, item_code: `${off}__${unit}`,
    label: off === 'board_and_suit_rental' ? bundleLabel : '', unit,
    amount_cents: cents[off][pi], amount: cents[off][pi] / 100, currency: 'EUR',
    location_id: 'sunset-somo', client_slug: 'sunset', tenant: 'sunset', active: true,
  })));
  out.push(
    { ...out[22], id: '90000000-0000-4000-8000-000000000001', label: 'WRONG LOCATION LABEL', location_id: 'sunset-sardinero' },
    { ...out[22], id: '90000000-0000-4000-8000-000000000002', label: 'INACTIVE LABEL', active: false },
    { ...out[22], id: '90000000-0000-4000-8000-000000000003', label: 'WRONG OFFERING LABEL', offering_key: 'kayak_rental', item_code: 'kayak_rental__1_hour' },
    { ...out[22], id: '90000000-0000-4000-8000-000000000004', label: 'HOSTILE FOREIGN BOTH LABEL', client_slug: 'hostile', tenant: 'hostile' },
    { ...out[22], id: '90000000-0000-4000-8000-000000000006', label: 'HOSTILE FOREIGN CLIENT LABEL', client_slug: 'hostile', tenant: 'sunset' },
    { ...out[22], id: '90000000-0000-4000-8000-000000000007', label: 'HOSTILE FOREIGN TENANT LABEL', client_slug: 'sunset', tenant: 'hostile' },
    { ...out[0], id: '90000000-0000-4000-8000-000000000005', offering_key: 'sup_rental', item_code: 'sup_rental__moon_cycle', unit: 'moon_cycle', label: 'UNKNOWN PERIOD', amount: 66.66, amount_cents: 6666 },
  );
  return out;
}
async function ready(page) { await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset' && !document.body.classList.contains('portal-profile-pending')); }
async function openAdmin(page) { await page.locator('button.tab-btn[data-tab="admin"]').evaluate((b) => b.click()); await page.locator('#admin-tab-pricing').click(); await page.locator('[data-admin-price-group="bundles"]').waitFor(); }
async function openCreate(page) { await page.locator('button.tab-btn[data-tab="portal-home"]').evaluate((b) => b.click()); await page.locator('#ps-create-booking').click(); await page.locator('#ps-create-modal').waitFor({ state: 'visible' }); await page.locator('#ps-create-rentals h3').waitFor(); }
function euros(text) { const m = String(text).match(/(?:€\s*)?(\d+(?:[.,]\d{1,2})?)/); return m ? Math.round(Number(m[1].replace(',', '.')) * 100) : NaN; }
(async () => {
  const { chromium } = require('playwright');
  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer(); const base = await listen(server);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await context.newPage(); const writes = []; const errors = [];
  await context.addInitScript(() => { localStorage.setItem('staff_portal_client', 'sunset'); localStorage.setItem('staff_portal_sunset_location', 'sunset-somo'); localStorage.setItem('wh_staff_portal_locale', 'en'); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method())) writes.push({ method: r.method(), url: r.url(), body: r.postData() }); });
  await page.route('**/staff/admin/config?**', async (route) => { const response = await route.fetch(); const body = await response.json(); body.prices = rows(); body.surf_packs = [{ pack_id: 'proof-pack', label: 'Production proof pack', age_band: '12_and_up', group_size: 16, beaches: ['somo'], weekly: 'mon_fri', schedules: [{ key: '1000_1200', label: '10:00–12:00' }], price_tiers: dayTiers.map((key, i) => ({ key, label: key, hours: (i + 1) * 2, amount_cents: (i + 1) * 1111 })) }]; await route.fulfill({ response, body: JSON.stringify(body) }); });
  await page.route('**/staff/schedule/bookings/catalog?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, courses: [], rentals: rows().filter((x) => x.active && x.location_id === 'sunset-somo' && x.client_slug === 'sunset' && x.tenant === 'sunset' && offerings.includes(x.offering_key)) }) }));
  try {
    await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' }); await ready(page); await openAdmin(page);
    const pack = page.locator('[data-admin-pack-card], .portal-admin-pack-card').first();
    await pack.locator('[data-admin-action="edit-pack"]').click();
    const packTierDom = await pack.locator('[data-pack-tier-row]').evaluateAll((rs) => rs.map((r) => ({ selected: r.querySelector('.pack-tier-key')?.value, amount: r.querySelector('.pack-tier-amount')?.value })));
    eq('production pack Edit renders exact seven selected tier identities', packTierDom.map((x) => x.selected), dayTiers);
    eq('production pack Edit renders exact seven amount-input tier identities', packTierDom.length, 7);
    await pack.locator('[data-admin-action="cancel-edit"]').click();
    const renderedAmounts = {};
    for (const off of offerings) {
      const group = groupByOffering[off]; const g = page.locator(`[data-admin-price-group="${group}"]`);
      const display = await g.locator('[data-admin-price-card]').evaluateAll((cards) => cards.map((card) => ({ period: card.querySelector('.portal-admin-price-period')?.textContent.trim(), amount: card.querySelector('.portal-admin-price-amount')?.textContent.trim() })));
      eq(`${group} rendered display has exact ten commercial cards`, display.length, 10);
      renderedAmounts[group] = display.map((x) => euros(x.amount));
      ok(`${group} every rendered display card exposes a money amount`, renderedAmounts[group].every(Number.isFinite), JSON.stringify(display));
      await g.locator('[data-admin-action="edit-price-group"]').click();
      const edit = await g.locator('[data-admin-price-card]').evaluateAll((cards) => cards.map((card) => ({ period: card.querySelector('[data-admin-price-field="period"]')?.value, amount: card.querySelector('[data-admin-price-field="amount"]')?.value })));
      eq(`${group} production Edit selected rental identities`, edit.map((x) => x.period), periods.filter((x) => x !== '1_day'));
      eq(`${group} ten rendered Edit input identities`, edit.length, 10);
      eq(`${group} display-card amounts equal Edit input values`, edit.map((x) => Math.round(Number(x.amount) * 100)), renderedAmounts[group]);
      const geometry = await g.evaluate((container) => { const rect = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; }; const cards = [...container.querySelectorAll('[data-admin-price-card]')]; const controls = [...container.querySelectorAll('[data-admin-price-field]')]; return { viewport: innerWidth, doc: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }, container: { ...rect(container), scrollWidth: container.scrollWidth, clientWidth: container.clientWidth }, cards: cards.map(rect), controls: controls.map(rect) }; });
      ok(`${group} 390px document has no horizontal overflow`, geometry.doc.scrollWidth <= geometry.doc.clientWidth, JSON.stringify(geometry));
      ok(`${group} 390px group and cards are inside viewport`, geometry.container.scrollWidth <= geometry.container.clientWidth && geometry.container.left >= 0 && geometry.container.right <= geometry.viewport && geometry.cards.every((r) => r.left >= geometry.container.left && r.right <= geometry.container.right && r.width > 0), JSON.stringify(geometry));
      ok(`${group} 390px Edit controls are not clipped`, geometry.controls.every((r) => r.left >= geometry.container.left && r.right <= geometry.container.right && r.width > 0), JSON.stringify(geometry.controls));
      await g.locator('[data-admin-action="cancel-edit"]').click();
    }
    const sup = page.locator('[data-admin-price-group="sup"]');
    await sup.locator('[data-admin-action="edit-price-group"]').click();
    const invalid = sup.locator('select[data-admin-price-field="period"]');
    eq('unknown stored period renders empty invalid sentinel selection', await invalid.inputValue(), '');
    eq('unknown stored period sentinel is selected and disabled', await invalid.locator('option:checked').evaluate((o) => ({ disabled: o.disabled, text: o.textContent.trim() })), { disabled: true, text: 'Moon cycle' });
    const writesBeforeInvalidSave = writes.length;
    await sup.locator('[data-admin-action="save-price-group"]').click();
    const visibleError = page.locator('#admin-save-msg');
    await visibleError.waitFor();
    eq('real invalid Save click shows production validation text', (await visibleError.innerText()).trim(), 'Select a time period.');
    eq('invalid Save sends zero POST/PUT/PATCH/DELETE', writes.length, writesBeforeInvalidSave);
    await sup.locator('[data-admin-action="cancel-edit"]').click();

    await openCreate(page);
    const main = page.locator('#ps-create-main-activity-label'); const title = page.locator('#ps-create-rentals h3').first();
    eq('rendered exact MAIN ACTIVITY text', (await main.innerText()).trim(), 'MAIN ACTIVITY');
    eq('rendered exact dynamic bundle title', await title.innerText(), bundleLabel);
    const styleProps = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textTransform', 'color'];
    const styles = await page.evaluate(({ props }) => { const pick = (id) => { const s = getComputedStyle(document.querySelector(id)); return Object.fromEntries(props.map((p) => [p, s[p]])); }; return { main: pick('#ps-create-main-activity-label'), title: pick('#ps-create-rentals h3') }; }, { props: styleProps });
    eq('dynamic bundle title computed typography/color exactly matches MAIN ACTIVITY', styles.title, styles.main);
    const rentalWrap = page.locator('#ps-create-rentals');
    const buttons = rentalWrap.locator('[data-rental-duration]');
    const expectedBundleCreate = {
      '1_hour': { text: '€15', cents: 1500 },
      '2_hours': { text: '€30', cents: 3000 },
      half_day: { text: '€20', cents: 2000 },
      full_day: { text: '€30', cents: 3000 },
    };
    eq('screenshot bundle duration identities from rendered controls', await buttons.evaluateAll((bs) => bs.map((b) => b.dataset.rentalDuration)), Object.keys(expectedBundleCreate));
    eq('actual rendered Create row is the canonical bundle offering', await rentalWrap.locator('div[data-rental-offering]').evaluateAll((rs) => rs.map((r) => r.dataset.rentalOffering)), ['board_and_suit_rental']);
    const renderedCreateCards = await buttons.evaluateAll((bs) => bs.map((b) => ({
      offering: b.dataset.rentalOffering,
      duration: b.dataset.rentalDuration,
      cents: Number(b.dataset.amountCents),
      text: b.innerText.trim(),
      visible: !!(b.offsetWidth || b.offsetHeight || b.getClientRects().length),
    })));
    eq('rendered bundle Create controls independently associate exact literal duration/amount data', renderedCreateCards.map((x) => ({ offering: x.offering, duration: x.duration, cents: x.cents })), Object.entries(expectedBundleCreate).map(([duration, price]) => ({ offering: 'board_and_suit_rental', duration, cents: price.cents })));
    ok('rendered bundle Create controls visibly associate exact literal euro text', renderedCreateCards.every((x) => x.visible && x.text.includes(expectedBundleCreate[x.duration].text)), JSON.stringify(renderedCreateCards));
    eq('Surfboard rendered Create duration controls include every active configured short duration', await rentalWrap.getAttribute('data-board-short-keys').then((v) => JSON.parse(v || '[]')), ['1_hour', '2_hours', 'half_day', 'full_day']);
    eq('Wetsuit rendered Create duration controls include every active configured short duration', await rentalWrap.getAttribute('data-wetsuit-short-keys').then((v) => JSON.parse(v || '[]')), ['1_hour', '2_hours', 'half_day', 'full_day']);
    ok('rendered Create duration controls contain no fabricated inactive duration', renderedCreateCards.every((x) => Object.hasOwn(expectedBundleCreate, x.duration)) && !/moon_cycle/.test(await rentalWrap.innerText()), JSON.stringify(renderedCreateCards));
    for (const [duration, price] of Object.entries(expectedBundleCreate)) {
      if (await page.locator(`[data-rental-duration="${duration}"]`).getAttribute('aria-checked') === 'true') {
        const other = duration === '1_hour' ? '2_hours' : '1_hour';
        await page.locator(`[data-rental-duration="${other}"]`).click({ force: true });
      }
      await page.locator(`[data-rental-duration="${duration}"]`).click({ force: true });
      eq(`pointer selection keeps ${duration} canonical duration and displayed price amount matched`, await page.evaluate(() => {
        const selected = document.querySelector('#ps-create-rentals [data-rental-duration][aria-checked="true"]');
        return {
          canonical: document.querySelector('#ps-create-rentals')?.dataset.durationKey,
          selected: selected?.dataset.rentalDuration,
          cents: Number(selected?.dataset.amountCents),
          visibleText: selected?.innerText.trim(),
          visible: !!(selected && (selected.offsetWidth || selected.offsetHeight || selected.getClientRects().length)),
        };
      }), { canonical: duration, selected: duration, cents: price.cents, visibleText: `${duration === '1_hour' ? '1 hour' : duration === '2_hours' ? '2 hours' : duration === 'half_day' ? 'Half day' : 'Full day'} ${price.text}`, visible: true });
    }
    ok('screenshot bundle amounts came from every rendered Admin display card', renderedAmounts.bundles.length === 10 && renderedAmounts.bundles.every(Number.isFinite), JSON.stringify(renderedAmounts.bundles));

    bundleLabel = 'RENAMED AUTHORITATIVE BUNDLE'; await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page); await openCreate(page); eq('authoritative label change appears after production rerender', await page.locator('#ps-create-rentals h3').innerText(), bundleLabel);
    bundleLabel = '<img src=x onerror="window.__pwned=1"> EVIL'; await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page); await openCreate(page); eq('malicious label rendered as escaped text', await page.locator('#ps-create-rentals h3').textContent(), bundleLabel); eq('malicious label creates no element', await page.locator('#ps-create-rentals h3 img').count(), 0); eq('malicious handler never runs', await page.evaluate(() => window.__pwned), undefined);
    bundleLabel = '';
    for (const [locale, exact] of [['en', 'Surfboard + wetsuit'], ['es', 'Tabla de surf + neopreno']]) {
      await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page); await page.locator(`[data-lang="${locale}"]`).evaluate((b) => b.click()); await openCreate(page);
      eq(`${locale.toUpperCase()} exact production-i18n blank-label fallback`, (await page.locator('#ps-create-rentals h3').textContent()).trim(), exact);
      eq(`${locale.toUpperCase()} browser production i18n authority`, await page.evaluate(() => window.t('schedule.ops.rentalBoth')), exact);
    }
    const body = await page.locator('body').innerText();
    ok('wrong-location/inactive/wrong-offering/foreign-client-or-tenant labels cannot supply title', !/WRONG LOCATION LABEL|INACTIVE LABEL|WRONG OFFERING LABEL|HOSTILE FOREIGN (?:BOTH|CLIENT|TENANT) LABEL/.test(body), body);
    ok('duration pointer proof sends no booking write/create request', !writes.some((r) => /\/staff\/schedule\/bookings(?:\?|$)/.test(r.url)), JSON.stringify(writes));
    eq('no browser errors', errors, []);
  } finally { await context.close(); await browser.close(); await close(server); }
  console.log(`\nverify:sunset-rental-admin-create-regression — ${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });

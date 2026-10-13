'use strict';

const assert = require('assert');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const requests = [];
  await page.setContent(`<!doctype html><html><head><style>
    :root{--font-sans:'Instrument Sans',system-ui,sans-serif;--surface:#fff;--border-soft:#ddd;--radius:10px}
    body{font-family:var(--font-sans)} .portal-admin-section{padding:16px 18px;border:1px solid #ddd}
  </style></head><body><div id="al-wrap"><section id="cc-house-notes" class="card">Notes</section></div></body></html>`);
  await page.evaluate(() => {
    window.getClient = () => 'wolfhouse-somo';
    window.__requests = [];
    window.fetch = async (url, options = {}) => {
      window.__requests.push({ url, method: options.method || 'GET', body: options.body || null });
      if (url === '/staff/admin/location-booking-settings') {
        return { ok: true, json: async () => ({
          location: { address_text: 'TEST address', google_maps_url: 'https://maps.google.com/test-map' },
          booking_settings: { unpaid_hold_minutes: 80, require_each_guest_deposit: true, locked: false, lock_reason: '' },
        }) };
      }
      return { ok: true, json: async () => ({ success: true }) };
    };
  });
  await page.addScriptTag({ path: path.join(__dirname, 'browser/wolfhouse-location-booking-settings-ui.js') });
  await page.evaluate(() => window.loadWolfhouseLocationBookingSettings());

  assert.strictEqual(await page.locator('#wh-location-settings-card').count(), 1);
  assert.strictEqual(await page.locator('#wh-booking-settings-card').count(), 1);
  assert.strictEqual(await page.locator('#wh-location-map-url').inputValue(), 'https://maps.google.com/test-map');
  assert.strictEqual(await page.locator('#wh-location-address').inputValue(), 'TEST address');
  assert.strictEqual(await page.locator('#wh-unpaid-hold-minutes').inputValue(), '80');
  assert.strictEqual(await page.locator('#wh-require-each-deposit').isChecked(), true);
  assert.strictEqual(await page.locator('#wh-unpaid-hold-minutes').isEnabled(), true);
  assert.strictEqual(await page.locator('#wh-require-each-deposit').isEnabled(), true);
  const heading = await page.locator('#wh-booking-settings-card .portal-admin-section-hdr-title').evaluate((el) => ({
    text: el.textContent,
    weight: getComputedStyle(el).fontWeight,
    transform: getComputedStyle(el).textTransform,
    family: getComputedStyle(el).fontFamily,
  }));
  assert.strictEqual(heading.text, 'Booking Settings');
  assert.ok(Number(heading.weight) >= 700);
  assert.strictEqual(heading.transform, 'none');
  assert.match(heading.family, /Instrument Sans/);

  await page.locator('#wh-location-address').fill('Updated address');
  await page.locator('#wh-location-map-url').fill('https://maps.google.com/updated');
  await page.locator('#wh-location-save').click();
  await page.locator('#wh-unpaid-hold-minutes').fill('45');
  await page.locator('#wh-require-each-deposit').uncheck();
  await page.locator('#wh-booking-save').click();
  await page.waitForFunction(() => window.__requests.length === 3);
  requests.push(...await page.evaluate(() => window.__requests));
  assert.deepStrictEqual(JSON.parse(requests[1].body), {
    address_text: 'Updated address', google_maps_url: 'https://maps.google.com/updated',
  });
  assert.strictEqual(requests[1].url, '/staff/admin/location');
  assert.deepStrictEqual(JSON.parse(requests[2].body), {
    unpaid_hold_minutes: 45, require_each_guest_deposit: false,
  });
  assert.strictEqual(requests[2].url, '/staff/admin/booking-settings');

  await page.evaluate(() => applyWolfhouseBookingSettingsLock({
    hold: document.getElementById('wh-unpaid-hold-minutes'),
    each: document.getElementById('wh-require-each-deposit'),
    save: document.getElementById('wh-booking-save'),
    note: document.getElementById('wh-booking-lock-note'),
  }, { locked: true, lock_reason: 'deposit_received' }));
  assert.strictEqual(await page.locator('#wh-unpaid-hold-minutes').isDisabled(), true);
  assert.strictEqual(await page.locator('#wh-require-each-deposit').isDisabled(), true);
  assert.strictEqual(await page.locator('#wh-booking-save').isDisabled(), true);
  assert.match(await page.locator('#wh-booking-lock-note').textContent(), /deposit/i);

  await browser.close();
  console.log('PASS verify-wolfhouse-location-booking-settings-playwright');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

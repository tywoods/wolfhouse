'use strict';

const assert = require('assert');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.setContent(`<!doctype html><html><head><style>
    :root{--font-sans:'Instrument Sans',system-ui,sans-serif}
    body{font-family:var(--font-sans)} .portal-admin-section{padding:16px 18px;border:1px solid #ddd}
  </style></head><body><div id="al-wrap"><section id="cc-house-notes" class="card">Notes</section></div></body></html>`);
  await page.evaluate(() => {
    window.getClient = () => 'wolfhouse-somo';
    window.__requests = [];
    window.__responses = [];
    window.__queueJson = (body, ok = true) => window.__responses.push({ ok, json: async () => body });
    window.fetch = async (url, options = {}) => {
      window.__requests.push({ url, method: options.method || 'GET', body: options.body || null });
      if (!window.__responses.length) throw new Error(`No response queued for ${url}`);
      return window.__responses.shift();
    };
    window.__queueJson({
      location: { address_text: 'TEST address', google_maps_url: 'https://maps.google.com/test-map' },
      booking_settings: { unpaid_hold_minutes: 80, require_each_guest_deposit: true, locked: false, lock_reason: '' },
    });
  });
  await page.addScriptTag({ path: path.join(__dirname, 'browser/wolfhouse-location-booking-settings-ui.js') });
  await page.evaluate(() => window.loadWolfhouseLocationBookingSettings());

  assert.strictEqual(await page.locator('#wh-location-settings-card').count(), 1);
  assert.strictEqual(await page.locator('#wh-booking-settings-card').count(), 1);
  assert.strictEqual(await page.locator('#wh-location-address').count(), 0, 'address is contract context, not a second editable field');
  assert.strictEqual(await page.locator('#wh-location-address-text').textContent(), 'TEST address');
  assert.strictEqual(await page.locator('#wh-location-map-url').inputValue(), 'https://maps.google.com/test-map');
  assert.strictEqual(await page.locator('#wh-map-open').getAttribute('href'), 'https://maps.google.com/test-map');
  assert.strictEqual(await page.locator('#wh-map-open').getAttribute('rel'), 'noopener noreferrer');
  assert.strictEqual(await page.locator('#wh-unpaid-hold-minutes').inputValue(), '80');
  assert.strictEqual(await page.locator('#wh-require-each-deposit').isChecked(), true);
  assert.match(await page.locator('#wh-deposit-rule-help').textContent(), /every guest/i);

  // Invalid URLs never submit; clearing is valid and remains blank after authoritative readback.
  const initialCount = await page.evaluate(() => window.__requests.length);
  await page.locator('#wh-location-map-url').fill('https://');
  await page.locator('#wh-location-save').click();
  assert.strictEqual(await page.evaluate(() => window.__requests.length), initialCount);
  assert.match(await page.locator('#wh-location-status').textContent(), /valid https/i);
  await page.locator('#wh-location-map-url').fill('https://user:pass@maps.google.com/private');
  await page.locator('#wh-location-save').click();
  assert.strictEqual(await page.evaluate(() => window.__requests.length), initialCount);
  assert.match(await page.locator('#wh-location-status').textContent(), /valid https/i);
  await page.locator('#wh-location-map-url').fill('');
  await page.evaluate(() => {
    window.__queueJson({ success: true });
    window.__queueJson({
      location: { address_text: 'TEST address', google_maps_url: '' },
      booking_settings: { unpaid_hold_minutes: 80, require_each_guest_deposit: true, locked: false, lock_reason: '' },
    });
  });
  await page.locator('#wh-location-save').click();
  await page.waitForFunction(() => document.getElementById('wh-location-status').textContent === 'Saved.');
  const locationRequests = await page.evaluate(() => window.__requests.slice(-2));
  assert.strictEqual(locationRequests[0].url, '/staff/admin/location');
  assert.deepStrictEqual(JSON.parse(locationRequests[0].body), { address_text: 'TEST address', google_maps_url: '' });
  assert.strictEqual(locationRequests[1].url, '/staff/admin/location-booking-settings');
  assert.strictEqual(await page.locator('#wh-location-map-url').inputValue(), '');
  assert.strictEqual(await page.locator('#wh-map-open').isHidden(), true);

  // Save status and controls reflect the authoritative GET, not optimistic values or PUT JSON.
  await page.locator('#wh-unpaid-hold-minutes').fill('45');
  await page.locator('#wh-require-each-deposit').uncheck();
  assert.match(await page.locator('#wh-deposit-rule-help').textContent(), /one guest deposit/i);
  await page.evaluate(() => {
    window.__responses.push({ ok: true, json: async () => { throw new Error('malformed json'); } });
    window.__queueJson({
      location: { address_text: 'TEST address', google_maps_url: '' },
      booking_settings: { unpaid_hold_minutes: 30, require_each_guest_deposit: true, locked: true, lock_reason: 'deposit_received' },
    });
  });
  await page.locator('#wh-booking-save').click();
  await page.waitForFunction(() => document.getElementById('wh-booking-status').textContent === 'Saved.');
  assert.strictEqual(await page.locator('#wh-unpaid-hold-minutes').inputValue(), '30');
  assert.strictEqual(await page.locator('#wh-require-each-deposit').isChecked(), true);
  assert.strictEqual(await page.locator('#wh-unpaid-hold-minutes').isDisabled(), true);
  assert.strictEqual(await page.locator('#wh-require-each-deposit').isDisabled(), true);
  assert.match(await page.locator('#wh-booking-lock-note').textContent(), /deposit/i);

  // A reopen keeps known locked state and all saving disabled while its read is unresolved.
  await page.evaluate(() => {
    window.__pendingRead = {};
    window.__responses.push(new Promise((resolve, reject) => {
      window.__pendingRead.resolve = resolve;
      window.__pendingRead.reject = reject;
    }));
    window.__reloadPromise = window.loadWolfhouseLocationBookingSettings();
  });
  assert.strictEqual(await page.locator('#wh-location-map-url').isDisabled(), true);
  assert.strictEqual(await page.locator('#wh-location-save').isDisabled(), true);
  assert.strictEqual(await page.locator('#wh-unpaid-hold-minutes').isDisabled(), true);
  assert.strictEqual(await page.locator('#wh-booking-save').isDisabled(), true);
  await page.evaluate(() => window.__pendingRead.reject(new Error('GET failed')));
  await page.evaluate(() => window.__reloadPromise);
  assert.strictEqual(await page.locator('#wh-location-map-url').isDisabled(), true);
  assert.strictEqual(await page.locator('#wh-booking-save').isDisabled(), true);
  assert.match(await page.locator('#wh-booking-status').textContent(), /could not load/i);

  // Older reads cannot paint or re-enable while a newer read is unresolved.
  await page.evaluate(() => {
    window.__raceReads = [];
    window.__responses.push(new Promise((resolve) => window.__raceReads.push(resolve)));
    window.__olderLoad = window.loadWolfhouseLocationBookingSettings();
    window.__responses.push(new Promise((resolve) => window.__raceReads.push(resolve)));
    window.__newerLoad = window.loadWolfhouseLocationBookingSettings();
  });
  await page.evaluate(() => window.__raceReads[0]({ ok: true, json: async () => ({
    location: { address_text: 'STALE address', google_maps_url: 'https://maps.google.com/stale' },
    booking_settings: { unpaid_hold_minutes: 70, require_each_guest_deposit: false, locked: false, lock_reason: '' },
  }) }));
  await page.evaluate(() => window.__olderLoad);
  assert.strictEqual(await page.locator('#wh-unpaid-hold-minutes').inputValue(), '30');
  assert.strictEqual(await page.locator('#wh-unpaid-hold-minutes').isDisabled(), true);
  assert.strictEqual(await page.locator('#wh-booking-save').isDisabled(), true);
  await page.evaluate(() => window.__raceReads[1]({ ok: true, json: async () => ({
    location: { address_text: 'CURRENT address', google_maps_url: '' },
    booking_settings: { unpaid_hold_minutes: 25, require_each_guest_deposit: false, locked: false, lock_reason: '' },
  }) }));
  await page.evaluate(() => window.__newerLoad);
  assert.strictEqual(await page.locator('#wh-location-address-text').textContent(), 'CURRENT address');
  assert.strictEqual(await page.locator('#wh-unpaid-hold-minutes').inputValue(), '25');
  assert.strictEqual(await page.locator('#wh-unpaid-hold-minutes').isEnabled(), true);
  assert.strictEqual(await page.locator('#wh-booking-save').isEnabled(), true);

  // Saving one card preserves the other card's dirty draft.
  await page.locator('#wh-unpaid-hold-minutes').fill('44');
  await page.locator('#wh-location-map-url').fill('https://maps.google.com/new-location');
  await page.evaluate(() => {
    window.__queueJson({ success: true });
    window.__queueJson({
      location: { address_text: 'CURRENT address', google_maps_url: 'https://maps.google.com/new-location' },
      booking_settings: { unpaid_hold_minutes: 99, require_each_guest_deposit: true, locked: false, lock_reason: '' },
    });
  });
  await page.locator('#wh-location-save').click();
  await page.waitForFunction(() => document.getElementById('wh-location-status').textContent === 'Saved.');
  assert.strictEqual(await page.locator('#wh-unpaid-hold-minutes').inputValue(), '44');

  await page.locator('#wh-location-map-url').fill('https://maps.google.com/unsaved-location-draft');
  await page.evaluate(() => {
    window.__queueJson({ success: true });
    window.__queueJson({
      location: { address_text: 'CURRENT address', google_maps_url: 'https://maps.google.com/server-location' },
      booking_settings: { unpaid_hold_minutes: 44, require_each_guest_deposit: false, locked: false, lock_reason: '' },
    });
  });
  await page.locator('#wh-booking-save').click();
  await page.waitForFunction(() => document.getElementById('wh-booking-status').textContent === 'Saved.');
  assert.strictEqual(await page.locator('#wh-location-map-url').inputValue(), 'https://maps.google.com/unsaved-location-draft');

  // Reopening keeps a pending PUT single-flight; settlement reconciles without replacing a newer draft.
  await page.locator('#wh-location-map-url').fill('https://maps.google.com/old-save');
  await page.evaluate(() => {
    window.__pendingPut = {};
    window.__responses.push(new Promise((resolve, reject) => {
      window.__pendingPut.resolve = resolve;
      window.__pendingPut.reject = reject;
    }));
  });
  await page.locator('#wh-location-save').click();
  await page.evaluate(() => {
    window.__queueJson({
      location: { address_text: 'CURRENT address', google_maps_url: 'https://maps.google.com/reopened' },
      booking_settings: { unpaid_hold_minutes: 44, require_each_guest_deposit: false, locked: false, lock_reason: '' },
    });
    window.__reopenAfterPut = window.loadWolfhouseLocationBookingSettings();
  });
  await page.evaluate(() => window.__reopenAfterPut);
  await page.locator('#wh-location-map-url').fill('https://maps.google.com/newer-draft');
  assert.strictEqual(await page.locator('#wh-location-save').isDisabled(), true);
  assert.strictEqual(await page.locator('#wh-booking-save').isDisabled(), true);
  const requestsBeforeObsoletePut = await page.evaluate(() => window.__requests.length);
  await page.evaluate(() => {
    window.__staleReconcile = {};
    window.__responses.push(new Promise((resolve, reject) => {
      window.__staleReconcile.resolve = resolve;
      window.__staleReconcile.reject = reject;
    }));
  });
  await page.evaluate(() => window.__pendingPut.resolve({ ok: true, json: async () => ({ success: true }) }));
  await page.waitForFunction((count) => window.__requests.length === count + 1, requestsBeforeObsoletePut);
  await page.evaluate(() => {
    window.__queueJson({
      location: { address_text: 'CURRENT address', google_maps_url: 'https://maps.google.com/old-save' },
      booking_settings: { unpaid_hold_minutes: 44, require_each_guest_deposit: false, locked: false, lock_reason: '' },
    });
    window.__loaderDuringReconcile = window.loadWolfhouseLocationBookingSettings();
  });
  await page.evaluate(() => window.__loaderDuringReconcile);
  assert.strictEqual(await page.locator('#wh-location-save').isDisabled(), true);
  assert.strictEqual(await page.locator('#wh-booking-save').isDisabled(), true);
  await page.evaluate(() => window.__staleReconcile.resolve({ ok: true, json: async () => ({
    location: { address_text: 'STALE address', google_maps_url: 'https://maps.google.com/stale' },
    booking_settings: { unpaid_hold_minutes: 88, require_each_guest_deposit: true, locked: false, lock_reason: '' },
  }) }));
  await page.waitForFunction(() => !document.getElementById('wh-location-save').disabled);
  assert.strictEqual(await page.evaluate(() => window.__requests.length), requestsBeforeObsoletePut + 2);
  assert.strictEqual(await page.locator('#wh-location-map-url').inputValue(), 'https://maps.google.com/newer-draft');
  assert.strictEqual(await page.locator('#wh-location-map-url').isEnabled(), true);
  assert.doesNotMatch(await page.locator('#wh-location-status').textContent(), /saved|could not/i);

  await page.locator('#wh-location-map-url').fill('https://maps.google.com/old-failing-save');
  await page.evaluate(() => {
    window.__pendingFailedPut = {};
    window.__responses.push(new Promise((resolve, reject) => {
      window.__pendingFailedPut.resolve = resolve;
      window.__pendingFailedPut.reject = reject;
    }));
  });
  await page.locator('#wh-location-save').click();
  await page.evaluate(() => {
    window.__queueJson({
      location: { address_text: 'CURRENT address', google_maps_url: 'https://maps.google.com/reopened-again' },
      booking_settings: { unpaid_hold_minutes: 44, require_each_guest_deposit: false, locked: false, lock_reason: '' },
    });
    window.__reopenAfterFailedPut = window.loadWolfhouseLocationBookingSettings();
  });
  await page.evaluate(() => window.__reopenAfterFailedPut);
  await page.locator('#wh-location-map-url').fill('https://maps.google.com/newest-draft');
  assert.strictEqual(await page.locator('#wh-location-save').isDisabled(), true);
  assert.strictEqual(await page.locator('#wh-booking-save').isDisabled(), true);
  await page.evaluate(() => window.__queueJson({
    location: { address_text: 'CURRENT address', google_maps_url: 'https://maps.google.com/reopened-again' },
    booking_settings: { unpaid_hold_minutes: 44, require_each_guest_deposit: false, locked: false, lock_reason: '' },
  }));
  await page.evaluate(() => window.__pendingFailedPut.reject(new Error('obsolete PUT failed')));
  await page.waitForFunction(() => !document.getElementById('wh-location-save').disabled);
  assert.strictEqual(await page.locator('#wh-location-map-url').inputValue(), 'https://maps.google.com/newest-draft');
  assert.strictEqual(await page.locator('#wh-location-map-url').isEnabled(), true);
  assert.doesNotMatch(await page.locator('#wh-location-status').textContent(), /saved|could not/i);

  // Booking writes use the same global single-flight guard across reopen.
  await page.locator('#wh-unpaid-hold-minutes').fill('45');
  await page.evaluate(() => {
    window.__pendingBookingPut = {};
    window.__responses.push(new Promise((resolve, reject) => {
      window.__pendingBookingPut.resolve = resolve;
      window.__pendingBookingPut.reject = reject;
    }));
  });
  await page.locator('#wh-booking-save').click();
  await page.evaluate(() => {
    window.__queueJson({
      location: { address_text: 'CURRENT address', google_maps_url: 'https://maps.google.com/reopened-again' },
      booking_settings: { unpaid_hold_minutes: 44, require_each_guest_deposit: false, locked: false, lock_reason: '' },
    });
    window.__reopenDuringBookingPut = window.loadWolfhouseLocationBookingSettings();
  });
  await page.evaluate(() => window.__reopenDuringBookingPut);
  assert.strictEqual(await page.locator('#wh-location-save').isDisabled(), true);
  assert.strictEqual(await page.locator('#wh-booking-save').isDisabled(), true);
  const requestsBeforeBlockedSaves = await page.evaluate(() => window.__requests.length);
  await page.locator('#wh-location-save').click({ force: true });
  await page.locator('#wh-booking-save').click({ force: true });
  assert.strictEqual(await page.evaluate(() => window.__requests.length), requestsBeforeBlockedSaves);
  await page.evaluate(() => window.__queueJson({
    location: { address_text: 'CURRENT address', google_maps_url: 'https://maps.google.com/reopened-again' },
    booking_settings: { unpaid_hold_minutes: 45, require_each_guest_deposit: false, locked: false, lock_reason: '' },
  }));
  await page.evaluate(() => window.__pendingBookingPut.resolve({ ok: true, json: async () => ({ success: true }) }));
  await page.waitForFunction(() => !document.getElementById('wh-booking-save').disabled);
  assert.strictEqual(await page.locator('#wh-unpaid-hold-minutes').inputValue(), '45');

  // A deposit lock still overrides a dirty booking draft.
  await page.locator('#wh-unpaid-hold-minutes').fill('55');
  await page.evaluate(() => {
    window.__queueJson({
      location: { address_text: 'CURRENT address', google_maps_url: 'https://maps.google.com/reopened' },
      booking_settings: { unpaid_hold_minutes: 44, require_each_guest_deposit: false, locked: true, lock_reason: 'deposit_received' },
    });
    window.__lockedRefresh = window.loadWolfhouseLocationBookingSettings();
  });
  await page.evaluate(() => window.__lockedRefresh);
  assert.strictEqual(await page.locator('#wh-unpaid-hold-minutes').inputValue(), '44');
  assert.strictEqual(await page.locator('#wh-booking-save').isDisabled(), true);

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

  const desktopBoxes = await page.locator('#wh-location-settings-card, #wh-booking-settings-card').evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { left: box.left, width: box.width };
  }));
  assert.strictEqual(desktopBoxes.length, 2);
  assert.ok(Math.abs(desktopBoxes[0].left - desktopBoxes[1].left) < 1);
  assert.ok(Math.abs(desktopBoxes[0].width - desktopBoxes[1].width) < 1);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    mapRight: document.getElementById('wh-location-map-url').getBoundingClientRect().right,
    cardRight: document.getElementById('wh-location-settings-card').getBoundingClientRect().right,
  }));
  assert.ok(mobileLayout.documentWidth <= mobileLayout.viewportWidth);
  assert.ok(mobileLayout.mapRight <= mobileLayout.cardRight);

  await browser.close();
  console.log('PASS verify-wolfhouse-location-booking-settings-playwright');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

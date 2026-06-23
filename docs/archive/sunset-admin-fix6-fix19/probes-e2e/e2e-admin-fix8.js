'use strict';
const { chromium } = require('playwright');
const BASE = 'https://sunset-staging.lunafrontdesk.com';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const out = { errors: [], api: [] };

  page.on('pageerror', (e) => out.errors.push(String(e.message)));
  page.on('response', async (res) => {
    const url = res.url();
    if (/\/staff\/admin\/config/.test(url) && ['PATCH', 'POST', 'PUT'].some((m) => url.includes(m) || res.request().method() === m)) {
      out.api.push({ method: res.request().method(), url: url.slice(0, 120), status: res.status() });
    }
    if (/\/staff\/admin\/config\/(lesson-times|prices|surf-packs)/.test(url) && ['PATCH', 'POST'].includes(res.request().method())) {
      let body = '';
      try { body = await res.text(); } catch (_) {}
      out.api.push({ method: res.request().method(), url: url.slice(0, 140), status: res.status(), body: body.slice(0, 200) });
    }
  });

  await page.goto(`${BASE}/staff/login?client=sunset`);
  await page.fill('#email', 'tywoods@gmail.com');
  await page.fill('#password', 'SunsetStaging2026!');
  await page.click('#btn-signin');
  await page.waitForURL(/\/staff\/ui/);
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.waitForSelector('#admin-lesson-card-grid', { timeout: 60000 });

  const cfgResp = await page.waitForResponse((r) => r.url().includes('/staff/admin/config') && r.request().method() === 'GET');
  const cfg = await cfgResp.json();
  out.writesEnabled = cfg && cfg.writes_enabled;

  // Lesson edit + save
  const editLesson = page.locator('[data-admin-action="edit-time"]').first();
  out.lessonEditCount = await editLesson.count();
  if (out.lessonEditCount) {
    await editLesson.click();
    await page.waitForSelector('[data-admin-action="save-time"]');
    await page.fill('#admin-time-cost', '25.00');
    await page.locator('[data-admin-action="save-time"]').click();
    await page.waitForTimeout(3500);
    out.lessonMsg = (await page.locator('#admin-save-msg').textContent())?.trim();
  }

  // Add rental price
  const addPrice = page.locator('[data-admin-action="add-price"]').first();
  out.addPriceCount = await addPrice.count();
  if (out.addPriceCount) {
    await addPrice.click();
    await page.waitForSelector('[data-admin-action="save-new-price"]');
    await page.selectOption('#admin-new-price-period', '1_hour');
    await page.fill('#admin-new-price-amount', '8.00');
    await page.locator('[data-admin-action="save-new-price"]').click();
    await page.waitForTimeout(3500);
    out.priceMsg = (await page.locator('#admin-save-msg').textContent())?.trim();
  }

  out.packPillButtons = await page.locator('#admin-pack-card-grid .portal-admin-pill-row-readout button').count();

  console.log(JSON.stringify(out, null, 2));
  await browser.close();

  const ok = out.writesEnabled && out.lessonEditCount > 0 && /saved|added/i.test(out.lessonMsg || '')
    && out.addPriceCount > 0 && /added|saved/i.test(out.priceMsg || '')
    && out.packPillButtons === 0;
  process.exit(ok ? 0 : 1);
})();

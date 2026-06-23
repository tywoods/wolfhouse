'use strict';
const { chromium } = require('playwright');
const BASE = 'https://sunset-staging.lunafrontdesk.com';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const out = { errors: [] };
  page.on('pageerror', (e) => out.errors.push(String(e.message)));

  await page.goto(`${BASE}/staff/login?client=sunset`);
  await page.fill('#email', 'tywoods@gmail.com');
  await page.fill('#password', 'SunsetStaging2026!');
  await page.click('#btn-signin');
  await page.waitForURL(/\/staff\/ui/);
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.waitForSelector('#admin-lesson-card-grid');

  // Lesson edit + save with empty cost (was blocking)
  await page.locator('[data-admin-action="edit-time"]').first().click();
  await page.waitForSelector('[data-admin-action="save-time"]');
  await page.fill('#admin-time-cost', '25.00');
  await page.locator('[data-admin-action="save-time"]').click();
  await page.waitForTimeout(2500);
  out.lessonMsg = (await page.locator('#admin-save-msg').textContent())?.trim();

  // Add rental price
  await page.locator('[data-admin-action="add-price"]').first().click();
  await page.waitForSelector('[data-admin-action="save-new-price"]');
  await page.selectOption('#admin-new-price-period', '1_hour');
  await page.fill('#admin-new-price-amount', '8.00');
  await page.locator('[data-admin-action="save-new-price"]').click();
  await page.waitForTimeout(2500);
  out.priceMsg = (await page.locator('#admin-save-msg').textContent())?.trim();

  // Pack view pills not buttons
  out.packPillButtons = await page.locator('#admin-pack-card-grid .portal-admin-pill-row-readout button').count();

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
  const ok = /saved|added/i.test(out.lessonMsg || '') && /added|saved/i.test(out.priceMsg || '') && out.packPillButtons === 0;
  process.exit(ok ? 0 : 1);
})();

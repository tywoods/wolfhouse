'use strict';
const { chromium } = require('playwright');
const BASE = 'https://sunset-staging.lunafrontdesk.com';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const r = { errors: [] };
  page.on('pageerror', (e) => r.errors.push(e.message));

  await page.goto(`${BASE}/staff/login?client=sunset`);
  await page.fill('#email', 'tywoods@gmail.com');
  await page.fill('#password', 'SunsetStaging2026!');
  await page.click('#btn-signin');
  await page.waitForURL(/\/staff\/ui/);
  await page.locator('button.tab-btn[data-tab="admin"]').click({ force: true });
  await page.waitForSelector('#admin-times-body', { timeout: 20000 });

  await page.locator('[data-admin-action="add-pack"]').click();
  await page.waitForSelector('[data-admin-action="save-new-pack"]', { timeout: 8000 });
  r.packForm = true;

  await page.locator('[data-admin-action="add-time"]').click();
  await page.waitForSelector('#admin-add-time-form', { timeout: 8000 });
  await page.fill('#admin-new-time-label', 'Deploy verify lesson');
  await page.fill('#admin-new-time-start', '10:30');
  await page.fill('#admin-new-time-cost', '45.00');
  await page.locator('[data-admin-action="save-new-time"]').click();
  await page.waitForTimeout(2500);
  r.lessonMsg = (await page.locator('#admin-save-msg').textContent().catch(() => ''))?.trim();

  await browser.close();
  console.log(JSON.stringify(r, null, 2));
  process.exit(/added|guardado|saved/i.test(r.lessonMsg || '') && r.packForm && !r.errors.length ? 0 : 1);
})();

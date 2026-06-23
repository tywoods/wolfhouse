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

  // elSardi school (user screenshot)
  await page.locator('.staff-school-btn[data-school="sunset-sardinero"]').click();
  await page.waitForResponse((r) => r.url().includes('/staff/admin/config') && r.url().includes('sardinero') && r.request().method() === 'GET');

  await page.waitForSelector('[data-admin-action="edit-time"]', { timeout: 60000 });
  await page.locator('[data-admin-action="edit-time"]').first().click();
  await page.waitForSelector('[data-admin-action="save-time"]');
  await page.fill('#admin-time-cost', '30.00');
  await page.locator('[data-admin-action="save-time"]').click();
  await page.waitForTimeout(4000);
  out.lessonMsg = (await page.locator('#admin-save-msg').textContent())?.trim();
  out.lessonTitle = (await page.locator('.portal-admin-lesson-title').first().textContent())?.trim();

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
  process.exit(/saved|added/i.test(out.lessonMsg || '') ? 0 : 1);
})();

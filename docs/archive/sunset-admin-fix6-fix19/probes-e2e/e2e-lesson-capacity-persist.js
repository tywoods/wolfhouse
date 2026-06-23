'use strict';
const { chromium } = require('playwright');
const BASE = 'https://sunset-staging.lunafrontdesk.com';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${BASE}/staff/login?client=sunset`);
  await page.fill('#email', 'tywoods@gmail.com');
  await page.fill('#password', 'SunsetStaging2026!');
  await page.click('#btn-signin');
  await page.waitForURL(/\/staff\/ui/);
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.locator('.staff-school-btn[data-school="sunset-sardinero"]').click();
  await page.waitForSelector('[data-admin-action="edit-time"]', { timeout: 60000 });

  await page.locator('[data-admin-action="edit-time"]').first().click();
  await page.fill('#admin-time-capacity', '20');
  await page.locator('[data-admin-action="save-time"]').click();
  await page.waitForTimeout(3000);
  const msg1 = (await page.locator('#admin-save-msg').textContent())?.trim();

  const cfg = await page.evaluate(async () => {
    const r = await fetch('/staff/admin/config?client=sunset&location=sunset-sardinero', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    return r.json();
  });
  const lesson = (cfg.lesson_times || [])[0];

  console.log(JSON.stringify({ msg1, capacity: lesson && lesson.capacity, slot: lesson && lesson.slot_id }, null, 2));
  await browser.close();
  process.exit(/saved|guardado/i.test(msg1 || '') ? 0 : 1);
})();

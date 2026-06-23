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
  await page.waitForSelector('#admin-times-body');
  await page.waitForTimeout(2000);

  await page.locator('[data-admin-action="add-time"]').click();
  await page.waitForSelector('#admin-add-time-form');

  const fields = await page.evaluate(() => {
    const ids = ['admin-new-time-label', 'admin-new-time-start', 'admin-new-time-end', 'admin-new-time-cost', 'admin-new-time-capacity'];
    return Object.fromEntries(ids.map((id) => [id, document.getElementById(id)?.value ?? 'MISSING']));
  });
  console.log('before fill', fields);

  await page.fill('#admin-new-time-label', 'E2E New Lesson');
  await page.fill('#admin-new-time-start', '11:00');
  const costEl = page.locator('#admin-new-time-cost');
  if (await costEl.count()) await costEl.fill('45.00');

  const after = await page.evaluate(() => {
    const ids = ['admin-new-time-label', 'admin-new-time-start', 'admin-new-time-end', 'admin-new-time-cost'];
    return Object.fromEntries(ids.map((id) => [id, document.getElementById(id)?.value ?? 'MISSING']));
  });
  console.log('after fill', after);

  await page.locator('[data-admin-action="save-new-time"]').click();
  await page.waitForTimeout(2000);
  const msg = await page.locator('#admin-save-msg').textContent().catch(() => '');
  console.log('msg', msg?.trim());

  // edit lesson
  await page.locator('[data-admin-action="edit-time"]').first().click();
  await page.waitForSelector('#admin-time-label');
  const startVal = await page.inputValue('#admin-time-start');
  console.log('edit start value', startVal);
  await page.fill('#admin-time-label', 'Edited lesson test');
  await page.locator('[data-admin-action="save-time"]').click();
  await page.waitForTimeout(2000);
  console.log('edit msg', (await page.locator('#admin-save-msg').textContent())?.trim());

  await browser.close();
})();

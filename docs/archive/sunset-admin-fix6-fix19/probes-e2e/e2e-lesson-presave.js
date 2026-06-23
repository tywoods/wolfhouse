'use strict';
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://sunset-staging.lunafrontdesk.com/staff/login?client=sunset');
  await page.fill('#email', 'tywoods@gmail.com');
  await page.fill('#password', 'SunsetStaging2026!');
  await page.click('#btn-signin');
  await page.waitForURL(/\/staff\/ui/);
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.waitForTimeout(3000);
  await page.locator('[data-admin-action="add-time"]').click();
  await page.waitForSelector('#admin-add-time-form');
  await page.fill('#admin-new-time-label', 'E2E New Lesson');
  await page.fill('#admin-new-time-start', '11:00');
  await page.fill('#admin-new-time-cost', '45.00');

  const preSave = await page.evaluate(() => {
    function parseTimeHm(text) {
      var t = String(text || '').trim();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return { ok: false, error: 'timeInvalid', t: t };
      return { ok: true, value: t };
    }
    const label = document.getElementById('admin-new-time-label');
    const start = document.getElementById('admin-new-time-start');
    const end = document.getElementById('admin-new-time-end');
    const cap = document.getElementById('admin-new-time-capacity');
    const cost = document.getElementById('admin-new-time-cost');
    return {
      label: label?.value,
      start: start?.value,
      startParse: parseTimeHm(start?.value),
      end: end?.value,
      endParse: parseTimeHm(end?.value),
      cap: cap?.value,
      cost: cost?.value,
      saveBtnAction: document.querySelector('[data-admin-action="save-new-time"]')?.getAttribute('data-admin-action'),
    };
  });
  console.log('preSave', JSON.stringify(preSave, null, 2));

  await page.locator('[data-admin-action="save-new-time"]').click();
  await page.waitForTimeout(500);
  const msg = await page.locator('#admin-save-msg').textContent().catch(() => '');
  console.log('msg', msg?.trim());
  await browser.close();
})();

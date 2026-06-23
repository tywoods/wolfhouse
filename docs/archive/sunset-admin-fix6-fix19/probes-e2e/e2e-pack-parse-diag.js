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
  await page.waitForSelector('[data-admin-action="add-pack"]');
  await page.locator('[data-admin-action="add-pack"]').click();
  await page.waitForSelector('#admin-new-pack-schedule-start');

  const diag = await page.evaluate(() => {
    function parseHm(text) {
      var t = String(text || '').trim();
      var re = new RegExp('^([01]\\d|2[0-3]):[0-5]\\d$');
      return { t, ok: re.test(t), reSrc: re.source };
    }
    const prefix = 'admin-new-pack';
    const startInput = document.getElementById(prefix + '-schedule-start');
    const endInput = document.getElementById(prefix + '-schedule-end');
    const startArg = startInput && startInput.value;
    const endArg = endInput && endInput.value;
    return {
      startExists: !!startInput,
      endExists: !!endInput,
      startArg, endArg,
      startParsed: parseHm(startArg),
      endParsed: parseHm(endArg),
      startParsedDirect: parseHm(startInput ? startInput.value : ''),
    };
  });
  console.log(JSON.stringify(diag, null, 2));
  await browser.close();
})();

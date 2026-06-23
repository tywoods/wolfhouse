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
  await page.waitForSelector('#admin-times-body');
  await page.waitForTimeout(2000);
  await page.locator('[data-admin-action="add-time"]').click();
  await page.waitForSelector('#admin-add-time-form');
  await page.fill('#admin-new-time-start', '11:00');

  const diag = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('#admin-new-time-start, [id="admin-new-time-start"]'));
    const elFn = typeof el === 'function' ? el : (id) => document.getElementById(id);
    const viaEl = elFn('admin-new-time-start');
    const parse = typeof adminParseTimeHm === 'function' ? adminParseTimeHm(viaEl && viaEl.value) : null;
    return {
      duplicateCount: inputs.length,
      values: inputs.map((n) => n.value),
      viaElValue: viaEl && viaEl.value,
      parseResult: parse,
      parseDirect: typeof adminParseTimeHm === 'function' ? adminParseTimeHm('11:00') : null,
    };
  });
  console.log(JSON.stringify(diag, null, 2));
  await browser.close();
})();

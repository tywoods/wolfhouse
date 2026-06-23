'use strict';
const { chromium } = require('playwright');

(async () => {
  const pw = process.env.SUNSET_STAGING_PORTAL_PASSWORD || 'SunsetStaging2026!';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`PAGE: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`CON: ${m.text()}`);
  });

  await page.goto('https://sunset-staging.lunafrontdesk.com/staff/login', { waitUntil: 'networkidle' });
  await page.fill('#email', 'tywoods@gmail.com');
  await page.fill('#password', pw);
  await page.click('button[type=submit]');
  await page.waitForURL('**/staff/ui**', { timeout: 30000 });

  await page.click('.tab-btn[data-tab="admin"]');
  await page.waitForTimeout(10000);

  const result = await page.evaluate(() => {
    const ids = ['admin-business-body', 'admin-times-body', 'admin-prices-body', 'admin-history-body'];
    const sections = Object.fromEntries(ids.map((id) => {
      const el = document.getElementById(id);
      return [id, {
        len: el ? el.innerHTML.trim().length : -1,
        text: el ? el.textContent.trim().slice(0, 200) : 'MISSING',
      }];
    }));
    const hasRenderAdminSchoolContext = typeof renderAdminSchoolContext === 'function';
    let renderThrows = null;
    try {
      if (typeof renderAdminFromConfig === 'function' && typeof adminConfigCache !== 'undefined' && adminConfigCache) {
        renderAdminFromConfig(adminConfigCache);
      }
    } catch (e) {
      renderThrows = e.message;
    }
    return { sections, hasRenderAdminSchoolContext, renderThrows, cacheLoaded: !!(typeof adminConfigCache !== 'undefined' && adminConfigCache && adminConfigCache.success) };
  });

  console.log(JSON.stringify({ result, errors: errors.slice(0, 20) }, null, 2));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

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
  const cfgResp = await page.waitForResponse((r) => r.url().includes('sardinero') && r.url().includes('/staff/admin/config'));
  const cfg = await cfgResp.json();
  await page.waitForTimeout(2000);
  const out = {
    writes: cfg.writes_enabled,
    lessons: (cfg.lesson_times || []).length,
    packs: (cfg.surf_packs || []).length,
    editButtons: await page.locator('[data-admin-action="edit-time"]').count(),
    cardIds: await page.locator('[data-admin-lesson-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-admin-lesson-card'))),
    firstTitle: await page.locator('.portal-admin-lesson-title').first().textContent().catch(() => null),
  };
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})();

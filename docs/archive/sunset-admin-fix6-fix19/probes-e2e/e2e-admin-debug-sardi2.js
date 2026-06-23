'use strict';
const { chromium } = require('playwright');
const BASE = 'https://sunset-staging.lunafrontdesk.com';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleLogs = [];
  page.on('console', (msg) => consoleLogs.push(msg.text()));
  page.on('pageerror', (e) => consoleLogs.push('PAGEERROR: ' + e.message));

  await page.goto(`${BASE}/staff/login?client=sunset`);
  await page.fill('#email', 'tywoods@gmail.com');
  await page.fill('#password', 'SunsetStaging2026!');
  await page.click('#btn-signin');
  await page.waitForURL(/\/staff\/ui/);
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.waitForTimeout(3000);
  await page.locator('.staff-school-btn[data-school="sunset-sardinero"]').click();
  await page.waitForTimeout(10000);

  const cfg = await page.evaluate(async () => {
    const r = await fetch('/staff/admin/config?client=sunset&location=sunset-sardinero', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    return r.json();
  });

  const out = {
    writes: cfg.writes_enabled,
    lesson: cfg.lesson_times && cfg.lesson_times[0],
    editButtons: await page.locator('[data-admin-action="edit-time"]').count(),
    cardIds: await page.locator('[data-admin-lesson-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-admin-lesson-card'))),
    fetchState: await page.locator('#admin-fetch-state').textContent().catch(() => ''),
    consoleLogs: consoleLogs.filter((l) => /admin|error|failed/i.test(l)).slice(-10),
  };
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})();

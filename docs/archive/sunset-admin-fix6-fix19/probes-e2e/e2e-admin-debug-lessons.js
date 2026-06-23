'use strict';
const { chromium } = require('playwright');
const BASE = 'https://sunset-staging.lunafrontdesk.com';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const out = {};

  await page.goto(`${BASE}/staff/login?client=sunset`);
  await page.fill('#email', 'tywoods@gmail.com');
  await page.fill('#password', 'SunsetStaging2026!');
  await page.click('#btn-signin');
  await page.waitForURL(/\/staff\/ui/);
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.waitForSelector('#admin-times-body', { timeout: 60000 });

  const cfgResp = await page.waitForResponse((r) => r.url().includes('/staff/admin/config') && r.request().method() === 'GET');
  const cfg = await cfgResp.json();
  out.location = new URL(cfgResp.url()).searchParams.get('location');
  out.lessonTimes = (cfg.lesson_times || []).length;
  out.slots = (cfg.lesson_times || []).map((s) => ({
    id: s.id || s.slot_id,
    label: s.offering_label,
    kind: s.kind,
  }));
  out.editTimeButtons = await page.locator('[data-admin-action="edit-time"]').count();
  out.htmlSnippet = await page.locator('#admin-lesson-card-grid').innerHTML().catch(() => 'missing');

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})();
